import type { FastifyInstance } from 'fastify'
import { supabaseAdmin, supabaseForUser } from '../lib/supabase'
import { requireAuth } from '../plugins/auth'
import { resolveTrack } from '../lib/deezer'
import { computeMultiplier, popScore, fameScore } from '../lib/stakePoints'

const MAX_SLOTS = 3
const MIN_DAYS_TO_COLLECT = 7

function daysHeld(stakedAt: string): number {
  const ms = Date.now() - new Date(stakedAt).getTime()
  return Math.floor(ms / (1000 * 60 * 60 * 24))
}

export default async function stakeRoutes(app: FastifyInstance) {
  // ---- Prévia do multiplicador (antes de dar stake) ----
  app.get<{ Querystring: { isrc?: string; artist?: string; title?: string } }>(
    '/stakes/preview',
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

  // ---- Listar os stakes do usuário ----
  app.get('/stakes', { preHandler: requireAuth }, async (request, reply) => {
    const supabase = supabaseForUser(request.accessToken)

    const { data: stakes, error } = await supabase
      .from('stakes')
      .select('*')
      .eq('user_id', request.user.id)
      .neq('status', 'coletada')
      .order('staked_at', { ascending: true })

    if (error) {
      app.log.error({ err: error }, 'Erro ao listar stakes')
      return reply.code(500).send({ error: 'Erro ao listar stakes' })
    }

    const list = stakes ?? []

    // Contagem social ("X pessoas deram stake") via função SECURITY DEFINER
    const uris = Array.from(new Set(list.map((c) => c.track_uri)))
    const countByUri = new Map<string, number>()
    if (uris.length > 0) {
      const { data: counts } = await supabase.rpc('count_stakes_by_track_uri', {
        p_uris: uris,
      })
      for (const row of counts ?? []) {
        countByUri.set(row.track_uri, Number(row.total))
      }
    }

    // Série diária de cada stake (pro gráfico) — uma query só, agrupada por
    // stake_id. Vem junto pra UI abrir o gráfico instantâneo, sem novo fetch.
    const ids = list.map((c) => c.id)
    const snapsByStake = new Map<
      string,
      { date: string; popularity: number; dayGain: number; pointsGain: number }[]
    >()
    if (ids.length > 0) {
      const { data: snaps } = await supabase
        .from('stake_snapshots')
        .select('stake_id, recorded_at, popularity, day_gain, points_gain')
        .in('stake_id', ids)
        .order('recorded_at', { ascending: true })
      for (const s of snaps ?? []) {
        const arr = snapsByStake.get(s.stake_id) ?? []
        arr.push({
          date: s.recorded_at,
          popularity: s.popularity,
          dayGain: s.day_gain,
          pointsGain: s.points_gain,
        })
        snapsByStake.set(s.stake_id, arr)
      }
    }

    const result = list.map((c) => {
      const held = daysHeld(c.staked_at)
      return {
        ...c,
        days_held: held,
        days_to_collect: Math.max(0, MIN_DAYS_TO_COLLECT - held),
        // Espelha `collect_stake()` exatamente (migration 028). Antes faltava o
        // `accumulated_points > 0` daqui: uma ficha parada há 7 dias vinha com
        // can_collect true, o card acendia verde com "Recolher · 0 pts", e o
        // clique caía no else do SQL — que APAGA a linha. O usuário achava que
        // estava colhendo e jogava a posição fora.
        // `removida` entra porque parar de medir não é perder o já medido.
        can_collect:
          (c.status === 'ativa' || c.status === 'removida') &&
          held >= MIN_DAYS_TO_COLLECT &&
          (c.accumulated_points ?? 0) > 0,
        pessoas_deram_stake: countByUri.get(c.track_uri) ?? 1,
        snapshots: snapsByStake.get(c.id) ?? [],
      }
    })

    return reply.send({ stakes: result, maxSlots: MAX_SLOTS })
  })

  // ---- Série diária de um stake (pro gráfico de evolução) ----
  app.get<{ Params: { id: string } }>(
    '/stakes/:id/snapshots',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params
      const supabase = supabaseForUser(request.accessToken)

      // Confere que o stake é do usuário (a RLS também protege, mas isto dá 404 limpo)
      const { data: stake, error: stakeErr } = await supabase
        .from('stakes')
        .select(
          'id, baseline_popularity, last_popularity, peak_popularity, multiplier, staked_at'
        )
        .eq('id', id)
        .eq('user_id', request.user.id)
        .maybeSingle()

      if (stakeErr) {
        app.log.error({ err: stakeErr }, 'Erro ao buscar stake para snapshots')
        return reply.code(500).send({ error: 'Erro ao buscar histórico' })
      }
      if (!stake) {
        return reply.code(404).send({ error: 'Stake não encontrado' })
      }

      const { data: snaps, error } = await supabase
        .from('stake_snapshots')
        .select('recorded_at, popularity, day_gain, points_gain')
        .eq('stake_id', id)
        .order('recorded_at', { ascending: true })

      if (error) {
        app.log.error({ err: error }, 'Erro ao buscar snapshots')
        return reply.code(500).send({ error: 'Erro ao buscar histórico' })
      }

      return reply.send({
        baseline_popularity: stake.baseline_popularity,
        last_popularity: stake.last_popularity,
        peak_popularity: stake.peak_popularity,
        multiplier: stake.multiplier,
        staked_at: stake.staked_at,
        snapshots: (snaps ?? []).map((s) => ({
          date: s.recorded_at,
          popularity: s.popularity,
          dayGain: s.day_gain,
          pointsGain: s.points_gain,
        })),
      })
    }
  )

  // ---- Dar stake numa faixa ----
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
  }>('/stakes', { preHandler: requireAuth }, async (request, reply) => {
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
    // Leitura com o token do usuário (a RLS confere que as linhas são dele).
    // Escrita com a service role: desde o migration 018 `authenticated` não tem
    // INSERT em stakes, porque baseline_popularity e multiplier vêm do Deezer,
    // medidos aqui embaixo — não são valor que o cliente possa mandar.
    const supabase = supabaseForUser(request.accessToken)

    if (!supabaseAdmin) {
      app.log.error({}, 'SUPABASE_SERVICE_ROLE_KEY ausente — POST /stakes indisponível')
      return reply.code(503).send({ error: 'Stakes indisponíveis no momento' })
    }

    // Limite de 3 vagas (stakes ativos)
    const { count: activeCount, error: countError } = await supabase
      .from('stakes')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('status', 'ativa')

    if (countError) {
      app.log.error({ err: countError }, 'Erro ao contar stakes')
      return reply.code(500).send({ error: 'Erro ao processar stake' })
    }

    if ((activeCount ?? 0) >= MAX_SLOTS) {
      return reply.code(409).send({ error: 'Você já usou suas 3 vagas' })
    }

    // Não deixa dar stake na mesma faixa duas vezes (ativa)
    const { data: dup } = await supabase
      .from('stakes')
      .select('id')
      .eq('user_id', userId)
      .eq('track_uri', trackUri)
      .eq('status', 'ativa')
      .maybeSingle()

    if (dup) {
      return reply.code(409).send({ error: 'Você já deu stake nessa faixa' })
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

    const { data: inserted, error: insertError } = await supabaseAdmin
      .from('stakes')
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
          // marca d'água começa no baseline: só passar disso paga (migration 028)
          peak_popularity: baselinePopularity,
          last_day_gain: 0,
          status: 'ativa',
          last_checked_at: new Date().toISOString(),
        },
      ])
      .select('*')
      .single()

    if (insertError || !inserted) {
      // 23505 = o índice único parcial (um stake ativo por faixa) pegou uma
      // corrida que passou pela checagem de duplicata lá em cima.
      if (insertError?.code === '23505') {
        return reply.code(409).send({ error: 'Você já deu stake nessa faixa' })
      }
      app.log.error({ err: insertError, userId }, 'Erro ao inserir stake')
      return reply.code(500).send({ error: 'Erro ao salvar stake' })
    }

    // Snapshot inicial (dia 0): baseline, sem ganho
    await supabaseAdmin.from('stake_snapshots').insert([
      {
        stake_id: inserted.id,
        popularity: baselinePopularity,
        day_gain: 0,
        points_gain: 0,
      },
    ])

    app.log.info({ userId, trackUri, multiplier }, 'Stake dado')

    return reply.code(201).send({
      stake: {
        ...inserted,
        days_held: 0,
        days_to_collect: MIN_DAYS_TO_COLLECT,
        can_collect: false,
        pessoas_deram_stake: 1,
      },
    })
  })

  // ---- Recolher (remover / coletar pontos) ----
  app.post<{ Params: { id: string } }>(
    '/stakes/:id/recolher',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params
      const userId = request.user.id
      const supabase = supabaseForUser(request.accessToken)

      // Ler-decidir-escrever em duas tabelas mora no banco desde o migration
      // 018: `collect_stake` é SECURITY DEFINER, roda tudo numa transação só e
      // dá `for update` na linha do stake. Assim dois "recolher" simultâneos não
      // gravam dois lançamentos do mesmo saldo, e a regra dos 7 dias vale mesmo
      // que a chamada não venha por aqui. Vai com o token do usuário: quem
      // autoriza é o `auth.uid()` lá dentro.
      const { data, error } = await supabase.rpc('collect_stake', { p_stake_id: id }).single()

      if (error) {
        app.log.error({ err: error, userId, stakeId: id }, 'Erro ao recolher stake')
        return reply.code(500).send({ error: 'Erro ao recolher' })
      }

      const result = data as { found: boolean; collected: boolean; points: number } | null
      if (!result?.found) {
        return reply.code(404).send({ error: 'Stake não encontrado' })
      }

      return reply.send({
        success: true,
        collected: result.collected,
        points: result.points,
      })
    }
  )

  // ---- Total de pontos do usuário (sistema isolado de Stakes) ----
  app.get('/stakes/points', { preHandler: requireAuth }, async (request, reply) => {
    const supabase = supabaseForUser(request.accessToken)
    const { data, error } = await supabase
      .from('stake_collections')
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
