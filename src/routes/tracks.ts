import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { supabase, supabaseAdmin, supabaseForUser } from '../lib/supabase'
import { getOptionalUser, requireAuth } from '../plugins/auth'
import { findSpotifyIdByIsrc } from '../lib/spotify'
import {
  searchTracks,
  getTrackByIsrc,
  getArtistFans,
  getAlbumGenres,
  type FaixaDaBusca,
} from '../lib/deezer'
import { popScore } from '../lib/stakePoints'
import { searchYouTubeVideoId } from '../lib/youtube'

const ISRC_RE = /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/
const SPOTIFY_ID_RE = /^[A-Za-z0-9]{22}$/

/**
 * Os gêneros do Deezer já vêm apresentáveis e em português ("Rap/Hip Hop",
 * "Samba/Pagode"). Sobrou juntar os dois primeiros.
 *
 * A versão anterior capitalizava palavra por palavra porque o Spotify mandava
 * "canadian contemporary r&b" em minúsculas — e mandava vazio para a maioria
 * dos artistas BR e indie, que é a razão de o Deezer já ser a fonte de gênero
 * aqui desde antes deste plano.
 */
function formatGenres(genres?: string[] | null): string | null {
  if (!genres || genres.length === 0) return null
  return genres.slice(0, 2).join(' · ')
}

/**
 * O filtro que identifica uma GRAVAÇÃO. Mesma regra de src/routes/claims.ts:
 * `track_uri` é a chave opaca (as linhas antigas guardam 'spotify:track:<id>')
 * e `isrc` é a identidade, que existe desde a migration 023.
 */
function filtroDaGravacao(trackUri: string | null, isrc: string | null): string | null {
  const partes: string[] = []
  if (isrc) partes.push(`isrc.eq.${isrc}`)
  if (trackUri) partes.push(`track_uri.eq.${trackUri}`)
  return partes.length > 0 ? partes.join(',') : null
}

/**
 * Prévia do YouTube — agora a SEGUNDA opção, atrás do MP3 de 30 s que o Deezer
 * entrega no mesmo objeto da faixa.
 *
 * A cota da YouTube Data API é de 10.000 unidades/dia e cada busca custa 100:
 * são 100 buscas por dia para o produto inteiro, e foi por isso que a tabela
 * `youtube_cache` precisou existir (migrations 002 e 017). Com a prévia do
 * Deezer na frente, isso vira quase zero consumo.
 *
 * A chave do cache continua sendo o id do Spotify, que é o que a tabela guarda:
 * sem esse id não há o que consultar nem o que gravar, e a função sai cedo.
 */
