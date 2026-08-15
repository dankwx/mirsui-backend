// Expansão controlada do Observatório por rádio de artista do Deezer.
//
// Decisão e limites: docs/decisions/001-descoberta-controlada-de-faixas.md

import type { SupabaseClient } from '@supabase/supabase-js'
import { supabaseAdmin } from '../lib/supabase'
import { radioDoArtista, type FaixaObservada } from '../lib/deezerCatalog'
import { popScore } from '../lib/stakePoints'

interface Log {
  info: (o: unknown, m?: string) => void
  error: (o: unknown, m?: string) => void
  warn?: (o: unknown, m?: string) => void
}

interface Semente {
  deezer_track_id: string
  deezer_artist_id: string | null
}

interface Candidata extends FaixaObservada {
  recommendation_parent_track_id: string
  popularity: number
}

export interface ConfigDescoberta {
  ativa: boolean
  metaInicial: number
  limiteDiario: number
  maxCatalogo: number
}

export interface ResultadoDescoberta {
  catalogoAtivoAntes: number
  orcamento: number
  sementesSelecionadas: number
  sementesProcessadas: number
  artistasConsultados: number
  candidatas: number
  novas: number
  semCandidata: number
  falhasApi: number
  pontos: number
}

export const CONFIG_DESCOBERTA_PADRAO: ConfigDescoberta = {
  ativa: true,
  // O catálogo tinha 3.302 faixas na decisão. A primeira expansão tenta
  // duplicá-lo; depois disso o crescimento passa a ser linear.
  metaInicial: 6_604,
  limiteDiario: 250,
  maxCatalogo: 10_000,
}

const inteiroNaoNegativo = (valor: string | undefined, padrao: number) => {
  if (valor == null || valor.trim() === '') return padrao
  const n = Number(valor)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : padrao
}

const booleano = (valor: string | undefined, padrao: boolean) => {
  if (valor == null || valor.trim() === '') return padrao
  if (['0', 'false', 'nao', 'não', 'off'].includes(valor.trim().toLowerCase())) return false
  if (['1', 'true', 'sim', 'on'].includes(valor.trim().toLowerCase())) return true
  return padrao
}

export function configDescobertaDoAmbiente(): ConfigDescoberta {
  return {
    ativa: booleano(process.env.OBS_DESCOBERTA_ATIVA, CONFIG_DESCOBERTA_PADRAO.ativa),
    metaInicial: inteiroNaoNegativo(
      process.env.OBS_DESCOBERTA_META_INICIAL,
      CONFIG_DESCOBERTA_PADRAO.metaInicial
    ),
    limiteDiario: inteiroNaoNegativo(
      process.env.OBS_LIMITE_DESCOBERTA,
      CONFIG_DESCOBERTA_PADRAO.limiteDiario
    ),
    maxCatalogo: inteiroNaoNegativo(
      process.env.OBS_MAX_CATALOGO,
      CONFIG_DESCOBERTA_PADRAO.maxCatalogo
    ),
  }
}

/** Crescimento inicial até a meta; depois, crescimento linear até o teto. */
export function calcularOrcamentoDescoberta(
  catalogoAtivo: number,
  config: ConfigDescoberta
): number {
  if (!config.ativa || catalogoAtivo >= config.maxCatalogo) return 0

  const espaco = Math.max(0, config.maxCatalogo - catalogoAtivo)
  const limiteDaFase =
    catalogoAtivo < config.metaInicial
      ? Math.max(0, config.metaInicial - catalogoAtivo)
      : config.limiteDiario

  return Math.min(espaco, limiteDaFase)
}

async function lerTodosIds(db: SupabaseClient): Promise<string[]> {
  const ids: string[] = []
  const pagina = 1_000

  for (let offset = 0; ; offset += pagina) {
    const { data, error } = await db
      .from('observed_tracks')
      .select('deezer_track_id')
      .order('deezer_track_id', { ascending: true })
      .range(offset, offset + pagina - 1)

    if (error) throw error
    const lote = (data ?? []) as { deezer_track_id: string }[]
    ids.push(...lote.map((r) => String(r.deezer_track_id)))
    if (lote.length < pagina) break
  }

  return ids
}

async function lerSementes(db: SupabaseClient, limite: number): Promise<Semente[]> {
  const sementes: Semente[] = []
  const pagina = 1_000

  for (let offset = 0; offset < limite; offset += pagina) {
    const tamanho = Math.min(pagina, limite - offset)
    const { data, error } = await db
      .from('observed_tracks')
      .select('deezer_track_id, deezer_artist_id')
      .eq('active', true)
      .is('recommendation_checked_at', null)
      .order('added_at', { ascending: true })
      .order('deezer_track_id', { ascending: true })
      .range(offset, offset + tamanho - 1)

    if (error) throw error
    const lote = (data ?? []) as Semente[]
    sementes.push(...lote)
    if (lote.length < tamanho) break
  }

  return sementes
}

