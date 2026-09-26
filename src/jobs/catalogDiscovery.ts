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
//
// O QUE SOBRA DAS RESPOSTAS (migration 041)
// Cada rádio traz ~15 faixas de vários artistas e cada /related traz 20
// artistas; a descoberta usa uma faixa e três artistas. O resto vai para
// `artist_similarity`, de onde a rodada monta as "Parecidas" da página de
// faixa. Zero requisições a mais: é a mesma resposta, guardada inteira.
//
// GÊNEROS FORA DA COLETA (25/09/2026)
// Música clássica não entra mais por coleta automática, só por save. Contado
// nesse dia: 26.921 faixas clássicas ativas (21% do catálogo), nenhuma salva
// por ninguém; 88% vieram da caminhada, 11% do rádio, 1% do chart 98. O ciclo
// se alimentava sozinho: faixa clássica vira semente, o /related e o rádio
// dela devolvem mais clássica. Ver GENEROS_FORA_DA_COLETA.

import type { SupabaseClient } from '@supabase/supabase-js'
import { supabaseAdmin } from '../lib/supabase'
import {
  radioDoArtista,
  relacionadosDoArtista,
  albunsDoArtista,
  faixasDoAlbum,
  listarGeneros,
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
  /** álbuns de gênero fora da coleta que a caminhada deixou de colher */
  albunsForaDoGenero: number
  /** artistas esgotados porque a página inteira era de gênero fora */
  artistasForaDoGenero: number
  // --- o que sobrou das respostas (041) ---
  /** pares de artistas gravados em artist_similarity, das duas fontes */
  semelhancas: number
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

/**
 * Gêneros que a coleta automática não traz. O save de um usuário continua
 * trazendo: a etapa 2 do snapshot (acervo) não passa por aqui.
 *
 * O id é o do Deezer, que é o que o chart e a discografia trazem. O nome é o
 * que fica em `observed_tracks.genre` (o vocabulário de /genre), e é por ele
 * que a faixa já catalogada deixa de ser semente.
 *
 * O filtro tem três pontos, porque são três portas de entrada:
 *   chart      o chart do gênero sai da varredura (catalogSnapshot.ts)
 *   caminhada  o álbum do gênero não é colhido; página inteira dele esgota
 *              o artista (separarPorGenero)
 *   sementes   faixa do gênero não vira semente, nem do rádio nem da
 *              fronteira (lerSementes)
 * O rádio não traz gênero, então a faixa de rádio só é barrada pela semente.
 * Medido em 25/09/2026: 86% da clássica vinda do rádio tinha semente clássica.
 */
export const GENEROS_FORA_DA_COLETA: readonly { id: number; nome: string }[] = [
  { id: 98, nome: 'Clássica' },
]

const idsForaDaColeta = new Set(GENEROS_FORA_DA_COLETA.map((g) => g.id))

/**
 * Divide uma página da discografia em álbuns a colher e álbuns de gênero fora
 * da coleta. Álbum sem gênero é colhido: não saber não é motivo para barrar.
 *
 * `artistaFora` = a página tinha o que colher e era toda de gênero fora. É o
 * artista clássico: esgotá-lo agora custa a página que já foi paga, em vez de
 * uma requisição por noite até o fim de uma discografia que nunca vai render.
 */
export function separarPorGenero<A extends { genre_id: number | null }>(
  albuns: A[]
): { colher: A[]; fora: A[]; artistaFora: boolean } {
  const colher: A[] = []
  const fora: A[] = []
  for (const a of albuns) {
    if (a.genre_id != null && idsForaDaColeta.has(a.genre_id)) fora.push(a)
    else colher.push(a)
  }
  return { colher, fora, artistaFora: fora.length > 0 && colher.length === 0 }
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
      // Ordem explícita, e pela PK. Sem order by o Postgres não promete ordem
      // nenhuma ENTRE duas execuções, e cada página aqui é uma requisição
      // separada — as 16 páginas de hoje podiam repetir e pular id à vontade.
      // Um id que a paginação pula sai deste Set, e a descoberta trata a faixa
      // como nova: gasta requisição no Deezer para reinserir o que já existe.
      .order('deezer_track_id', { ascending: true })
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
      // Semente de gênero fora da coleta traria mais do mesmo gênero. Ela fica
      // na fila sem ser marcada, e volta a valer se o gênero sair da lista. O
      // `is.null` é obrigatório: `not in` sozinho descartaria a faixa sem
      // gênero, que é quase todo o rádio da noite anterior.
      .or(`genre.is.null,genre.not.in.(${GENEROS_FORA_DA_COLETA.map((g) => `"${g.nome}"`).join(',')})`)
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
  albunsForaDoGenero: 0,
  artistasForaDoGenero: 0,
  semelhancas: 0,
})

