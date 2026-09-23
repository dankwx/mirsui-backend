// src/jobs/artistDetails.ts
// Etapa 4c do Observatório: a ficha da página de artista (migration 040).
//
// A 038 tirou do Deezer a página dos artistas do catálogo, mas com o que o
// catálogo tinha: as faixas medidas. Sem foto, sem fãs, sem discografia. Esta
// etapa guarda o que a página pedia a cada visita — /artist/{id}, /top e
// /albums — uma vez por artista, e de novo quando a ficha passa de
// OBS_FICHA_ARTISTA_DIAS.
//
// A fila começa por quem tem faixa salva, segue pelo artista mais ouvido e
// termina nos convidados (feat.), que são o destino dos links "com X".
//
// Fica num módulo próprio porque roda em dois lugares: dentro da rodada, com
// o teto da noite, e avulsa (src/scripts/runFichaDosArtistas.ts).

import type { SupabaseClient } from '@supabase/supabase-js'
import { fichaDoArtista } from '../lib/deezerCatalog'

export interface ResultadoFichaArtista {
  /** artistas na fila antes de começar (sem ficha ou com ficha vencida) */
  fila: number
  consultados: number
  /** fichas gravadas, incluindo as de artistas que saíram do Deezer */
  gravados: number
  /** artistas que o Deezer diz não existir mais */
  inexistentes: number
  /** artistas que ficaram para amanhã por falha do Deezer */
  adiados: number
  falhas: number
}

interface Log {
  info: (o: unknown, m?: string) => void
  error: (o: unknown, m?: string) => void
}

const PAGINA = 1000
// Até 50 requisições na fila do gateway por bloco (a primeira de cada artista
// vai sozinha). É o gateway que dita o ritmo; o bloco só mantém a fila cheia
// e limita o que se perde se a gravação de um lote falhar.
const BLOCO = 25

export async function preencherFichaDosArtistas(
  db: SupabaseClient,
  limite: number,
  dias: number,
  log: Log
): Promise<ResultadoFichaArtista> {
  const r: ResultadoFichaArtista = {
    fila: 0,
    consultados: 0,
    gravados: 0,
    inexistentes: 0,
    adiados: 0,
    falhas: 0,
  }
  if (!(limite > 0)) return r

  const { data: tamanho, error: errTamanho } = await db.rpc('artist_details_queue_size', {
    p_dias: dias,
  })
  if (errTamanho) throw errTamanho
  r.fila = Number(tamanho) || 0

  // Paginada pelo .range(), com a ordem total na própria função (040). As
  // fichas só são gravadas depois da leitura inteira, então o offset não se
  // desloca.
  const artistas: string[] = []
  for (let offset = 0; offset < limite; offset += PAGINA) {
    const pedaco = Math.min(PAGINA, limite - offset)
    const { data, error } = await db
      .rpc('artist_details_queue', { p_limite: limite, p_dias: dias })
      .range(offset, offset + pedaco - 1)
    if (error) throw error
    const lote = (data ?? []) as { deezer_artist_id: string }[]
    artistas.push(...lote.map((a) => a.deezer_artist_id))
    if (lote.length < pedaco) break
  }

  for (let i = 0; i < artistas.length; i += BLOCO) {
    const bloco = artistas.slice(i, i + BLOCO)
    const fichas = await Promise.all(
      bloco.map(async (id) => ({ deezer_artist_id: id, ...(await fichaDoArtista(id)) }))
    )
    r.consultados += bloco.length

    // Falha passageira não grava: a ficha antiga (se houver) continua valendo
    // e o artista volta amanhã.
    const linhas = fichas.flatMap(({ falhou, inexistente, ...f }) => {
      if (falhou) {
        r.adiados++
        return []
      }
      if (inexistente) {
        r.inexistentes++
        return [{ deezer_artist_id: f.deezer_artist_id, missing: true }]
      }
      return [{ ...f, missing: false }]
    })
    if (linhas.length === 0) continue

    const { data, error } = await db.rpc('record_artist_details', { p_rows: linhas })
    if (error) {
      r.falhas++
      log.error({ err: error, tamanho: linhas.length }, 'Falha ao gravar a ficha dos artistas')
      continue
    }
    r.gravados += Number(data) || 0
  }

  log.info({ ...r, limite, dias }, 'Observatório: ficha dos artistas preenchida')
  return r
}
