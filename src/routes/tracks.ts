import type { FastifyInstance } from 'fastify'
import { supabase, supabaseAdmin, supabaseForUser } from '../lib/supabase'
import { getOptionalUser, requireAuth } from '../plugins/auth'
import {
  fetchSpotifyArtistInfo,
  fetchSpotifyTrackInfo,
  searchSpotifyTracks,
  type SpotifyTrack,
} from '../lib/spotify'
import { fetchDeezerGenresByISRC } from '../lib/deezer'
import { searchYouTubeVideoId } from '../lib/youtube'

// Gêneros do Spotify vêm em minúsculas ("canadian contemporary r&b"); pega os 2
// primeiros e capitaliza cada palavra para exibição.
function formatGenres(genres?: string[] | null): string | null {
  if (!genres || genres.length === 0) return null
  return genres
    .slice(0, 2)
    .map((g) =>
      g
        .split(' ')
        .map((w) => (w === 'r&b' ? 'R&B' : w.charAt(0).toUpperCase() + w.slice(1)))
        .join(' ')
    )
    .join(' · ')
}

// Resolve o videoId do YouTube usando o cache (Spotify id -> YouTube id) antes
// de gastar cota da YouTube Data API. Persiste apenas resultados positivos.
async function resolveYouTubeVideoId(
  app: FastifyInstance,
  trackId: string,
  trackName: string,
  artistNames: string
): Promise<string | null> {
  try {
    const { data: cached } = await supabase
      .from('youtube_cache')
      .select('youtube_video_id')
      .eq('spotify_track_id', trackId)
      .maybeSingle()

    if (cached?.youtube_video_id) return cached.youtube_video_id
  } catch (err) {
    app.log.warn({ err }, 'Falha ao ler youtube_cache')
  }

  const videoId = await searchYouTubeVideoId(trackName, artistNames)
  if (videoId) {
    try {
      if (supabaseAdmin) {
        // Caminho autoritativo. A service role ignora o RLS e a tabela não tem
        // policy de INSERT/UPDATE, então só o servidor escreve por aqui — e só
        // por aqui dá para SOBRESCREVER. É o conserto de uma entrada errada ou
        // envenenada (ver migrations/017_youtube_cache_sem_sobrescrita.sql).
        await supabaseAdmin
          .from('youtube_cache')
          .upsert(
            {
              spotify_track_id: trackId,
              youtube_video_id: videoId,
              updated_at: new Date().toISOString(),
            },
            { onConflict: 'spotify_track_id' }
          )
      } else {
        // Sem service role: cai na função SECURITY DEFINER, que só preenche
        // vazio. Nunca sobrescreve.
        await supabase.rpc('cache_youtube_video', {
          p_spotify_id: trackId,
          p_video_id: videoId,
        })
      }
    } catch (err) {
      app.log.warn({ err }, 'Falha ao gravar youtube_cache')
    }
  }
  return videoId
}

