// Expansão controlada do Observatório. Duas fontes, um orçamento.
//
// Decisão e limites: docs/decisions/001-descoberta-controlada-de-faixas.md
//                    docs/decisions/002-descoberta-por-album.md
//
// FONTE A — rádio do artista (ADR 001, inalterada)
//   1 requisição a /artist/{id}/radio, no máximo uma candidata por semente.
//   É semelhança editorial: o que a Deezer acha parecido com o que você já tem.
//
// FONTE B — caminhada por artista relacionado e álbum (ADR 002)
//   /artist/{id}/related dá 20 artistas COM nb_fan; escolhem-se os menos
//   populares; /artist/{id}/albums dá a discografia; /album/{id}/tracks dá 8-14
//   faixas com rank E ISRC por requisição.
//
// POR QUE AS DUAS
// Medido em 16/08/2026, mesmas cinco sementes nos dois caminhos:
//
//   mecanismo          faixas/req   ISRC      rank mediana   rank p90
//   ------------------ ------------ --------- -------------- ----------
//   radio              3,00         0/15      447.301        607.033
//   related -> album   4,65         93/93     38.978         144.526
//
// A caminhada é mais barata, traz ISRC (ou seja: a faixa nasce COM página, e a
// etapa 4 do snapshot não paga nada por ela) e é 11,5x mais obscura. Mas
// ninguém sabe de que faixa de rank sai a faixa que estoura: se o salto típico
// for 400k -> 900k o rádio está certo, se for 39k -> 400k a caminhada está.
// Por isso as duas convivem, o corte é OBS_DESCOBERTA_SPLIT_ALBUM e
// `origin_list` guarda a procedência — em ~60 dias
// `select * from discovery_source_report()` decide o corte com dado em vez de
// palpite.

import type { SupabaseClient } from '@supabase/supabase-js'
import { supabaseAdmin } from '../lib/supabase'
import {
  radioDoArtista,
  relacionadosDoArtista,
  albunsDoArtista,
  faixasDoAlbum,
  type FaixaObservada,
} from '../lib/deezerCatalog'
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
  recommendation_parent_track_id: string | null
  popularity: number
}

/** Uma linha da fronteira: artista alcançado e o quanto dele já foi colhido. */
interface ArtistaDaFronteira {
  deezer_artist_id: string
  artist_name: string | null
  nb_fan: number | null
  seed_track_id: string | null
  next_album_index: number
  albums_total: number | null
}

export interface ConfigDescoberta {
  ativa: boolean
  metaInicial: number
  limiteDiario: number
  maxCatalogo: number
  /** Fração do orçamento da noite que vai para a caminhada por álbum (0 a 1). */
  splitAlbum: number
  /** Teto de fãs para um artista entrar na fronteira. É o dial de obscuridade. */
  maxFas: number
  /** Quantos artistas o /related de cada semente contribui para a fronteira. */
  relacionadosPorSemente: number
  /** Abaixo disto a fronteira é reabastecida com sementes do catálogo. */
  fronteiraMinima: number
  /** Álbuns colhidos por artista por noite, para o orçamento circular. */
  albunsPorArtista: number
}

export interface ResultadoDescoberta {
  catalogoAtivoAntes: number
  orcamento: number
  // --- fonte A: rádio ---
  sementesSelecionadas: number
  sementesProcessadas: number
  artistasConsultados: number
  candidatas: number
  novas: number
  semCandidata: number
  falhasApi: number
  pontos: number
  // --- fonte B: caminhada por álbum ---
  albumAlvo: number
  albumNovas: number
  albumFaixasColhidas: number
  albumRequisicoes: number
  albumArtistasColhidos: number
  albumArtistasExauridos: number
  fronteiraAntes: number
  fronteiraNovos: number
  fronteiraSementes: number
}

export const CONFIG_DESCOBERTA_PADRAO: ConfigDescoberta = {
  ativa: true,
  // O catálogo tinha 3.302 faixas na decisão. A primeira expansão tenta
  // duplicá-lo; depois disso o crescimento passa a ser linear.
  metaInicial: 6_604,
  limiteDiario: 250,
  maxCatalogo: 10_000,
  // 70/30 para a caminhada. Não é meio-termo covarde: a caminhada é a fonte que
  // atende a tese do produto e o rádio fica com participação suficiente para o
  // relatório de fontes ter n comparável em ~60 dias. É um env, não um dogma.
  splitAlbum: 0.7,
  // 50.000 fãs. Acima disso o artista já é conhecido o bastante para chegar
  // sozinho pelo chart ou por alguém salvando.
  maxFas: 50_000,
  relacionadosPorSemente: 3,
  fronteiraMinima: 50,
  albunsPorArtista: 6,
}

