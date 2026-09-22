// src/jobs/albumDetails.ts
// Etapa 4b do Observatório: gênero e data que faltam — a ficha da página de
// faixa (migration 037).
//
// Desde a 037 a página de faixa sai do banco, sem perguntar ao Deezer na
// visita. O gênero mora no álbum, e só o chart o traz de graça: a faixa que
// entrou por rádio ou pelo acervo chega sem ele, e a data só vem de
// /track/{id}. Uma requisição a /album/{id} resolve as duas coisas para todas
// as faixas do álbum de uma vez.
//
// A fila é "nunca perguntei", como a do ISRC: álbum sem gênero no Deezer é
// marcado e sai, em vez de voltar toda noite.
//
// Fica num módulo próprio porque roda em dois lugares: dentro da rodada, com
// o teto da noite, e avulsa (src/scripts/runFichaDosAlbuns.ts) para adiantar a
// varredura inicial — em 22/09/2026 eram 35.348 álbuns na fila.

import type { SupabaseClient } from '@supabase/supabase-js'
import { fichaDoAlbum } from '../lib/deezerCatalog'

export interface ResultadoFicha {
  /** álbuns na fila antes de começar */
  fila: number
  consultados: number
  /** faixas que receberam a marca (e o que o álbum tinha para dar) */
  faixas: number
  falhas: number
}

interface Log {
  info: (o: unknown, m?: string) => void
  error: (o: unknown, m?: string) => void
}

const PAGINA = 1000
const BLOCO = 100

export async function preencherFichaDosAlbuns(
  db: SupabaseClient,
  limite: number,
  log: Log
): Promise<ResultadoFicha> {
  const r: ResultadoFicha = { fila: 0, consultados: 0, faixas: 0, falhas: 0 }
  if (!(limite > 0)) return r

  const { data: tamanho, error: errTamanho } = await db.rpc('album_details_queue_size')
  if (errTamanho) throw errTamanho
  r.fila = Number(tamanho) || 0

  // Paginada pelo .range(): o PostgREST corta toda resposta em 1.000 linhas,
  // e a ordem total que isso exige está na própria função (migration 037).
  // As marcas só são gravadas depois da leitura inteira, então o offset não
  // se desloca.
  const albuns: string[] = []
  for (let offset = 0; offset < limite; offset += PAGINA) {
    const pedaco = Math.min(PAGINA, limite - offset)
    const { data, error } = await db
      .rpc('album_details_queue', { p_limite: limite })
      .range(offset, offset + pedaco - 1)
    if (error) throw error
    const lote = (data ?? []) as { deezer_album_id: string }[]
    albuns.push(...lote.map((a) => a.deezer_album_id))
    if (lote.length < pedaco) break
  }

  for (let i = 0; i < albuns.length; i += BLOCO) {
    const bloco = albuns.slice(i, i + BLOCO)
    const respostas = await Promise.all(
      bloco.map(async (id) => ({ deezer_album_id: id, ...(await fichaDoAlbum(id)) }))
    )
    r.consultados += bloco.length
    // Falha passageira não marca: o álbum volta amanhã.
    const linhas = respostas
      .filter((x) => !x.falhou)
      .map(({ deezer_album_id, genero, release_date }) => ({ deezer_album_id, genre: genero, release_date }))
    if (linhas.length === 0) continue
    const { data, error } = await db.rpc('record_album_details', { p_rows: linhas })
    if (error) {
      r.falhas++
      log.error({ err: error, tamanho: linhas.length }, 'Falha ao gravar a ficha dos álbuns')
      continue
    }
    r.faixas += Number(data) || 0
  }

  log.info({ ...r, limite }, 'Observatório: gênero e data dos álbuns preenchidos')
  return r
}