// Mutações em faixas do próprio usuário: favoritar e remover.
// (O claim em si fica em claims.ts; aqui ficam as ações sobre faixas já salvas.)
export default async function trackRoutes(app: FastifyInstance) {
  // Busca de faixas no Spotify para a UI (escolher faixa nos Stakes, etc.).
  // Devolve uma forma já normalizada para o mobile, evitando que o app tenha
  // que conhecer o formato cru do Spotify ou embutir as credenciais.
  app.get<{ Querystring: { q?: string; limit?: string } }>(
    '/tracks/search',
    async (request, reply) => {
      const q = (request.query.q ?? '').trim()
      if (q.length < 2) {
        return reply.send({ tracks: [] })
      }

      const limit = Number(request.query.limit) || 10
      const items = await searchSpotifyTracks(q, limit)

      const tracks = items.map((t) => {
        const images = t.album?.images ?? []
        return {
          id: t.id,
          title: t.name,
          artist: t.artists?.map((a) => a.name).join(', ') || '—',
          uri: t.uri,
          isrc: t.external_ids?.isrc ?? null,
          albumName: t.album?.name ?? null,
          // menor (última) p/ as linhas da lista; maior (primeira) p/ o hero.
          thumbnail: images[images.length - 1]?.url ?? images[0]?.url ?? null,
          cover: images[0]?.url ?? images[images.length - 1]?.url ?? null,
        }
      })

      return reply.send({ tracks })
    }
  )

  // Detalhes completos de uma faixa (autenticação opcional). Consolida tudo que
  // a página de track do front monta no servidor, para o app mobile consumir
  // numa única chamada: faixa do Spotify, gênero/seguidores, prévia do YouTube,
  // total de claims, top claimers e — se logado — o claim do próprio usuário.
  app.get<{ Params: { id: string } }>(
    '/tracks/spotify/:id',
    async (request, reply) => {
      const { id: trackId } = request.params

      const track: SpotifyTrack | null = await fetchSpotifyTrackInfo(trackId)
      if (!track) {
        return reply.code(404).send({ error: 'Faixa não encontrada no Spotify' })
      }

      const artists = (track.artists || []).map((a) => ({ id: a.id, name: a.name }))
      const artistNames = artists.map((a) => a.name).join(', ') || 'Artista Desconhecido'

      // Gênero não vem na faixa — buscamos no artista principal e, se vazio
      // (comum p/ BR/indie), caímos no Deezer pelo ISRC.
      let genre: string | null = null
      let followers: number | null = null
      const primaryArtistId = artists[0]?.id
      if (primaryArtistId) {
        const artistInfo = await fetchSpotifyArtistInfo(String(primaryArtistId))
        genre = formatGenres(artistInfo?.genres)
        followers = artistInfo?.followers?.total ?? null
      }
      const isrc = track.external_ids?.isrc || null
      if (!genre && isrc) {
        genre = formatGenres(await fetchDeezerGenresByISRC(isrc))
      }

      // Contagem total de claims e top claimers (com perfil) por track_uri.
      const [{ count: totalCount }, { data: claimersRaw }] = await Promise.all([
        supabase
          .from('tracks')
          .select('*', { count: 'exact', head: true })
          .eq('track_uri', track.uri),
        supabase
          .from('tracks')
          .select(
            'user_id, position, claimedat, profiles:user_id ( username, display_name, avatar_url )'
          )
          .eq('track_uri', track.uri)
          .order('position', { ascending: true })
          .limit(8),
      ])

      const topClaimers = (claimersRaw || []).map((c: any) => {
        const profile = Array.isArray(c.profiles) ? c.profiles[0] : c.profiles
        return {
          user_id: c.user_id,
          position: c.position,
          claimedat: c.claimedat,
          username: profile?.username ?? null,
          display_name: profile?.display_name ?? null,
          avatar_url: profile?.avatar_url ?? null,
        }
      })

      // Claim do próprio usuário (autenticação opcional).
      let userClaim: { claimed: boolean; position: number | null } = {
        claimed: false,
        position: null,
      }
      const user = await getOptionalUser(request)
      if (user) {
        const { data: own } = await supabase
          .from('tracks')
          .select('position')
          .eq('user_id', user.id)
          .eq('track_uri', track.uri)
          .maybeSingle()
        if (own) userClaim = { claimed: true, position: own.position }
      }

      const youtubeVideoId = await resolveYouTubeVideoId(
        app,
        trackId,
        track.name,
        artistNames
      )

      return reply.send({
        track: {
          id: track.id,
          name: track.name,
          uri: track.uri,
          popularity: track.popularity,
          duration_ms: track.duration_ms,
          album: {
            name: track.album?.name ?? null,
            image: track.album?.images?.[0]?.url ?? null,
            release_date: track.album?.release_date ?? null,
          },
          artists,
          spotify_url: `https://open.spotify.com/track/${trackId}`,
        },
        genre,
        followers,
        youtubeVideoId,
        totalClaims: totalCount ?? 0,
        topClaimers,
        userClaim,
      })
    }
  )

  // Favoritar uma faixa do próprio acervo
  app.post<{ Params: { id: string } }>(
    '/tracks/:id/favorite',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params
      const userId = request.user.id
      const supabase = supabaseForUser(request.accessToken)

      const { error } = await supabase
        .from('favorites')
        .insert({ user_id: userId, track_id: id })

      // 23505 = já favoritada; tratamos como sucesso (idempotente)
      if (error && (error as { code?: string }).code !== '23505') {
        app.log.error({ err: error, userId, trackId: id }, 'Erro ao favoritar faixa')
        return reply.code(500).send({ error: 'Erro ao favoritar faixa' })
      }

      return reply.send({ success: true, is_favorited: true })
    }
  )

  // Remover dos favoritos
  app.delete<{ Params: { id: string } }>(
    '/tracks/:id/favorite',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params
      const userId = request.user.id
      const supabase = supabaseForUser(request.accessToken)

      const { error } = await supabase
        .from('favorites')
        .delete()
        .eq('user_id', userId)
        .eq('track_id', id)

      if (error) {
        app.log.error({ err: error, userId, trackId: id }, 'Erro ao desfavoritar faixa')
        return reply.code(500).send({ error: 'Erro ao desfavoritar faixa' })
      }

      return reply.send({ success: true, is_favorited: false })
    }
  )

  // Remover uma faixa do próprio acervo
  app.delete<{ Params: { id: string } }>(
    '/tracks/:id',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params
      const userId = request.user.id
      const supabase = supabaseForUser(request.accessToken)

      const { error } = await supabase
        .from('tracks')
        .delete()
        .eq('id', id)
        .eq('user_id', userId) // só o dono remove

      if (error) {
        app.log.error({ err: error, userId, trackId: id }, 'Erro ao remover faixa')
        return reply.code(500).send({ error: 'Erro ao remover faixa' })
      }

      return reply.send({ success: true })
    }
  )
}