/** Uma linha de `artist_similarity` (migration 041). */
export interface LinhaDeSemelhanca {
  deezer_artist_id: string
  similar_artist_id: string
  source: 'related' | 'radio'
  /** a ordem na resposta, contando só artistas distintos (0 = o primeiro) */
  position: number
}

/**
 * O que uma resposta do Deezer diz sobre quem se parece com `artistId`.
 *
 * O rádio mistura faixas do próprio artista com as dos parecidos, e o mesmo
 * artista aparece em várias faixas: fica a primeira aparição de cada um, sem o
 * próprio. No /related a ordem é a do Deezer, que põe o mais parecido antes.
 */
export function linhasDeSemelhanca(
  artistId: string,
  source: LinhaDeSemelhanca['source'],
  ids: (string | null | undefined)[]
): LinhaDeSemelhanca[] {
  const vistos = new Set<string>()
  const linhas: LinhaDeSemelhanca[] = []
  for (const id of ids) {
    if (!id || id === artistId || vistos.has(id)) continue
    vistos.add(id)
    linhas.push({
      deezer_artist_id: artistId,
      similar_artist_id: id,
      source,
      position: linhas.length,
    })
  }
  return linhas
}

/**
 * Grava o que sobrou das respostas. Nunca lança: é um subproduto, e perder a
 * semelhança de uma noite não pode custar a descoberta dela. Sem a 041
 * aplicada a RPC não existe e isto só registra o erro.
 */
