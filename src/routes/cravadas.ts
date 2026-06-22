import type { FastifyInstance } from 'fastify'
import { supabaseForUser } from '../lib/supabase'
import { requireAuth } from '../plugins/auth'
import { resolveTrack } from '../lib/deezer'
import { computeMultiplier, popScore, fameScore } from '../lib/cravadaPoints'

const MAX_SLOTS = 3
const MIN_DAYS_TO_COLLECT = 7

function daysHeld(cravedAt: string): number {
  const ms = Date.now() - new Date(cravedAt).getTime()
  return Math.floor(ms / (1000 * 60 * 60 * 24))
}

export default async function cravadaRoutes(app: FastifyInstance) {
  // ---- Prévia do multiplicador (antes de cravar) ----
  app.get<{ Querystring: { isrc?: string; artist?: string; title?: string } }>(
    '/cravadas/preview',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { isrc, artist, title } = request.query
      if (!artist || !title) {
        return reply.code(400).send({ error: 'artist e title são obrigatórios' })
      }

      const resolved = await resolveTrack({ isrc: isrc ?? null, artist, title })
      if (!resolved) {
        return reply.send({ matched: false })
      }

      const popularity = popScore(resolved.rank)
      const fame = fameScore(resolved.nbFan)
      return reply.send({
        matched: true,
        popularity,
        fame,
        multiplier: computeMultiplier(fame, popularity),
      })
    }
  )

  // ---- Listar as cravadas do usuário ----
  app.get('/cravadas', { preHandler: requireAuth }, async (request, reply) => {
    const supabase = supabaseForUser(request.accessToken)

    const { data: cravadas, error } = await supabase
      .from('cravadas')
      .select('*')
      .eq('user_id', request.user.id)
      .neq('status', 'coletada')
      .order('craved_at', { ascending: true })

    if (error) {
      app.log.error({ err: error }, 'Erro ao listar cravadas')
      return reply.code(500).send({ error: 'Erro ao listar cravadas' })
    }

    const list = cravadas ?? []

    // Contagem social ("X pessoas cravaram") via função SECURITY DEFINER
    const uris = Array.from(new Set(list.map((c) => c.track_uri)))
    const countByUri = new Map<string, number>()
    if (uris.length > 0) {
      const { data: counts } = await supabase.rpc('count_cravadas_by_track_uri', {
        p_uris: uris,
      })
      for (const row of counts ?? []) {
        countByUri.set(row.track_uri, Number(row.total))
      }
    }

    const result = list.map((c) => {
      const held = daysHeld(c.craved_at)
      return {
        ...c,
        days_held: held,
        days_to_collect: Math.max(0, MIN_DAYS_TO_COLLECT - held),
        can_collect: c.status === 'ativa' && held >= MIN_DAYS_TO_COLLECT,
        pessoas_cravaram: countByUri.get(c.track_uri) ?? 1,
      }
    })

    return reply.send({ cravadas: result, maxSlots: MAX_SLOTS })
  })

  // ---- Cravar uma faixa ----
  app.post<{
    Body: {
      trackId: string // id do Spotify (referência/UI)
      trackUri: string
      trackTitle: string
      artistName: string
      albumName?: string
      trackThumbnail?: string
      isrc?: string
    }
  }>('/cravadas', { preHandler: requireAuth }, async (request, reply) => {
    const {
      trackId,
      trackUri,
      trackTitle,
      artistName,
      albumName,
      trackThumbnail,
      isrc,
    } = request.body ?? {}

    if (!trackId || !trackUri || !trackTitle || !artistName) {
      return reply.code(400).send({ error: 'Dados da faixa são obrigatórios' })
    }

    const userId = request.user.id
    const supabase = supabaseForUser(request.accessToken)

    // Limite de 3 vagas (cravadas ativas)
    const { count: activeCount, error: countError } = await supabase
      .from('cravadas')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('status', 'ativa')

    if (countError) {
      app.log.error({ err: countError }, 'Erro ao contar cravadas')
      return reply.code(500).send({ error: 'Erro ao processar cravada' })
    }

    if ((activeCount ?? 0) >= MAX_SLOTS) {
      return reply.code(409).send({ error: 'Você já usou suas 3 vagas' })
    }

    // Não deixa cravar a mesma faixa duas vezes (ativa)
    const { data: dup } = await supabase
      .from('cravadas')
      .select('id')
      .eq('user_id', userId)
      .eq('track_uri', trackUri)
      .eq('status', 'ativa')
      .maybeSingle()

    if (dup) {
      return reply.code(409).send({ error: 'Você já cravou essa faixa' })
    }

    // Mede no Deezer: popularidade da faixa (baseline) e fama do artista (multiplicador)
    const resolved = await resolveTrack({
      isrc: isrc ?? null,
      artist: artistName,
      title: trackTitle,
    })
    if (!resolved) {
      return reply
        .code(502)
        .send({ error: 'Não foi possível medir a popularidade dessa faixa' })
    }

    const baselinePopularity = popScore(resolved.rank)
    const artistFame = fameScore(resolved.nbFan)
    const multiplier = computeMultiplier(artistFame, baselinePopularity)

    const { data: inserted, error: insertError } = await supabase
      .from('cravadas')
      .insert([
        {
          user_id: userId,
          track_id: trackId,
          track_uri: trackUri,
          track_title: trackTitle,
          artist_name: artistName,
          album_name: albumName ?? null,
          track_thumbnail: trackThumbnail ?? null,
          deezer_track_id: resolved.deezerTrackId,
          deezer_artist_id: resolved.deezerArtistId || null,
          baseline_popularity: baselinePopularity,
          artist_popularity: artistFame,
          multiplier,
          accumulated_points: 0,
          last_popularity: baselinePopularity,
          last_day_gain: 0,
          status: 'ativa',
          last_checked_at: new Date().toISOString(),
        },
      ])
      .select('*')
      .single()

    if (insertError || !inserted) {
      app.log.error({ err: insertError, userId }, 'Erro ao inserir cravada')
      return reply.code(500).send({ error: 'Erro ao salvar cravada' })
    }

    // Snapshot inicial (dia 0): baseline, sem ganho
    await supabase.from('cravada_snapshots').insert([
      {
        cravada_id: inserted.id,
        popularity: baselinePopularity,
        day_gain: 0,
        points_gain: 0,
      },
    ])

    app.log.info({ userId, trackUri, multiplier }, 'Faixa cravada')

    return reply.code(201).send({
      cravada: {
        ...inserted,
        days_held: 0,
        days_to_collect: MIN_DAYS_TO_COLLECT,
        can_collect: false,
        pessoas_cravaram: 1,
      },
    })
  })

  // ---- Recolher (remover / coletar pontos) ----
  app.post<{ Params: { id: string } }>(
    '/cravadas/:id/recolher',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params
      const userId = request.user.id
      const supabase = supabaseForUser(request.accessToken)

      const { data: cravada, error } = await supabase
        .from('cravadas')
        .select('*')
        .eq('id', id)
        .eq('user_id', userId)
        .maybeSingle()

      if (error) {
        app.log.error({ err: error }, 'Erro ao buscar cravada para recolher')
        return reply.code(500).send({ error: 'Erro ao recolher' })
      }
      if (!cravada) {
        return reply.code(404).send({ error: 'Cravada não encontrada' })
      }

      const held = daysHeld(cravada.craved_at)
      const canCollect = cravada.status === 'ativa' && held >= MIN_DAYS_TO_COLLECT

      // Só coleta pontos se ficou >= 7 dias E ainda está ativa (não removida)
      if (canCollect && cravada.accumulated_points > 0) {
        const { error: ledgerError } = await supabase.from('cravada_collections').insert([
          {
            user_id: userId,
            cravada_id: cravada.id,
            track_title: cravada.track_title,
            artist_name: cravada.artist_name,
            points: cravada.accumulated_points,
          },
        ])
        if (ledgerError) {
          app.log.error({ err: ledgerError }, 'Erro ao registrar coleta')
          return reply.code(500).send({ error: 'Erro ao coletar pontos' })
        }
      }

      const collectedPoints = canCollect ? cravada.accumulated_points : 0

      // A linha some da página (esvazia a vaga). Mantemos 'coletada' para histórico
      // quando houve coleta; senão, removemos de vez.
      if (collectedPoints > 0) {
        await supabase
          .from('cravadas')
          .update({ status: 'coletada', collected_at: new Date().toISOString() })
          .eq('id', cravada.id)
          .eq('user_id', userId)
      } else {
        await supabase.from('cravadas').delete().eq('id', cravada.id).eq('user_id', userId)
      }

      return reply.send({
        success: true,
        collected: collectedPoints > 0,
        points: collectedPoints,
      })
    }
  )

  // ---- Total de pontos do usuário (sistema isolado de Cravadas) ----
  app.get('/cravadas/points', { preHandler: requireAuth }, async (request, reply) => {
    const supabase = supabaseForUser(request.accessToken)
    const { data, error } = await supabase
      .from('cravada_collections')
      .select('points')
      .eq('user_id', request.user.id)

    if (error) {
      app.log.error({ err: error }, 'Erro ao somar pontos')
      return reply.code(500).send({ error: 'Erro ao buscar pontos' })
    }

    const total = (data ?? []).reduce((sum, row) => sum + (row.points ?? 0), 0)
    return reply.send({ total })
  })
}
