// src/jobs/cravadaSnapshot.ts
// Job diário: mede a popularidade atual de cada cravada ativa no Spotify,
// registra um snapshot e acumula os pontos (ganho * multiplicador travado).
// Roda com service role (lê cravadas de TODOS os usuários) — ver Cravada.md.

import { supabaseAdmin } from '../lib/supabase'
import { getTrackRank } from '../lib/deezer'
import { computePointsGain, popScore } from '../lib/cravadaPoints'

interface CravadaRow {
  id: string
  deezer_track_id: string | null
  multiplier: number
  last_popularity: number
  accumulated_points: number
}

export async function runCravadaSnapshot(logger?: {
  info: (o: unknown, m?: string) => void
  error: (o: unknown, m?: string) => void
}): Promise<{ processed: number; removed: number; skipped: number }> {
  const log = logger ?? {
    info: (o: unknown, m?: string) => console.log(m ?? '', o),
    error: (o: unknown, m?: string) => console.error(m ?? '', o),
  }

  if (!supabaseAdmin) {
    log.error({}, 'SUPABASE_SERVICE_ROLE_KEY não configurada — job de cravadas abortado')
    return { processed: 0, removed: 0, skipped: 0 }
  }

  const { data: cravadas, error } = await supabaseAdmin
    .from('cravadas')
    .select('id, deezer_track_id, multiplier, last_popularity, accumulated_points')
    .eq('status', 'ativa')

  if (error) {
    log.error({ err: error }, 'Erro ao carregar cravadas ativas')
    return { processed: 0, removed: 0, skipped: 0 }
  }

  let processed = 0
  let removed = 0
  let skipped = 0

  const today = new Date().toISOString().slice(0, 10) // YYYY-MM-DD

  for (const cravada of (cravadas ?? []) as CravadaRow[]) {
    // Idempotência: se já houve snapshot hoje, não conta de novo
    const { count: snapsToday } = await supabaseAdmin
      .from('cravada_snapshots')
      .select('id', { count: 'exact', head: true })
      .eq('cravada_id', cravada.id)
      .gte('recorded_at', `${today}T00:00:00Z`)

    if ((snapsToday ?? 0) > 0) {
      skipped++
      continue
    }

    // Sem id Deezer (não deveria acontecer em cravadas novas): pula
    if (!cravada.deezer_track_id) {
      skipped++
      continue
    }

    const rankRes = await getTrackRank(cravada.deezer_track_id)

    // Faixa saiu do Deezer → marca como removida (não vale mais), para de medir
    if (rankRes.notFound) {
      await supabaseAdmin
        .from('cravadas')
        .update({ status: 'removida', last_checked_at: new Date().toISOString() })
        .eq('id', cravada.id)
      removed++
      continue
    }

    // Falha transitória (rede/rate limit): não escreve nada, tenta amanhã
    if (rankRes.rank == null) {
      skipped++
      continue
    }

    const currentPop = popScore(rankRes.rank)
    const { dayGain, pointsGain } = computePointsGain(
      cravada.last_popularity,
      currentPop,
      Number(cravada.multiplier)
    )

    await supabaseAdmin.from('cravada_snapshots').insert([
      {
        cravada_id: cravada.id,
        popularity: currentPop,
        day_gain: dayGain,
        points_gain: pointsGain,
      },
    ])

    await supabaseAdmin
      .from('cravadas')
      .update({
        last_popularity: currentPop,
        last_day_gain: pointsGain,
        accumulated_points: cravada.accumulated_points + pointsGain,
        last_checked_at: new Date().toISOString(),
      })
      .eq('id', cravada.id)

    processed++
  }

  log.info({ processed, removed, skipped }, 'Snapshot de cravadas concluído')
  return { processed, removed, skipped }
}
