// src/jobs/artistNeighbors.ts
// Etapa 6 do Observatório: a vizinhança dos artistas (migration 041).
//
// É de onde saem as "Parecidas" da página de faixa. Só SQL, nenhuma requisição
// ao Deezer: soma o que a descoberta já guardou (linhagem, fronteira,
// artist_similarity) e as participações, e grava os 12 vizinhos de cada
// artista que tem página.
//
// Duas fases porque o PostgREST corta cada chamada em 8 s (o
// `statement_timeout` do `authenticator` vale para a service role). Numa
// chamada só, o catálogo de 25/09/2026 levava 4,0 s, e ele vai a 500 mil
// faixas. Os pares vão numa chamada (0,7 s em 25/09) e a vizinhança em
// `lotes` chamadas (~0,4 s cada com 8).
//
// Fica num módulo próprio porque roda em dois lugares: no fim da rodada e
// avulsa (src/scripts/runVizinhanca.ts).

import type { SupabaseClient } from '@supabase/supabase-js'

export interface ResultadoVizinhanca {
  /** pares de artistas somados, nos dois sentidos */
  pares: number
  /** artistas que saíram com pelo menos um vizinho */
  artistas: number
  /** vizinhos diretos gravados */
  diretos: number
  /** vizinhos de segundo salto gravados, para completar quem tinha menos de 6 */
  segundo: number
  lotes: number
  falhas: number
}

interface Log {
  info: (o: unknown, m?: string) => void
  error: (o: unknown, m?: string) => void
}

export async function remontarVizinhanca(
  db: SupabaseClient,
  lotes: number,
  log: Log
): Promise<ResultadoVizinhanca> {
  const r: ResultadoVizinhanca = {
    pares: 0,
    artistas: 0,
    diretos: 0,
    segundo: 0,
    lotes: 0,
    falhas: 0,
  }
  if (!(lotes > 0)) return r

  const { data: pares, error: errPares } = await db.rpc('rebuild_artist_pairs')
  if (errPares) {
    // A transação volta inteira: a página segue com a vizinhança de ontem.
    r.falhas++
    log.error({ err: errPares }, 'Observatório: falha ao somar os pares de artistas')
    return r
  }
  r.pares = Number(pares) || 0

  // Um lote que falha não impede os outros: cada um troca só os artistas dele,
  // e os que falharem ficam com os vizinhos de ontem.
  for (let lote = 0; lote < lotes; lote++) {
    const { data, error } = await db.rpc('rebuild_artist_neighbors', {
      p_lote: lote,
      p_lotes: lotes,
    })
    if (error) {
      r.falhas++
      log.error({ err: error, lote, lotes }, 'Observatório: falha num lote da vizinhança')
      continue
    }
    const d = (data ?? {}) as { artistas?: number; diretos?: number; segundo?: number }
    r.artistas += Number(d.artistas) || 0
    r.diretos += Number(d.diretos) || 0
    r.segundo += Number(d.segundo) || 0
    r.lotes++
  }

  return r
}