const vazio = (catalogoAtivoAntes = 0, orcamento = 0): ResultadoDescoberta => ({
  catalogoAtivoAntes,
  orcamento,
  sementesSelecionadas: 0,
  sementesProcessadas: 0,
  artistasConsultados: 0,
  candidatas: 0,
  novas: 0,
  semCandidata: 0,
  falhasApi: 0,
  pontos: 0,
})

export async function runCatalogDiscovery(
  logger: Log,
  config = configDescobertaDoAmbiente()
): Promise<ResultadoDescoberta> {
  if (!supabaseAdmin) {
    logger.error({}, 'SUPABASE_SERVICE_ROLE_KEY não configurada — descoberta abortada')
    return vazio()
  }
  const db = supabaseAdmin

  const { count, error: erroContagem } = await db
    .from('observed_tracks')
    .select('deezer_track_id', { count: 'exact', head: true })
    .eq('active', true)
  if (erroContagem) throw erroContagem

  const catalogoAtivoAntes = count ?? 0
  const orcamento = calcularOrcamentoDescoberta(catalogoAtivoAntes, config)
  const resultado = vazio(catalogoAtivoAntes, orcamento)

  if (orcamento === 0) {
    logger.info(
      { catalogoAtivo: catalogoAtivoAntes, maxCatalogo: config.maxCatalogo },
      config.ativa
        ? 'Descoberta: teto do catálogo atingido'
        : 'Descoberta: etapa desativada'
    )
    return resultado
  }

  const [todosIds, sementes] = await Promise.all([
    lerTodosIds(db),
    lerSementes(db, orcamento),
  ])
  resultado.sementesSelecionadas = sementes.length

  if (sementes.length === 0) {
    logger.info({ orcamento }, 'Descoberta: nenhuma semente pendente')
    return resultado
  }

  const conhecidas = new Set(todosIds)
  const semArtista: Semente[] = []
  const porArtista = new Map<string, Semente[]>()

  for (const semente of sementes) {
    if (!semente.deezer_artist_id) {
      semArtista.push(semente)
      continue
    }
    const grupo = porArtista.get(semente.deezer_artist_id) ?? []
    grupo.push(semente)
    porArtista.set(semente.deezer_artist_id, grupo)
  }

  resultado.artistasConsultados = porArtista.size

  // Todas podem nascer juntas: deezerCatalog.ts controla a taxa e o número de
  // requisições em voo. A alocação das candidatas é feita depois, em ordem,
  // para duas sementes nunca escolherem a mesma faixa.
  const radios = await Promise.all(
    [...porArtista.entries()].map(async ([artistId, grupo]) => ({
      artistId,
      grupo,
      radio: await radioDoArtista(artistId, Math.max(15, grupo.length * 2)),
    }))
  )

  const candidatas: Candidata[] = []
  const paisMarcados: string[] = semArtista.map((s) => s.deezer_track_id)
  resultado.semCandidata += semArtista.length

  for (const { grupo, radio } of radios) {
    if (radio.falhou) {
      // Falha transitória não queima a semente: ela volta à fila amanhã.
      resultado.falhasApi += grupo.length
      continue
    }

    const pool = new Map(radio.faixas.map((faixa) => [faixa.deezer_track_id, faixa]))

    for (const semente of grupo) {
      paisMarcados.push(semente.deezer_track_id)
      let escolhida: FaixaObservada | undefined

      for (const faixa of pool.values()) {
        if (conhecidas.has(faixa.deezer_track_id)) continue
        escolhida = faixa
        break
      }

      if (!escolhida) {
        resultado.semCandidata++
        continue
      }

      conhecidas.add(escolhida.deezer_track_id)
      pool.delete(escolhida.deezer_track_id)
      candidatas.push({
        ...escolhida,
        recommendation_parent_track_id: semente.deezer_track_id,
        popularity: popScore(escolhida.rank),
      })
    }
  }

  resultado.sementesProcessadas = paisMarcados.length
  resultado.candidatas = candidatas.length

  const porPai = new Map(
    candidatas.map((candidata) => [candidata.recommendation_parent_track_id, candidata])
  )

  // Cada lote é uma transação: insere faixas/histórico e só então marca os
  // respectivos pais. Uma queda perde no máximo 500 sementes, que ficam para
  // a próxima rodada em vez de serem silenciosamente descartadas.
  const lote = 500
  for (let i = 0; i < paisMarcados.length; i += lote) {
    const pais = paisMarcados.slice(i, i + lote)
    const linhas = pais.flatMap((pai) => {
      const candidata = porPai.get(pai)
      return candidata ? [candidata] : []
    })

    const { data, error } = await db.rpc('record_recommendation_expansion', {
      p_rows: linhas,
      p_parent_ids: pais,
    })
    if (error) throw error

    const gravado = (data ?? {}) as { novas?: number; pontos?: number }
    resultado.novas += Number(gravado.novas) || 0
    resultado.pontos += Number(gravado.pontos) || 0
  }

  logger.info(resultado, 'Descoberta: expansão controlada concluída')
  return resultado
}