async function gravarSemelhancas(
  db: SupabaseClient,
  logger: Log,
  linhas: LinhaDeSemelhanca[]
): Promise<number> {
  let gravadas = 0
  for (let i = 0; i < linhas.length; i += 1_000) {
    const { data, error } = await db.rpc('record_artist_similarity', {
      p_rows: linhas.slice(i, i + 1_000),
    })
    if (error) {
      logger.error({ err: error, linhas: linhas.length }, 'Descoberta: falha ao gravar semelhanças')
      break
    }
    gravadas += Number(data) || 0
  }
  return gravadas
}

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
  bloqueados: Set<string>,
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
    const semelhancas: LinhaDeSemelhanca[] = []
    for (const { artistId, grupo, artistas, falhou } of respostas) {
      if (falhou) {
        // Falha transitória não queima a semente: ela volta amanhã.
        resultado.falhasApi += grupo.length
        continue
      }
      for (const s of grupo) sementesConsumidas.push(s.deezer_track_id)

      // Os 20, antes do filtro de fãs: o artista grande não entra na
      // fronteira, mas continua parecido.
      semelhancas.push(
        ...linhasDeSemelhanca(artistId, 'related', artistas.map((a) => a.deezer_artist_id))
      )

      // O dial: só quem está abaixo do teto de fãs, do menos popular para o
      // mais. Acima do teto o artista já chega sozinho por chart ou por save.
      const candidatos = artistas
        .filter((a) => a.nb_fan != null && a.nb_fan <= config.maxFas)
        .filter((a) => !bloqueados.has(a.deezer_artist_id))
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

    resultado.semelhancas += await gravarSemelhancas(db, logger, semelhancas)
  }

  // --- 2. Colher a fronteira ----------------------------------------------
  // O teto de requisições é o próprio alvo de faixas. A razão medida é 4,65
  // faixas por requisição, então isto é folgado — existe para o caso
  // patológico do artista com muitos álbuns de uma faixa só, que sem teto
  // gastaria a noite inteira sem chegar ao alvo.
  const maxRequisicoes = alvo
  const fila = await lerFronteira(db, Math.max(1, Math.ceil(alvo / 4)))

  // A discografia traz o `genre_id` de cada álbum; o nome sai daqui, no mesmo
  // vocabulário do chart. Uma requisição por noite, e é o que dá gênero à
  // página de faixa de tudo que esta caminhada colhe (migration 037).
  const nomeDoGenero = new Map((await listarGeneros()).map((g) => [g.id, g.name]))

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

    // Álbum de gênero fora da coleta nem é pedido: o gênero vem na
    // discografia, que já foi paga. Ver GENEROS_FORA_DA_COLETA.
    const { colher, fora, artistaFora } = separarPorGenero(uteis)
    resultado.albunsForaDoGenero += fora.length

    const faixasPorAlbum = await Promise.all(
      colher.map(async (album) => ({ album, ...(await faixasDoAlbum(album.deezer_album_id)) }))
    )
    resultado.albumRequisicoes += colher.length

    for (const { album, faixas, falhou: falhouAlbum } of faixasPorAlbum) {
      if (falhouAlbum) {
        resultado.falhasApi++
        continue
      }
      for (const f of faixas) {
        // O mesmo filtro que record_observations aplica no SQL. Aplicado aqui
        // também para a contagem do log bater com o que o banco gravou.
        if (!f.title || !f.artist_name || f.rank == null) continue
        if (f.deezer_artist_id && bloqueados.has(f.deezer_artist_id)) continue
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
          genre: (album.genre_id != null && nomeDoGenero.get(album.genre_id)) || null,
          source_list: `album:${album.deezer_album_id}`,
          rank: f.rank,
          duration_seconds: f.duration_seconds,
          explicit_lyrics: f.explicit_lyrics,
          has_preview: f.has_preview,
          // A faixa de álbum não traz data; o álbum, na discografia, traz. É a
          // data que a página mostra até uma medição por /track trazer a da
          // própria faixa, que costuma ser a mesma.
          release_date: album.release_date,
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
    const esgotado = artistaFora || consumidos >= total
    progresso.push({
      deezer_artist_id: artista.deezer_artist_id,
      next_album_index: consumidos,
      albums_total: total,
      exhausted: esgotado,
    })
    resultado.albumArtistasColhidos++
    if (artistaFora) resultado.artistasForaDoGenero++
    if (esgotado) resultado.albumArtistasExauridos++
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
      albunsForaDoGenero: resultado.albunsForaDoGenero,
      artistasForaDoGenero: resultado.artistasForaDoGenero,
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

/**
 * Artistas que a descoberta nunca deve colher. A lista nasceu de uma varredura
 * do catálogo com um modelo de decisão (migration 036) e mora no banco porque
 * manter a regra não custa chamada nenhuma — o modelo serviu para descobrir
 * QUEM são, não para decidir a cada noite.
 */
async function lerBloqueados(db: SupabaseClient): Promise<Set<string>> {
  const { data, error } = await db.from('blocked_artists').select('deezer_artist_id')
  if (error) throw error
  return new Set((data ?? []).map((l) => String(l.deezer_artist_id)))
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
  const bloqueados = await lerBloqueados(db)

  try {
    await caminhadaPorAlbum(
      db, logger, config, resultado.albumAlvo, conhecidas, bloqueados, resultado
    )
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

  // Em blocos, não tudo de uma vez. O gateway aceita 1.000 requisições
  // pendentes e cada uma espera no máximo 120 s na fila; a 3 req/s a fila
  // drena 360 nesse tempo. Com 1.500 sementes eram 556 artistas de uma vez e
  // ~200 estouravam a espera e repetiam — os "bloqueios" da rodada de
  // 15/09/2026 eram isso, não o Deezer (o gateway registrou zero ondas). Com
  // 3.000 sementes seriam ~1.100, acima do que o gateway aceita, e o excedente
  // morreria como falha de API. 250 drenam em ~83 s, dentro da espera.
  //
  // A alocação das candidatas é feita depois, em ordem, para duas sementes
  // nunca escolherem a mesma faixa.
  const BLOCO_RADIO = 250
  const artistas = [...porArtista.entries()]
  const radios: {
    artistId: string
    grupo: Semente[]
    radio: Awaited<ReturnType<typeof radioDoArtista>>
  }[] = []

  for (let i = 0; i < artistas.length; i += BLOCO_RADIO) {
    const bloco = await Promise.all(
      artistas.slice(i, i + BLOCO_RADIO).map(async ([artistId, grupo]) => ({
        artistId,
        grupo,
        radio: await radioDoArtista(artistId, Math.max(15, grupo.length * 2)),
      }))
    )
    radios.push(...bloco)
  }

  resultado.semelhancas += await gravarSemelhancas(
    db,
    logger,
    radios.flatMap(({ artistId, radio }) =>
      radio.falhou
        ? []
        : linhasDeSemelhanca(artistId, 'radio', radio.faixas.map((f) => f.deezer_artist_id))
    )
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
        if (faixa.deezer_artist_id && bloqueados.has(faixa.deezer_artist_id)) continue
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