const inteiroNaoNegativo = (valor: string | undefined, padrao: number) => {
  if (valor == null || valor.trim() === '') return padrao
  const n = Number(valor)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : padrao
}

const fracao = (valor: string | undefined, padrao: number) => {
  if (valor == null || valor.trim() === '') return padrao
  const n = Number(valor)
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : padrao
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
    splitAlbum: fracao(
      process.env.OBS_DESCOBERTA_SPLIT_ALBUM,
      CONFIG_DESCOBERTA_PADRAO.splitAlbum
    ),
    maxFas: inteiroNaoNegativo(
      process.env.OBS_DESCOBERTA_MAX_FAS,
      CONFIG_DESCOBERTA_PADRAO.maxFas
    ),
    relacionadosPorSemente: inteiroNaoNegativo(
      process.env.OBS_DESCOBERTA_RELACIONADOS,
      CONFIG_DESCOBERTA_PADRAO.relacionadosPorSemente
    ),
    fronteiraMinima: inteiroNaoNegativo(
      process.env.OBS_DESCOBERTA_FRONTEIRA_MIN,
      CONFIG_DESCOBERTA_PADRAO.fronteiraMinima
    ),
    albunsPorArtista: inteiroNaoNegativo(
      process.env.OBS_DESCOBERTA_ALBUNS_POR_ARTISTA,
      CONFIG_DESCOBERTA_PADRAO.albunsPorArtista
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
      .range(offset, offset + pagina - 1)

    if (error) throw error
    const lote = (data ?? []) as { deezer_track_id: string }[]
    ids.push(...lote.map((r) => r.deezer_track_id))
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
  albumAlvo: 0,
  albumNovas: 0,
  albumFaixasColhidas: 0,
  albumRequisicoes: 0,
  albumArtistasColhidos: 0,
  albumArtistasExauridos: 0,
  fronteiraAntes: 0,
  fronteiraNovos: 0,
  fronteiraSementes: 0,
})

// ---------------------------------------------------------------------------
// Fonte B — caminhada por artista relacionado e álbum
// ---------------------------------------------------------------------------
/**
 * Reabastece a fronteira e colhe discografias até bater o alvo de faixas novas.
 *
 * A ordem importa: reabastecer PRIMEIRO significa que a rodada em que a
 * fronteira zera ainda colhe alguma coisa, em vez de perder a noite inteira.
 *
 * Devolve o que gravou. Não lança: falha aqui não pode derrubar o rádio, que é
 * a outra metade do orçamento.
 */
