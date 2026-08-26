// src/jobs/stakeSnapshot.ts
// Job diário: mede a popularidade atual de cada stake ativo no Deezer,
// registra um snapshot e acumula os pontos (ganho * multiplicador travado).
// Roda com service role (lê stakes de TODOS os usuários) — ver Stake.md.

import { supabaseAdmin } from '../lib/supabase'
import { getTrackRank } from '../lib/deezer'
import { computePointsGain, popScore } from '../lib/stakePoints'

interface StakeRow {
  id: string
  deezer_track_id: string | null
  multiplier: number
  last_popularity: number
  peak_popularity: number
  accumulated_points: number
}

export async function runStakeSnapshot(logger?: {
  info: (o: unknown, m?: string) => void
  error: (o: unknown, m?: string) => void
}): Promise<{ processed: number; removed: number; skipped: number }> {
  const log = logger ?? {
    info: (o: unknown, m?: string) => console.log(m ?? '', o),
    error: (o: unknown, m?: string) => console.error(m ?? '', o),
  }

  if (!supabaseAdmin) {
    log.error({}, 'SUPABASE_SERVICE_ROLE_KEY não configurada — job de stakes abortado')
    return { processed: 0, removed: 0, skipped: 0 }
  }

  // Paginado. Uma leitura sem .range() volta cortada em db-max-rows do
  // PostgREST — sem erro, sem aviso, e o job simplesmente deixa de creditar os
  // stakes que ficaram de fora. Hoje são poucos e o corte nunca bateu; foi
  // exatamente assim que a etapa 3 do Observatório passou uma semana medindo
  // 1.000 faixas com orçamento de 12.000. Ordem pela PK porque a paginação
  // exige ordem total. Ver migration 031.
  const PAGINA = 1_000
  const stakes: StakeRow[] = []
  for (let offset = 0; ; offset += PAGINA) {
    const { data, error } = await supabaseAdmin
      .from('stakes')
      .select(
        'id, deezer_track_id, multiplier, last_popularity, peak_popularity, accumulated_points'
      )
      .eq('status', 'ativa')
      .order('id', { ascending: true })
      .range(offset, offset + PAGINA - 1)

    if (error) {
      log.error({ err: error }, 'Erro ao carregar stakes ativos')
      return { processed: 0, removed: 0, skipped: 0 }
    }

    const lote = (data ?? []) as StakeRow[]
    stakes.push(...lote)
    if (lote.length < PAGINA) break
  }

  let processed = 0
  let removed = 0
  let skipped = 0

  const today = new Date().toISOString().slice(0, 10) // YYYY-MM-DD

  for (const stake of stakes) {
    // Idempotência: se já houve snapshot hoje, não conta de novo
    const { count: snapsToday } = await supabaseAdmin
      .from('stake_snapshots')
      .select('id', { count: 'exact', head: true })
      .eq('stake_id', stake.id)
      .gte('recorded_at', `${today}T00:00:00Z`)

    if ((snapsToday ?? 0) > 0) {
      skipped++
      continue
    }

    // Sem id Deezer (não deveria acontecer em stakes novos): pula
    if (!stake.deezer_track_id) {
      skipped++
      continue
    }

    const rankRes = await getTrackRank(stake.deezer_track_id)

    // Faixa saiu do Deezer → marca como removida (não vale mais), para de medir
    if (rankRes.notFound) {
      await supabaseAdmin
        .from('stakes')
        .update({ status: 'removida', last_checked_at: new Date().toISOString() })
        .eq('id', stake.id)
      removed++
      continue
    }

    // Falha transitória (rede/rate limit): não escreve nada, tenta amanhã
    if (rankRes.rank == null) {
      skipped++
      continue
    }

    const currentPop = popScore(rankRes.rank)
    // Contra o pico, não contra ontem — ver migration 028. `last_popularity`
    // continua sendo gravado (é o "agora" que o card mostra), mas quem decide
    // se rendeu ponto é `peak_popularity`.
    const { dayGain, pointsGain, newPeak } = computePointsGain(
      stake.peak_popularity,
      currentPop,
      Number(stake.multiplier)
    )

    await supabaseAdmin.from('stake_snapshots').insert([
      {
        stake_id: stake.id,
        popularity: currentPop,
        day_gain: dayGain,
        points_gain: pointsGain,
      },
    ])

    await supabaseAdmin
      .from('stakes')
      .update({
        last_popularity: currentPop,
        peak_popularity: newPeak,
        last_day_gain: pointsGain,
        accumulated_points: stake.accumulated_points + pointsGain,
        last_checked_at: new Date().toISOString(),
      })
      .eq('id', stake.id)

    processed++
  }

  log.info({ processed, removed, skipped }, 'Snapshot de stakes concluído')
  return { processed, removed, skipped }
}
