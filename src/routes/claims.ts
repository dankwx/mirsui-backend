import type { FastifyInstance } from 'fastify'
import { supabaseForUser } from '../lib/supabase'
import { requireAuth } from '../plugins/auth'
import { filtroDaGravacao, isrcValido, discoverRating } from '../lib/gravacao'

export default async function claimRoutes(app: FastifyInstance) {
  // Reivindicar uma música
  app.post<{
    Body: {
      trackUri: string
      isrc?: string | null
      trackName: string
      artistName: string
      albumName: string
      spotifyUrl: string
      trackThumbnail: string
      popularity: number
      duration_ms?: number
      claimMessage?: string
    }
  }>('/tracks/claim', { preHandler: requireAuth }, async (request, reply) => {
    const {
      trackUri,
      trackName,
      artistName,
      albumName,
      spotifyUrl,
      trackThumbnail,
      popularity,
      claimMessage
    } = request.body ?? {}

    if (!trackUri || !trackName || !artistName) {
      return reply.code(400).send({ error: 'Dados da música são obrigatórios' })
    }

    const isrc = isrcValido(request.body?.isrc)
    const filtro = filtroDaGravacao(trackUri, isrc)

    const userId = request.user.id
    const supabase = supabaseForUser(request.accessToken)

    // Verificar se o usuário já reivindicou esta GRAVAÇÃO
    const { data: existingClaim, error: existingError } = await supabase
      .from('tracks')
      .select('id, position, youtube_url')
      .eq('user_id', userId)
      .or(filtro)
      .limit(1)
      .maybeSingle()

    if (existingError) {
      app.log.error({ err: existingError }, 'Erro ao verificar claim existente')
      return reply.code(500).send({ error: 'Erro ao verificar reivindicação' })
    }

    if (existingClaim) {
      return reply.code(409).send({
        error: 'Você já reivindicou esta música',
        position: existingClaim.position,
        youtubeUrl: existingClaim.youtube_url
      })
    }

    // Posição = quantidade de claims já existentes + 1, por gravação
    const { count: trackCount, error: countError } = await supabase
      .from('tracks')
      .select('*', { count: 'exact', head: true })
      .or(filtro)

    if (countError) {
      app.log.error({ err: countError }, 'Erro ao contar claims')
      return reply.code(500).send({ error: 'Erro ao processar reivindicação' })
    }

    const nextPosition = (trackCount ?? 0) + 1
    const safePopularity = Number(popularity) || 0
    const rating = discoverRating(safePopularity, nextPosition)

    const insertData: Record<string, unknown> = {
      track_url: spotifyUrl,
      track_uri: trackUri,
      isrc,
      track_title: trackName,
      artist_name: artistName,
      album_name: albumName,
      popularity: safePopularity,
      discover_rating: rating,
      track_thumbnail: trackThumbnail,
      user_id: userId,
      position: nextPosition,
      claimedat: new Date().toISOString()
    }

    if (claimMessage && claimMessage.trim()) {
      insertData.claim_message = claimMessage.trim()
    }

    const { data: insertedTrack, error: insertError } = await supabase
      .from('tracks')
      .insert([insertData])
      .select('id, position, youtube_url')
      .single()

    if (insertError) {
      app.log.error({ err: insertError, userId }, 'Erro ao inserir claim')
      return reply.code(500).send({ error: 'Erro ao salvar reivindicação' })
    }

    app.log.info({ userId, trackUri, position: nextPosition }, 'Música reivindicada com sucesso')

    return reply.code(201).send({
      success: true,
      message: 'Música reivindicada com sucesso!',
      position: nextPosition,
      youtubeUrl: insertedTrack?.youtube_url || null,
      data: insertedTrack
    })
  })

  // Verificar status de claim de uma música
  app.get<{
    Querystring: { trackUri: string; isrc?: string }
  }>('/tracks/claim/status', { preHandler: requireAuth }, async (request, reply) => {
    const { trackUri } = request.query

    if (!trackUri) {
      return reply.code(400).send({ error: 'trackUri é obrigatório' })
    }

    const isrc = isrcValido(request.query.isrc)

    const supabase = supabaseForUser(request.accessToken)
    const { data: claim, error } = await supabase
      .from('tracks')
      .select('position, youtube_url')
      .eq('user_id', request.user.id)
      .or(filtroDaGravacao(trackUri, isrc))
      .limit(1)
      .maybeSingle()

    if (error) {
      app.log.error({ err: error }, 'Erro ao verificar claim')
      return reply.code(500).send({ error: 'Erro ao verificar claim' })
    }

    return reply.send({
      claimed: !!claim,
      position: claim?.position || null,
      youtubeUrl: claim?.youtube_url || null
    })
  })
}