async function caminhadaPorAlbum(
  db: SupabaseClient,
  logger: Log,
  config: ConfigDescoberta,
  alvo: number,
  conhecidas: Set<string>,
  resultado: ResultadoDescoberta
): Promise<void> {
  if (alvo <= 0) return

  const { data: tamanho, error: errTamanho } = await db.rpc('discovery_frontier_size')
  if (errTamanho) throw errTamanho
  resultado.fronteiraAntes = Number(tamanho) || 0

  const novosArtistas: Record<string, unknown>[] = []
  const sementesConsumidas: string[] = []

  // --- 1. Reabastecer a fronteira -----------------------------------------
  // Barato e raro: cada semente rende `relacionadosPorSemente` artistas, e cada
  // artista rende uma discografia inteira. A fronteira só seca de tempos em
  // tempos, então isto normalmente não roda.
  if (resultado.fronteiraAntes < config.fronteiraMinima && config.relacionadosPorSemente > 0) {
    const faltam = config.fronteiraMinima - resultado.fronteiraAntes
    const quantasSementes = Math.ceil(faltam / config.relacionadosPorSemente)
    const sementes = await lerSementes(db, quantasSementes)

    // Uma chamada por ARTISTA, não por faixa: o /related é do artista, então
    // duas sementes do mesmo artista dariam a mesma resposta.
    const porArtista = new Map<string, Semente[]>()
    for (const s of sementes) {
      if (!s.deezer_artist_id) {
        // Sem artista não há /related. Marcar mesmo assim, senão a semente
        // trava a fila para sempre — mesma regra do ADR 001.
        sementesConsumidas.push(s.deezer_track_id)
        continue
      }
      const grupo = porArtista.get(s.deezer_artist_id) ?? []
      grupo.push(s)
      porArtista.set(s.deezer_artist_id, grupo)
    }

    resultado.fronteiraSementes = porArtista.size

    const respostas = await Promise.all(
      [...porArtista.entries()].map(async ([artistId, grupo]) => ({
        artistId,
        grupo,
        ...(await relacionadosDoArtista(artistId)),
      }))
    )

    const jaVistos = new Set<string>()
    for (const { artistId, grupo, artistas, falhou } of respostas) {
      if (falhou) {
        // Falha transitória não queima a semente: ela volta amanhã.
        resultado.falhasApi += grupo.length
        continue
      }
      for (const s of grupo) sementesConsumidas.push(s.deezer_track_id)

      // O dial: só quem está abaixo do teto de fãs, do menos popular para o
      // mais. Acima do teto o artista já chega sozinho por chart ou por save.
      const candidatos = artistas
        .filter((a) => a.nb_fan != null && a.nb_fan <= config.maxFas)
        .sort((x, y) => (x.nb_fan ?? 0) - (y.nb_fan ?? 0))
        .slice(0, config.relacionadosPorSemente)

      for (const a of candidatos) {
        if (jaVistos.has(a.deezer_artist_id)) continue
        jaVistos.add(a.deezer_artist_id)
        novosArtistas.push({
          deezer_artist_id: a.deezer_artist_id,
          artist_name: a.artist_name,
          nb_fan: a.nb_fan,
          parent_artist_id: artistId,
          seed_track_id: grupo[0].deezer_track_id,
          depth: 1,
        })
      }
    }

    // Grava a fronteira ANTES de colher: assim os artistas novos já entram na
    // fila desta mesma noite, e uma falha na colheita não os perde.
    if (novosArtistas.length > 0 || sementesConsumidas.length > 0) {
      const { data, error } = await db.rpc('record_album_expansion', {
        p_rows: [],
        p_parent_ids: sementesConsumidas,
        p_novos_artistas: novosArtistas,
        p_progresso: [],
      })
      if (error) throw error
      resultado.fronteiraNovos = Number((data as { fronteira?: number })?.fronteira) || 0
    }
  }

  // --- 2. Colher a fronteira ----------------------------------------------
  // O teto de requisições é o próprio alvo de faixas. A razão medida é 4,65
  // faixas por requisição, então isto é folgado — existe para o caso
  // patológico do artista com muitos álbuns de uma faixa só, que sem teto
  // gastaria a noite inteira sem chegar ao alvo.
  const maxRequisicoes = alvo
  const fila = await lerFronteira(db, Math.max(1, Math.ceil(alvo / 4)))

  const colhidas: Candidata[] = []
  const progresso: Record<string, unknown>[] = []

  for (const artista of fila) {
    if (colhidas.length >= alvo || resultado.albumRequisicoes >= maxRequisicoes) break

    resultado.albumRequisicoes++
    const { albuns, total, falhou } = await albunsDoArtista(
      artista.deezer_artist_id,
      artista.next_album_index,
      config.albunsPorArtista
    )

    if (falhou) {
      resultado.falhasApi++
      continue
    }

    // Página vazia = discografia acabou. Sem marcar, o artista voltaria à fila
    // todas as noites pedindo a mesma página vazia, para sempre.
    if (albuns.length === 0) {
      progresso.push({
        deezer_artist_id: artista.deezer_artist_id,
        next_album_index: artista.next_album_index,
        albums_total: total,
        exhausted: true,
      })
      resultado.albumArtistasExauridos++
      continue
    }

    // Compilação é ruído: repete faixa que já veio pelo álbum original, com id
    // diferente, e infla o catálogo sem trazer nada. As demais vêm em ordem de
    // lançamento (mais recente primeiro), que é o viés certo — lançamento novo
    // de artista pequeno é onde a tese "achar antes de estourar" mora.
    const uteis = albuns.filter((a) => a.record_type !== 'compilation')

    const faixasPorAlbum = await Promise.all(
      uteis.map(async (album) => ({ album, ...(await faixasDoAlbum(album.deezer_album_id)) }))
    )
    resultado.albumRequisicoes += uteis.length

    for (const { album, faixas, falhou: falhouAlbum } of faixasPorAlbum) {
      if (falhouAlbum) {
        resultado.falhasApi++
        continue
      }
      for (const f of faixas) {
        // O mesmo filtro que record_observations aplica no SQL. Aplicado aqui
        // também para a contagem do log bater com o que o banco gravou.
        if (!f.title || !f.artist_name || f.rank == null) continue
        resultado.albumFaixasColhidas++
        if (conhecidas.has(f.deezer_track_id)) continue
        conhecidas.add(f.deezer_track_id)

        colhidas.push({
          deezer_track_id: f.deezer_track_id,
          deezer_artist_id: f.deezer_artist_id,
          deezer_album_id: album.deezer_album_id,
          isrc: f.isrc,
          title: f.title,
          artist_name: f.artist_name,
          album_name: album.title,
          cover_md5: album.cover_md5,
          genre: null,
          source_list: `album:${album.deezer_album_id}`,
          rank: f.rank,
          // A linhagem aponta para a faixa do catálogo que levou até este
          // artista. `null` quando a faixa colhida É a semente: a constraint
          // observed_tracks_recommendation_not_self proíbe apontar para si.
          recommendation_parent_track_id:
            artista.seed_track_id && artista.seed_track_id !== f.deezer_track_id
              ? artista.seed_track_id
              : null,
          popularity: popScore(f.rank),
        })
      }
    }

    const consumidos = artista.next_album_index + albuns.length
    progresso.push({
      deezer_artist_id: artista.deezer_artist_id,
      next_album_index: consumidos,
      albums_total: total,
      exhausted: consumidos >= total,
    })
    resultado.albumArtistasColhidos++
    if (consumidos >= total) resultado.albumArtistasExauridos++
  }

  // --- 3. Gravar ------------------------------------------------------------
  if (colhidas.length === 0 && progresso.length === 0) return

  const { data, error } = await db.rpc('record_album_expansion', {
    p_rows: colhidas,
    p_parent_ids: [],
    p_novos_artistas: [],
    p_progresso: progresso,
  })
  if (error) throw error

  const gravado = (data ?? {}) as { novas?: number; pontos?: number }
  resultado.albumNovas = Number(gravado.novas) || 0
  resultado.pontos += Number(gravado.pontos) || 0

  logger.info(
    {
      alvo,
      fronteiraAntes: resultado.fronteiraAntes,
      fronteiraNovos: resultado.fronteiraNovos,
      artistas: resultado.albumArtistasColhidos,
      exauridos: resultado.albumArtistasExauridos,
      requisicoes: resultado.albumRequisicoes,
      colhidas: resultado.albumFaixasColhidas,
      novas: resultado.albumNovas,
    },
    'Descoberta: caminhada por álbum concluída'
  )
}

