import type { FastifyInstance } from 'fastify'
import { supabase } from '../lib/supabase'
import { getOptionalUser } from '../plugins/auth'

const MAX_FEED_LIMIT = 50

// Conta ocorrências de track_id em uma lista de linhas
function countByTrackId(rows: Array<{ track_id: number }> | null): Record<number, number> {
  const counts: Record<number, number> = {}
  for (const row of rows || []) {
    counts[row.track_id] = (counts[row.track_id] || 0) + 1
  }
  return counts
}

export default async function feedRoutes(app: FastifyInstance) {
  // Posts do feed com contadores de likes e comentários
  app.get<{
    Querystring: { limit?: string; offset?: string }
  }>('/feed', async (request, reply) => {
    const limit = Math.min(Math.max(Number(request.query.limit) || 5, 1), MAX_FEED_LIMIT)
    const offset = Math.max(Number(request.query.offset) || 0, 0)

    const { data: tracks, error: tracksError } = await supabase
      .from('tracks')
      .select(`
        id,
        track_url,
        track_title,
        artist_name,
        album_name,
        popularity,
        track_thumbnail,
        user_id,
        position,
        claimedat,
        track_uri,
        discover_rating,
        claim_message,
        youtube_url,
        profiles:user_id!inner (
          username,
          display_name,
          avatar_url
        )
      `)
      .not('claimedat', 'is', null)
      .order('claimedat', { ascending: false })
      .range(offset, offset + limit - 1)

    if (tracksError) {
      app.log.error({ err: tracksError }, 'Erro ao buscar posts do feed')
      return reply.code(500).send({ error: 'Erro ao buscar feed' })
    }

    if (!tracks || tracks.length === 0) {
      return reply.send({ posts: [], total: 0 })
    }

    const trackIds = tracks.map((track) => track.id)

    const [likesResult, commentsResult] = await Promise.all([
      supabase.from('track_likes').select('track_id').in('track_id', trackIds),
      supabase.from('track_comments').select('track_id').in('track_id', trackIds)
    ])

    const likesCountByTrack = countByTrackId(likesResult.data)
    const commentsCountByTrack = countByTrackId(commentsResult.data)

    const posts = tracks.map((track: any) => ({
      id: track.id,
      track_url: track.track_url,
      track_title: track.track_title,
      artist_name: track.artist_name,
      album_name: track.album_name,
      popularity: track.popularity,
      track_thumbnail: track.track_thumbnail,
      user_id: track.user_id,
      position: track.position,
      claimedat: track.claimedat,
      track_uri: track.track_uri,
      discover_rating: track.discover_rating,
      claim_message: track.claim_message,
      youtube_url: track.youtube_url,
      username: track.profiles?.username || '',
      display_name: track.profiles?.display_name || null,
      avatar_url: track.profiles?.avatar_url || null,
      likes_count: likesCountByTrack[track.id] || 0,
      comments_count: commentsCountByTrack[track.id] || 0
    }))

    return reply.send({ posts, total: posts.length })
  })

  // Reivindicações recentes, sem músicas duplicadas
  app.get<{
    Querystring: { limit?: string }
  }>('/feed/recent-claims', async (request, reply) => {
    const limit = Math.min(Math.max(Number(request.query.limit) || 4, 1), 20)

    // Busca um lote maior para conseguir filtrar duplicatas
    const { data, error } = await supabase
      .from('tracks')
      .select('id, track_title, artist_name, track_thumbnail, track_url, claimedat, track_uri')
      .not('claimedat', 'is', null)
      .order('claimedat', { ascending: false })
      .limit(limit * 5)

    if (error) {
      app.log.error({ err: error }, 'Erro ao buscar reivindicações recentes')
      return reply.code(500).send({ error: 'Erro ao buscar reivindicações recentes' })
    }

    const uniqueTracks = new Map<string, object>()

    for (const track of data || []) {
      if (track.track_uri && !uniqueTracks.has(track.track_uri)) {
        uniqueTracks.set(track.track_uri, {
          id: track.id,
          track_title: track.track_title,
          artist_name: track.artist_name,
          track_thumbnail: track.track_thumbnail,
          track_url: track.track_url,
          claimedat: track.claimedat
        })
      }
      if (uniqueTracks.size >= limit) break
    }

    return reply.send({ claims: Array.from(uniqueTracks.values()) })
  })

  // Likes do usuário logado nos tracks informados (auth opcional)
  app.post<{
    Body: { track_ids: number[] }
  }>('/feed/user-likes', async (request, reply) => {
    const user = await getOptionalUser(request)
    const { track_ids } = request.body ?? {}

    if (!user || !track_ids || track_ids.length === 0) {
      return reply.send({ liked_tracks: [] })
    }

    const { data, error } = await supabase
      .from('track_likes')
      .select('track_id')
      .eq('user_id', user.id)
      .in('track_id', track_ids)

    if (error) {
      app.log.error({ err: error, userId: user.id }, 'Erro ao buscar likes do usuário')
      return reply.send({ liked_tracks: [] })
    }

    return reply.send({ liked_tracks: (data || []).map((like) => like.track_id) })
  })
}
