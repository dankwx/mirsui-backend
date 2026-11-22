// src/jobs/artistNeighbors.ts
// Etapa 6 do Observatório: a vizinhança dos artistas (migration 041).
//
// É de onde saem as "Parecidas" da página de faixa. Só SQL, nenhuma requisição
// ao Deezer: soma o que a descoberta já guardou (linhagem, fronteira,
// artist_similarity) e as participações, e grava os 12 vizinhos de cada
// artista que tem página.
//
// Em fases porque o PostgREST corta cada chamada em 8 s (o
// `statement_timeout` do `authenticator` vale para a service role):
//
//   1. as arestas, em duas partes (migration 048)        ~1,2 e ~1,5 s
//   2. os pares, em `lotes` chamadas                     ~1 s cada com 8
//   3. a vizinhança, em `lotes` chamadas                 ~1,7 s cada com 8
//
// (tempos com 561 mil faixas, 22/11/2026). Até a 048 os pares iam numa
// chamada só, e ela estourou os 8 s na rodada de 22/11/2026.
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

  // Fase 1: a parte 0 esvazia a tabela de passagem, a 1 completa. Se uma das
  // duas falhar, a tabela fica pela metade (ou com a noite anterior) e somar
  // dali daria pares errados: para aqui, e a página segue com a vizinhança
  // de ontem.
  for (const parte of [0, 1]) {
    const { error } = await db.rpc('stage_artist_pairs', { p_parte: parte })
    if (error) {
      r.falhas++
      log.error({ err: error, parte }, 'Observatório: falha ao juntar as arestas dos artistas')
      return r
    }
  }

  // Fase 2: cada lote troca só os pares dos artistas dele. Um lote que falha
  // fica com os pares de ontem e não impede os outros nem a vizinhança.
  for (let lote = 0; lote < lotes; lote++) {
    const { data, error } = await db.rpc('rebuild_artist_pairs', {
      p_lote: lote,
      p_lotes: lotes,
    })
    if (error) {
      r.falhas++
      log.error({ err: error, lote, lotes }, 'Observatório: falha ao somar os pares de artistas')
      continue
    }
    r.pares += Number(data) || 0
  }

  // Fase 3, idem: cada lote troca só os artistas dele, e os que falharem
  // ficam com os vizinhos de ontem.
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