async function resolveYouTubeVideoId(
  app: FastifyInstance,
  spotifyTrackId: string | null,
  trackName: string,
  artistNames: string
): Promise<string | null> {
  if (!spotifyTrackId) return null

  try {
    const { data: cached } = await supabase
      .from('youtube_cache')
      .select('youtube_video_id')
      .eq('spotify_track_id', spotifyTrackId)
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
              spotify_track_id: spotifyTrackId,
              youtube_video_id: videoId,
              updated_at: new Date().toISOString(),
            },
            { onConflict: 'spotify_track_id' }
          )
      } else {
        // Sem service role: cai na função SECURITY DEFINER, que só preenche
        // vazio. Nunca sobrescreve.
        await supabase.rpc('cache_youtube_video', {
          p_spotify_id: spotifyTrackId,
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
  /**
   * Busca de faixas para a UI (escolher faixa nos Stakes, adicionar música).
   *
   * Passou a vir do Deezer (fase 3 do plano de independência do Spotify): a
   * busca do Spotify respondeu 429 com Retry-After de 3h24 na sondagem de
   * 15/08/2026, ou seja, a escolha de faixa do app simplesmente parava por
   * horas. O Deezer responde sem chave e sem token.
   *
   * Efeito colateral bom, e é o ponto de atenção que o plano previa: os Stakes
   * casavam a faixa escolhida com o Deezer por ISRC depois da escolha
   * (`resolveTrack`). Com a busca já vindo do Deezer, esse casamento deixa de
   * existir — a faixa NASCE com id do Deezer e ISRC em mãos.
   */
  app.get<{ Querystring: { q?: string; limit?: string } }>(
    '/tracks/search',
    async (request, reply) => {
      const q = (request.query.q ?? '').trim()
      if (q.length < 2) {
        return reply.send({ tracks: [] })
      }

      const limit = Number(request.query.limit) || 10
      const achadas = await searchTracks(q, limit)

      const tracks = achadas.map((t: FaixaDaBusca) => ({
        id: t.id,
        title: t.title,
        artist: t.artist,
        uri: t.uri,
        isrc: t.isrc,
        deezerTrackId: t.deezerTrackId,
        albumName: t.albumName,
        thumbnail: t.thumbnail,
        cover: t.cover,
        preview: t.preview,
        // 0-100 na mesma escala do Observatório e dos Stakes, em vez do
        // `popularity` do Spotify — que, além de outra escala, saiu do ar.
        popularity: popScore(t.rank),
      }))

      return reply.send({ tracks })
    }
  )

  /**
   * Camada 2 do "ouvir no Spotify": resolução preguiçosa.
   *
   * A etapa 5 do job noturno resolvia 2.027 ISRCs por noite contra o Spotify e
   * era a parte da rodada que mais falhava. Aqui a mesma resolução acontece
   * quando ALGUÉM ABRE A PÁGINA: o custo passa a escalar com interesse, não com
   * o tamanho do catálogo, e um 429 não derruba mais uma etapa inteira — só
   * adia um botão que já tem plano B (o deep link de busca).
   *
   * Público de propósito (a página de faixa é aberta), mas nada vindo do
   * cliente é gravado: o corpo traz só o ISRC, e quem descobre o id é o
   * servidor. Se o navegador pudesse mandar o `spotify_track_id`, qualquer um
   * apontaria o botão de qualquer faixa para qualquer outra — a mesma lição da
   * migration 017 com o cache do YouTube.
   */
  app.post<{ Body: { isrc?: string } }>(
    '/tracks/resolve-spotify',
    async (request, reply) => {
      const isrc = String(request.body?.isrc ?? '').trim().toUpperCase()
      if (!ISRC_RE.test(isrc)) {
        return reply.code(400).send({ error: 'ISRC inválido' })
      }

      // Já resolvido antes: responde do banco, sem tocar no Spotify.
      const { data: jaTem } = await supabase
        .from('observed_tracks')
        .select('spotify_track_id, spotify_checked_at')
        .eq('isrc', isrc)
        .not('spotify_track_id', 'is', null)
        .limit(1)
        .maybeSingle()

      if (jaTem?.spotify_track_id) {
        return reply.send({ spotifyTrackId: jaTem.spotify_track_id })
      }

      const { id, falhou } = await findSpotifyIdByIsrc(isrc)

      // Falha transitória não vira registro: gravar faria a faixa levar a marca
      // de "já tentei" e nunca mais voltar à fila por causa de um 429. Foi
      // exatamente o que queimou 1.904 faixas no primeiro backfill.
      if (falhou) {
        return reply.send({ spotifyTrackId: null })
      }

      // Sem service role não há como gravar (a tabela não tem policy de
      // escrita). O botão ainda ganha o link certo nesta visita.
      if (!supabaseAdmin) {
        return reply.send({ spotifyTrackId: id })
      }

      const { data: linhas } = await supabase
        .from('observed_tracks')
        .select('deezer_track_id')
        .eq('isrc', isrc)
        .eq('active', true)

      const paraGravar = (linhas ?? []).map((l) => ({
        deezer_track_id: l.deezer_track_id,
        spotify_track_id: id,
      }))

      if (paraGravar.length > 0) {
        const { error } = await supabaseAdmin.rpc('record_spotify_ids', {
          p_rows: paraGravar,
        })
        if (error) {
          app.log.warn({ err: error, isrc }, 'Falha ao gravar id do Spotify resolvido na visita')
        }
      }

      return reply.send({ spotifyTrackId: id })
    }
  )

  /**
   * Detalhes completos de uma gravação, pelo ISRC. Consolida tudo que a página
   * de faixa monta no servidor, para o app mobile consumir numa chamada só.
   *
   * Uma requisição ao Deezer resolve título, artista, álbum, capa, duração,
   * explícito, data, rank e a prévia de 30 s. As outras duas (gênero do álbum e
   * fãs do artista) só saem quando há o que buscar.
   */
  async function montarDetalhe(isrc: string) {
    const faixa = await getTrackByIsrc(isrc)
    if (!faixa) return null

    // O id do Spotify é enriquecimento, não requisito: vem do que o job já
    // pagou. Null aqui significa que o app usa o deep link de busca.
    const { data: local } = await supabase
      .from('observed_tracks')
      .select('spotify_track_id, genre')
      .eq('isrc', isrc)
      .order('last_rank', { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle()

    const spotifyTrackId = local?.spotify_track_id ?? null

    // O gênero do Observatório já é o do Deezer (vem do chart de onde a faixa
    // entrou). Quando ele existe, a requisição a /album/{id} não acontece.
    const generoLocal = local?.genre?.trim() || null

    const [genresDoAlbum, fans] = await Promise.all([
      !generoLocal && faixa.deezerAlbumId
        ? getAlbumGenres(faixa.deezerAlbumId)
        : Promise.resolve(null),
      faixa.deezerArtistId ? getArtistFans(faixa.deezerArtistId) : Promise.resolve(null),
    ])

    const trackUri = faixa.uri
    const filtro = filtroDaGravacao(trackUri, isrc)

    const [{ count: totalCount }, { data: claimersRaw }] = await Promise.all([
      supabase.from('tracks').select('*', { count: 'exact', head: true }).or(filtro!),
      supabase
        .from('tracks')
        .select(
          'user_id, position, claimedat, profiles:user_id ( username, display_name, avatar_url )'
        )
        .or(filtro!)
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

    return {
      faixa,
      spotifyTrackId,
      genre: formatGenres(generoLocal ? [generoLocal] : genresDoAlbum),
      followers: fans,
      totalClaims: totalCount ?? 0,
      topClaimers,
      trackUri,
      filtro,
    }
  }

  async function responderDetalhe(
    request: FastifyRequest,
    reply: FastifyReply,
    isrc: string
  ) {
    const d = await montarDetalhe(isrc)
    if (!d) {
      return reply.code(404).send({ error: 'Faixa não encontrada' })
    }

    // Claim do próprio usuário (autenticação opcional).
    let userClaim: { claimed: boolean; position: number | null } = {
      claimed: false,
      position: null,
    }
    const user = await getOptionalUser(request)
    if (user && d.filtro) {
      const { data: own } = await supabase
        .from('tracks')
        .select('position')
        .eq('user_id', user.id)
        .or(d.filtro)
        .limit(1)
        .maybeSingle()
      if (own) userClaim = { claimed: true, position: own.position }
    }

    // A prévia do Deezer vem no mesmo objeto da faixa. O YouTube só entra
    // quando ela não veio, e só quando existe id do Spotify para chavear o
    // cache — ver resolveYouTubeVideoId().
    const youtubeVideoId = d.faixa.preview
      ? null
      : await resolveYouTubeVideoId(app, d.spotifyTrackId, d.faixa.title, d.faixa.artist)

    return reply.send({
      track: {
        id: d.faixa.id,
        isrc: d.faixa.isrc,
        deezerTrackId: d.faixa.deezerTrackId,
        name: d.faixa.title,
        artist: d.faixa.artist,
        uri: d.trackUri,
        // 0-100 por popScore(rank): a MESMA escala da curva do Observatório.
        popularity: popScore(d.faixa.rank),
        duration_ms: d.faixa.duration * 1000,
        explicit: d.faixa.explicit,
        album: {
          name: d.faixa.albumName,
          image: d.faixa.cover,
          release_date: d.faixa.releaseDate,
        },
        // Prévia de 30 s, sem cota e sem cache. A URL é assinada e expira em
        // horas — quem receber deve usar já, e nunca guardar.
        preview: d.faixa.preview,
        // O "ouvir no Spotify" em três camadas (§5 do plano): id exato quando
        // existe, busca quando não. As duas formas vão prontas para o cliente
        // não precisar conhecer nenhuma das duas regras.
        spotify_url: d.spotifyTrackId
          ? `https://open.spotify.com/track/${d.spotifyTrackId}`
          : `https://open.spotify.com/search/${encodeURIComponent(
              `${d.faixa.artist} ${d.faixa.title}`
            )}`,
        spotify_exact: !!d.spotifyTrackId,
        deezer_url: `https://www.deezer.com/track/${d.faixa.deezerTrackId}`,
      },
      genre: d.genre,
      followers: d.followers,
      youtubeVideoId,
      totalClaims: d.totalClaims,
      topClaimers: d.topClaimers,
      userClaim,
    })
  }

  app.get<{ Params: { isrc: string } }>('/tracks/isrc/:isrc', async (request, reply) => {
    const isrc = String(request.params.isrc || '').trim().toUpperCase()
    if (!ISRC_RE.test(isrc)) {
      return reply.code(400).send({ error: 'ISRC inválido' })
    }
    return responderDetalhe(request, reply, isrc)
  })

  /**
   * A rota antiga, por id do Spotify. Continua respondendo — o app instalado
   * não se atualiza sozinho — mas por dentro ela só traduz o id para ISRC e
   * entrega a mesma ficha. A tradução é LOCAL: sai de observed_tracks, a ponte
   * que o job já pagou, sem chamar o Spotify.
   */
  app.get<{ Params: { id: string } }>('/tracks/spotify/:id', async (request, reply) => {
    const id = String(request.params.id || '').trim()
    if (!SPOTIFY_ID_RE.test(id)) {
      return reply.code(400).send({ error: 'Id do Spotify inválido' })
    }

    const { data } = await supabase
      .from('observed_tracks')
      .select('isrc')
      .eq('spotify_track_id', id)
      .not('isrc', 'is', null)
      .order('last_rank', { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle()

    if (!data?.isrc) {
      return reply.code(404).send({ error: 'Faixa não encontrada' })
    }

    return responderDetalhe(request, reply, data.isrc)
  })

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