async function lerFronteira(db: SupabaseClient, limite: number): Promise<ArtistaDaFronteira[]> {
  const { data, error } = await db.rpc('discovery_artist_queue', { p_limite: limite })
  if (error) throw error
  return ((data ?? []) as ArtistaDaFronteira[]).map((a) => ({
    ...a,
    next_album_index: Number(a.next_album_index) || 0,
    albums_total: a.albums_total == null ? null : Number(a.albums_total),
  }))
}

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

  // O corte do orçamento entre as duas fontes. `conhecidas` é compartilhada de
  // propósito: as duas fontes competem pelo mesmo catálogo, e uma faixa que a
  // caminhada acabou de trazer não pode ser contada de novo pelo rádio.
  resultado.albumAlvo = Math.round(orcamento * config.splitAlbum)
  let alvoRadio = orcamento - resultado.albumAlvo

  const todosIds = await lerTodosIds(db)
  const conhecidas = new Set(todosIds)

  try {
    await caminhadaPorAlbum(db, logger, config, resultado.albumAlvo, conhecidas, resultado)
  } catch (err) {
    // Não propaga: o rádio é a outra metade do orçamento e não tem culpa.
    resultado.falhasApi++
    logger.error({ err }, 'Descoberta: caminhada por álbum falhou')
  }

  // O orçamento que a caminhada não gastou volta para o rádio, tenha ela
  // falhado ou apenas ficado sem fronteira. Sem isto, o dia em que a 026 ainda
  // não está aplicada — ou em que o Deezer devolve erro — perde 70% da
  // descoberta em silêncio, e a única pista seria uma linha de erro no meio do
  // log. O orçamento é do OBSERVATÓRIO, não de um mecanismo.
  const sobra = Math.max(0, resultado.albumAlvo - resultado.albumNovas)
  if (sobra > 0) {
    alvoRadio += sobra
    logger.info(
      { albumAlvo: resultado.albumAlvo, albumNovas: resultado.albumNovas, devolvido: sobra },
      'Descoberta: sobra da caminhada devolvida ao rádio'
    )
  }

  if (alvoRadio <= 0) {
    logger.info(resultado, 'Descoberta: expansão controlada concluída')
    return resultado
  }

  // -------------------------------------------------------------------------
  // Fonte A — rádio do artista (ADR 001)
  // -------------------------------------------------------------------------
  const sementes = await lerSementes(db, alvoRadio)
  resultado.sementesSelecionadas = sementes.length

  if (sementes.length === 0) {
    logger.info({ orcamento: alvoRadio }, 'Descoberta: nenhuma semente pendente')
    return resultado
  }

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
