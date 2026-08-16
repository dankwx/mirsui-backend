import type { FastifyInstance, FastifyRequest } from 'fastify'
import { supabase } from '../lib/supabase'
import { getOptionalUser } from '../plugins/auth'

const MAX_FEED_LIMIT = 50

interface ContadoresDaFaixa {
  track_id: number
  savers_count: number
  comments_count: number
}

export default async function feedRoutes(app: FastifyInstance) {
  // Posts do feed com contagem de salvamentos e comentários.
  // Auth opcional: com token, cada post vem com `saved_by_me`.
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
        isrc,
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

    // A contagem acontece no banco. Antes isto puxava TODAS as linhas de
    // track_likes/track_comments das faixas e contava no JS — o PostgREST corta
    // a resposta em 1000 linhas, então a partir de mil linhas a faixa passava a
    // mostrar número errado, sem erro nenhum.
    // Ver mirsui-backend/migrations/006_salvar_de_verdade.sql.
    const { data: contadores, error: contadoresError } = await supabase.rpc(
      'get_track_save_counts',
      { p_track_ids: trackIds }
    )

    // Contador é acessório: se falhar, o feed ainda vale mais que um 500.
    if (contadoresError) {
      app.log.error({ err: contadoresError }, 'Erro ao contar salvamentos e comentários')
    }

    const saversCountByTrack: Record<number, number> = {}
    const commentsCountByTrack: Record<number, number> = {}
    for (const linha of (contadores || []) as ContadoresDaFaixa[]) {
      saversCountByTrack[linha.track_id] = Number(linha.savers_count) || 0
      commentsCountByTrack[linha.track_id] = Number(linha.comments_count) || 0
    }

    // "Você já salvou esta faixa?" é por GRAVAÇÃO, não por linha de tracks:
    // cada pessoa que salva a mesma música cria uma linha própria, então
    // perguntar pelo id do post responderia sobre o achado de outra pessoa.
    const salvas = await buscarSalvasDoUsuario(request, tracks)

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
      isrc: track.isrc ?? null,
      discover_rating: track.discover_rating,
      claim_message: track.claim_message,
      youtube_url: track.youtube_url,
      username: track.profiles?.username || '',
      display_name: track.profiles?.display_name || null,
      avatar_url: track.profiles?.avatar_url || null,
      savers_count: saversCountByTrack[track.id] || 0,
      comments_count: commentsCountByTrack[track.id] || 0,
      saved_by_me:
        (!!track.track_uri && salvas.uris.has(track.track_uri)) ||
        (!!track.isrc && salvas.isrcs.has(track.isrc))
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
      .select('id, track_title, artist_name, track_thumbnail, track_url, claimedat, track_uri, isrc')
      .not('claimedat', 'is', null)
      .order('claimedat', { ascending: false })
      .limit(limit * 5)

    if (error) {
      app.log.error({ err: error }, 'Erro ao buscar reivindicações recentes')
      return reply.code(500).send({ error: 'Erro ao buscar reivindicações recentes' })
    }

    const uniqueTracks = new Map<string, object>()

    // A chave da deduplicação é a GRAVAÇÃO: sem isso a mesma faixa salva por
    // dois caminhos ('spotify:track:X' antes, 'isrc:Y' depois) apareceria duas
    // vezes na mesma lista de "achados recentes".
    for (const track of data || []) {
      const chave = track.isrc || track.track_uri
      if (chave && !uniqueTracks.has(chave)) {
        uniqueTracks.set(chave, {
          id: track.id,
          track_title: track.track_title,
          artist_name: track.artist_name,
          track_thumbnail: track.track_thumbnail,
          track_url: track.track_url,
          isrc: track.isrc ?? null,
          claimedat: track.claimedat
        })
      }
      if (uniqueTracks.size >= limit) break
    }

    return reply.send({ claims: Array.from(uniqueTracks.values()) })
  })

  /**
   * Quais das faixas desta página o usuário logado já salvou.
   *
   * Devolve chaves de GRAVAÇÃO (não ids de linha): o vínculo é com a música,
   * então dois achados diferentes da mesma faixa respondem igual — que é o
   * ponto de o botão do feed ser coerente entre posts repetidos.
   *
   * São dois conjuntos porque a gravação tem duas chaves convivendo: o
   * `track_uri` opaco, que as linhas antigas guardam como 'spotify:track:<id>',
   * e o `isrc`, que existe desde a migration 023. Perguntar só pelo uri faria o
   * botão dizer "Salvar" numa faixa que a pessoa já salvou por outro caminho.
   *
   * Sem token, devolve vazio: visitante não salvou nada. Erro aqui também
   * devolve vazio — o feed inteiro não pode cair porque o estado do botão
   * falhou, e o pior caso é oferecer "Salvar" numa faixa já salva, que o
   * backend trata como idempotente (409 em tracks/claim).
   */
  async function buscarSalvasDoUsuario(
    request: FastifyRequest,
    tracks: Array<{ track_uri: string | null; isrc?: string | null }>
  ): Promise<{ uris: Set<string>; isrcs: Set<string> }> {
    const vazio = { uris: new Set<string>(), isrcs: new Set<string>() }

    const uris = [...new Set(tracks.map((t) => t.track_uri).filter((v): v is string => !!v))]
    const isrcs = [...new Set(tracks.map((t) => t.isrc).filter((v): v is string => !!v))]
    if (uris.length === 0 && isrcs.length === 0) return vazio

    const user = await getOptionalUser(request)
    if (!user) return vazio

    let query = supabase.from('tracks').select('track_uri, isrc').eq('user_id', user.id)

    // Um `.or()` só: duas consultas separadas dobrariam a ida ao banco por
    // página de feed para responder a mesma pergunta.
    const clausulas: string[] = []
    if (uris.length > 0) clausulas.push(`track_uri.in.(${uris.map((u) => `"${u}"`).join(',')})`)
    if (isrcs.length > 0) clausulas.push(`isrc.in.(${isrcs.join(',')})`)
    query = query.or(clausulas.join(','))

    const { data, error } = await query

    if (error) {
      app.log.error({ err: error, userId: user.id }, 'Erro ao buscar faixas salvas pelo usuário')
      return vazio
    }

    return {
      uris: new Set((data || []).map((r) => r.track_uri).filter((v): v is string => !!v)),
      isrcs: new Set((data || []).map((r) => r.isrc).filter((v): v is string => !!v)),
    }
  }
}
