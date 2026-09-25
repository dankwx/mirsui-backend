// src/jobs/catalogSnapshot.ts
// Job diário do Observatório: mede a popularidade de milhares de faixas e grava
// um ponto por faixa por dia. Roda com service role.
//
// A diferença para runStakeSnapshot(): aquele mede o que os usuários ficharam
// (hoje, três faixas). Este mede o catálogo — não depende de existir usuário.
// Ver migrations/009_observatorio.sql para o porquê.
//
// ORDEM DA RODADA
//   1. Varre os charts por gênero. Barato e é o grosso: cada requisição devolve
//      300 faixas já com rank.
//   2. Traz para o Observatório as faixas que os usuários salvaram e que ainda
//      não estavam sendo medidas. É a ponta obscura do catálogo — o chart sozinho
//      enviesa tudo para o que já estourou, e "antes de estourar" é a tese.
//   3. Mede por álbum, com fallback individual, quem VENCEU a própria cadência.
//      Mantém o Observatório seguindo a faixa depois que ela sai do chart —
//      inclusive na descida. Desde a migration 025 esta fila não é mais "todo
//      mundo que não medi hoje": cada faixa tem uma banda (quente/morna/fria) e
//      a rodada para quando o ORÇAMENTO acaba, não quando o catálogo acaba.
//   4. Preenche o ISRC de quem entrou sem ele. Esta etapa deixou de ser
//      acessória: o ISRC é o ENDEREÇO das páginas desde a migration 023, então
//      é ela que dá página às faixas novas. Vai por /album/{id}/tracks, que
//      resolve o álbum inteiro numa requisição (~10x mais barato).
//
// O QUE SAIU DAQUI
// Havia uma quinta etapa que resolvia ISRC -> id do Spotify, 2.027 buscas por
// noite. Ela era a única parte da rodada que dependia de credencial de
// terceiro, era a que mais falhava (429 com Retry-After de horas) e escalava
// com o TAMANHO DO CATÁLOGO em vez de com interesse. Virou resolução
// preguiçosa: quem abre a página resolve aquela faixa, uma vez, para sempre
// (POST /tracks/resolve-spotify). O `spotify_track_id` continua na tabela e
// continua sendo preenchido — só que por visita, não por varredura.
// Ver docs/plano-independencia-do-spotify.md, fases 4 e 5.
//
// A CADÊNCIA (item 4 da análise de escala, migration 025)
// Medir tudo todo dia é O(N): dobrou o catálogo, dobrou a noite. Como 91,9% das
// medições consecutivas leem o mesmo rank, quase toda essa requisição existe
// para descobrir que nada mudou. Agora cada faixa tem uma banda —
//
//   quente  stake ativo, salva, entrou há < 30 dias, ou subindo    1 dia
//   morna   teve movimento nos últimos 30 dias                     7 dias
//   fria    nada disso                                            14 dias
//
// — e a etapa 3 admite um ORÇAMENTO FIXO de faixas por noite, na ordem de
// prioridade. O catálogo cresce, a rodada não.
//
// IMPORTANTE PARA LER O LOG: enquanto o catálogo inteiro for mais novo que
// OBS_JANELA_NOVIDADE, todas as faixas são quentes e a cadência não economiza
// nada. Isso é o comportamento correto, não uma configuração que não pegou —
// a economia aparece conforme o catálogo envelhece. O campo `bandas` do log diz
// a distribuição real de cada noite.
//
// Nada aqui é obrigatório para o job ser útil: se um passo falhar, os outros
// gravam mesmo assim. Um dia com metade dos pontos vale muito mais que um dia
// sem ponto nenhum, porque esse dia não volta.

import { supabaseAdmin } from '../lib/supabase'
import { popScore } from '../lib/stakePoints'
import { runCatalogDiscovery } from './catalogDiscovery'
import { medirPorAlbum, type LinhaParaMedir } from './catalogMeasurement'
import { preencherFichaDosAlbuns } from './albumDetails'
import { preencherFichaDosArtistas } from './artistDetails'
import { remontarVizinhanca } from './artistNeighbors'
import {
  listarGeneros,
  chartDoGenero,
  buscarFaixa,
  buscarPorIsrc,
  buscarPorTexto,
  faixasDoAlbum,
  contadoresDeezer,
  zerarContadoresDeezer,
  type FaixaObservada,
} from '../lib/deezerCatalog'

interface Log {
  info: (o: unknown, m?: string) => void
  error: (o: unknown, m?: string) => void
  warn?: (o: unknown, m?: string) => void
}

export interface ResultadoObservatorio {
  /**
   * Linhas efetivamente gravadas no histórico. Desde a migration 021 isso conta
   * MUDANÇAS de rank, não medições: faixa medida cujo rank não mexeu não gera
   * linha. Esperar este número perto do tamanho do catálogo é leitura antiga —
   * o normal agora é uma fração dele. Quantas faixas foram medidas está em
   * doChart + doAcervo + medidasIndividuais.
   */
  pontos: number
  doChart: number
  doAcervo: number
  /** Total da etapa 3; nome legado preservado para os consumidores do resumo. */
  medidasIndividuais: number
  medidasPorAlbum: number
  medidasPorFaixa: number
  /** Álbuns consultados na etapa 3, não chamadas HTTP (podem ter páginas/retries). */
  medicaoAlbunsConsultados: number
  /** faixas cujo source_list virou 'acervo' porque alguém as salvou */
  promovidasAoAcervo: number
  /** faixas que trocaram de banda de cadência nesta rodada */
  reclassificadas: number
  /**
   * Quantos lotes a cadência precisou (migration 035) e quantas faixas eles
   * examinaram. Vale olhar os dois juntos: se `cadenciaExaminadas` ficar muito
   * abaixo do catálogo ativo, algum lote morreu no meio e metade das faixas
   * ficou com a banda de ontem — que é exatamente o que ninguém viu acontecer
   * entre 17 e 20/09/2026.
   */
  cadenciaLotes: number
  cadenciaExaminadas: number
  /** distribuição das bandas depois do recálculo: {quente, morna, fria} */
  bandas: Record<string, number>
  /** teto de faixas admitidas na etapa 3 nesta noite */
  orcamentoMedicao: number
  /** quantas faixas estavam vencidas — se passar do orçamento, sobra fila */
  filaVencida: number
  /**
   * Quantas linhas a leitura da fila REALMENTE trouxe. Tem que ser igual a
   * min(filaVencida, orcamentoMedicao); se for menos, alguma camada cortou no
   * caminho. Existe porque entre a 025 e a 031 o PostgREST cortava a fila em
   * 1.000 linhas e NENHUM campo do log mostrava a diferença — o orçamento dizia
   * 12.000, a fila vencida dizia 14.571, e a etapa media 997.
   */
  filaLida: number
  /**
   * Faixas vencidas que CONTINUAM vencidas depois da rodada: as que o orçamento
   * não alcançou, mais as que o Deezer não respondeu. Contado contra
   * medidasIndividuais e não contra o orçamento — até a 031 era
   * `filaVencida - orcamentoMedicao`, que na noite de 26/08/2026 relatou ~2.571
   * quando o buraco real era 13.574. O campo existia para o corte não ser
   * silencioso e estava, ele mesmo, escondendo o corte.
   *
   * Um número teimosamente alto aqui significa orçamento pequeno demais para o
   * catálogo — é o sinal de subir OBS_ORCAMENTO_MEDICAO ou esfriar as bandas.
   */
  adiadas: number
  isrcPreenchidos: number
  /** requisições a /album/{id}/tracks — cada uma cobre o álbum inteiro */
  isrcRequisicoesDeAlbum: number
  /** faixas cujo ISRC saiu de um álbum, e não de uma requisição própria */
  isrcResolvidosPorAlbum: number
  /**
   * Etapa 4b (migration 037): álbuns consultados para dar gênero e data às
   * faixas que chegaram sem eles, e quantas faixas ganharam cada um. A fila
   * que sobrou vai em `fichaAlbumFila`; ela deve cair a quase zero depois das
   * primeiras noites e ficar no que a rádio e o chart trazem.
   */
  fichaAlbumConsultados: number
  fichaAlbumFaixas: number
  fichaAlbumFila: number
  /**
   * Etapa 4c (migration 040): artistas cuja ficha da página foi pedida ao
   * Deezer (3 requisições cada), gravada, dada como inexistente ou adiada por
   * falha. `fichaArtistaFila` é quem estava sem ficha ou com ficha vencida
   * antes da etapa; ela cai durante a varredura inicial e depois fica na
   * renovação (catálogo / OBS_FICHA_ARTISTA_DIAS por noite) mais os novos.
   */
  fichaArtistaConsultados: number
  fichaArtistaGravados: number
  fichaArtistaInexistentes: number
  fichaArtistaAdiados: number
  fichaArtistaFila: number
  /** faixas que precisaram do caminho antigo, uma requisição cada */
  isrcResolvidosUmAUm: number
  descobertaSementes: number
  descobertaNovas: number
  descobertaSemCandidata: number
  descobertaFalhasApi: number
  /** faixas novas vindas da caminhada por álbum (ADR 002), já com ISRC */
  descobertaNovasPorAlbum: number
  /** faixas que a caminhada leu; a diferença para as novas já estava no catálogo */
  descobertaColhidasPorAlbum: number
  /** requisições gastas na caminhada — a razão com as colhidas é o que se mede */
  descobertaRequisicoesDeAlbum: number
  /** artistas na fronteira da caminhada antes desta rodada */
  descobertaFronteira: number
  /** pares de artistas que a descoberta guardou das respostas (041) */
  descobertaSemelhancas: number
  /**
   * Etapa 6 (migration 041): a vizinhança dos artistas, de onde saem as
   * "Parecidas" da página de faixa. Só SQL. `vizinhancaArtistas` é quantos
   * artistas com página ganharam vizinhos; `vizinhancaSegundo`, quantos
   * vizinhos vieram do segundo salto.
   */
  vizinhancaPares: number
  vizinhancaArtistas: number
  vizinhancaDiretos: number
  vizinhancaSegundo: number
  desativadas: number
  falhas: number
}

// Teto configurável por env. Aceita 0 — é assim que se desliga uma etapa numa
// rodada de teste. Só variável ausente ou vazia cai no padrão.
//
// O padrão das filas é Infinity: o job varre até acabar, e não até bater numa
// conta. Um teto de contagem tem o defeito de ser silencioso — no dia em que o
// catálogo passa dele, faixas somem da série do dia e nada no log grita. As
// envs continuam existindo para RE-limitar de propósito numa rodada de teste.
const num = (chave: string, padrao: number) => {
  const bruto = process.env[chave]
  if (bruto == null || bruto.trim() === '') return padrao
  const v = Number(bruto)
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : padrao
}

// Quantas linhas por chamada de record_observations. 500 mantém o payload
// jsonb num tamanho confortável e a transação curta.
const LOTE = 500

export async function runCatalogSnapshot(logger?: Log): Promise<ResultadoObservatorio> {
  const log: Log = logger ?? {
    info: (o, m) => console.log(m ?? '', o),
    error: (o, m) => console.error(m ?? '', o),
  }
  // Sempre por chamada de método, nunca desprendendo warn do objeto: o pino lê
  // `this` dentro de warn(), e `(log.warn ?? log.info)(...)` derrubou a etapa 3
  // e o resumo da rodada de 13/09/2026 com "reading 'Symbol(pino.msgPrefix)'".
  const warn = (o: unknown, m: string) => (log.warn ? log.warn(o, m) : log.info(o, m))

  const vazio: ResultadoObservatorio = {
    pontos: 0,
    doChart: 0,
    doAcervo: 0,
    medidasIndividuais: 0,
    medidasPorAlbum: 0,
    medidasPorFaixa: 0,
    medicaoAlbunsConsultados: 0,
    promovidasAoAcervo: 0,
    reclassificadas: 0,
    cadenciaLotes: 0,
    cadenciaExaminadas: 0,
    bandas: {},
    orcamentoMedicao: 0,
    filaVencida: 0,
    filaLida: 0,
    adiadas: 0,
    isrcPreenchidos: 0,
    isrcRequisicoesDeAlbum: 0,
    isrcResolvidosPorAlbum: 0,
    fichaAlbumConsultados: 0,
    fichaAlbumFaixas: 0,
    fichaAlbumFila: 0,
    fichaArtistaConsultados: 0,
    fichaArtistaGravados: 0,
    fichaArtistaInexistentes: 0,
    fichaArtistaAdiados: 0,
    fichaArtistaFila: 0,
    isrcResolvidosUmAUm: 0,
    descobertaSementes: 0,
    descobertaNovas: 0,
    descobertaSemCandidata: 0,
    descobertaFalhasApi: 0,
    descobertaNovasPorAlbum: 0,
    descobertaColhidasPorAlbum: 0,
    descobertaRequisicoesDeAlbum: 0,
    descobertaFronteira: 0,
    descobertaSemelhancas: 0,
    vizinhancaPares: 0,
    vizinhancaArtistas: 0,
    vizinhancaDiretos: 0,
    vizinhancaSegundo: 0,
    desativadas: 0,
    falhas: 0,
  }

  if (!supabaseAdmin) {
    log.error({}, 'SUPABASE_SERVICE_ROLE_KEY não configurada — Observatório abortado')
    return vazio
  }
  const db = supabaseAdmin

  // A janela dos contadores do Deezer é a rodada. Eles vão no log da etapa 3 e
  // no da rodada concluída — é o que distingue "fila maior que o orçamento" de
  // "o Deezer parou de responder às 05:19", que até 12/09/2026 saíam iguais.
  zerarContadoresDeezer()

  const maxGeneros = num('OBS_MAX_GENEROS', Infinity)
  // Este é o único teto real que sobra, e não é nosso: 300 é o máximo que
  // /chart/{id}/tracks devolve numa resposta. Ficou em 100 por muito tempo por
  // engano — o endpoint sempre devolveu 300, pelo mesmo custo de 1 requisição.
  const limiteChart = num('OBS_LIMITE_CHART', 300)
  const limiteAcervo = num('OBS_LIMITE_ACERVO', Infinity)
  const limiteIsrc = num('OBS_LIMITE_ISRC', Infinity)
  // Teto da etapa 4b, em ÁLBUNS (= requisições). O catálogo de 22/09/2026 tem
  // dezenas de milhares de álbuns sem gênero; a 5.000 por noite a varredura
  // inicial leva uma semana e custa ~12% de uma rodada. Depois dela, a fila é
  // o que chega por rádio e chart, que é bem menos. 0 desliga.
  const limiteFichaAlbum = num('OBS_LIMITE_FICHA_ALBUM', 5_000)
  // Teto da etapa 4c, em ARTISTAS (3 requisições cada). O catálogo de
  // 22/09/2026 tem 12.567 artistas: a 2.000 por noite (~6 mil requisições,
  // ~40 min) a varredura inicial leva uma semana. Depois dela sobra a
  // renovação (OBS_FICHA_ARTISTA_DIAS) e os artistas novos. 0 desliga.
  const limiteFichaArtista = num('OBS_LIMITE_FICHA_ARTISTA', 2_000)
  const diasFichaArtista = Math.max(1, num('OBS_FICHA_ARTISTA_DIAS', 30))
  // Etapa 6, em quantas chamadas a vizinhança é remontada. Cada uma precisa
  // caber nos 8 s do PostgREST; com 8 lotes, ~0,4 s cada no catálogo de
  // 25/09/2026. Suba se o catálogo passar de ~500 mil faixas. 0 desliga.
  const lotesVizinhanca = num('OBS_VIZINHANCA_LOTES', 8)

  // O orçamento da etapa 3. Este é o único teto do job que NÃO é um freio de
  // emergência: é o mecanismo. Diferente dos OBS_LIMITE_*, cortar aqui não é
  // silencioso — `filaVencida` e `adiadas` vão no log de toda rodada.
  //
  // 12.000 a ~8 req/s são ~25 min de etapa 3, dentro da janela noturna, e quase
  // 2x o catálogo de hoje (6.490) — ou seja, não corta nada agora. O número que
  // importa não é este e sim a cadência: é ela que decide quantas faixas chegam
  // a ficar vencidas por noite.
  const orcamentoMedicao = num('OBS_ORCAMENTO_MEDICAO', 12_000)
  // OBS_LIMITE_MEDICAO continua existindo como freio manual, acima do orçamento.
  const limiteMedicao = num('OBS_LIMITE_MEDICAO', Infinity)

  // A banda fria é o parâmetro que manda na conta (é 70% da massa num catálogo
  // maduro): custo/dia = 0,05N + 0,25N/7 + 0,70N/C_fria. Com C_fria em 30 dá
  // 9,2x; em 14, 7,4x; em 7, 5,4x. O padrão é 14 porque a faixa fria é onde
  // mora a obscura que está prestes a estourar, e a janela cega de uma
  // descoberta tardia é exatamente o tamanho desta cadência.
  const cadenciaMorna = num('OBS_CADENCIA_MORNA', 7)
  const cadenciaFria = num('OBS_CADENCIA_FRIA', 14)
  const janelaMovimento = num('OBS_JANELA_MOVIMENTO', 30)
  const janelaNovidade = num('OBS_JANELA_NOVIDADE', 30)

  const resultado = { ...vazio }
  const inicio = Date.now()

  // A fronteira do dia em UTC — a mesma do índice de idempotência da migration
  // 009 — deixou de ser calculada aqui: desde a 025 quem decide se uma faixa
  // está vencida é observatory_measurement_queue(), no banco, onde a data e o
  // registro de last_checked_at compartilham o mesmo relógio. Duas noções de
  // "hoje" (a do processo e a do Postgres) só podiam divergir.

  /** Envia um conjunto de medições em lotes e soma os pontos gravados. */
  const gravar = async (faixas: FaixaObservada[], etapa: string): Promise<number> => {
    let gravados = 0
    for (let i = 0; i < faixas.length; i += LOTE) {
      const lote = faixas.slice(i, i + LOTE).map((f) => ({
        ...f,
        popularity: popScore(f.rank),
      }))
      const { data, error } = await db.rpc('record_observations', { p_rows: lote })
      if (error) {
        resultado.falhas++
        log.error({ err: error, etapa, tamanho: lote.length }, 'Falha ao gravar lote')
        continue
      }
      gravados += Number(data) || 0
    }
    return gravados
  }

  /**
   * Lê uma fila inteira do banco, contornando o teto de linhas do PostgREST.
   *
   * O Supabase corta TODA resposta em 1.000 linhas (db-max-rows). O `.limit()`
   * do cliente não levanta esse teto: pedir 3.000 devolve 1.000 e não avisa —
   * a rodada simplesmente faz um terço do trabalho achando que fez tudo. Por
   * isso a leitura vai por páginas de 1.000 via .range(), que é inclusivo.
   *
   * Seguro contra deslocamento de offset porque as marcas (isrc_checked_at,
   * last_checked_at) só são gravadas depois, fora desta leitura.
   *
   * `limite` aceita Infinity, que é o padrão: nesse caso a paginação só para
   * quando uma página volta incompleta, ou seja, quando a fila acabou de fato.
   */
  const lerFila = async <T>(
    montarQuery: () => { range: (de: number, ate: number) => PromiseLike<{ data: unknown; error: unknown }> },
    limite: number
  ): Promise<T[]> => {
    const PAGINA = 1000
    const tudo: T[] = []
    for (let offset = 0; offset < limite; offset += PAGINA) {
      const pedaco = Math.min(PAGINA, limite - offset)
      const { data, error } = await montarQuery().range(offset, offset + pedaco - 1)
      if (error) throw error
      const lote = (data ?? []) as T[]
      tudo.push(...lote)
      if (lote.length < pedaco) break // acabou a fila
    }
    return tudo
  }

  // -------------------------------------------------------------------------
  // 1. Charts por gênero
  // -------------------------------------------------------------------------
  const vistasHoje = new Set<string>()
  try {
    const generos = await listarGeneros()
    // O gênero 0 ("Todos") é o chart global e vale sempre; os demais vêm todos.
    // Gênero é barato: uma requisição cobre até 300 faixas, e o Deezer tem
    // pouco mais de vinte deles — cortar em 40 nunca economizou nada de real.
    const alvo = [
      { id: 0, name: 'Todos' },
      ...generos.filter((g) => g.id !== 0).slice(0, maxGeneros),
    ]

    const doChart: FaixaObservada[] = []
    for (const g of alvo) {
      const faixas = await chartDoGenero(g.id, g.name, limiteChart)
      if (faixas.length === 0) {
        log.warn?.({ genero: g.id, nome: g.name }, 'Chart vazio ou indisponível')
        continue
      }
      for (const f of faixas) {
        doChart.push(f)
        vistasHoje.add(f.deezer_track_id)
      }
    }

    resultado.doChart = vistasHoje.size
    resultado.pontos += await gravar(doChart, 'chart')
    log.info(
      { generos: alvo.length, faixas: vistasHoje.size },
      'Observatório: varredura de charts concluída'
    )
  } catch (err) {
    resultado.falhas++
    log.error({ err }, 'Observatório: varredura de charts falhou')
  }

  // -------------------------------------------------------------------------
  // 2. Acervo do site → Observatório
  // -------------------------------------------------------------------------
  try {
    // As faixas que as pessoas salvaram. Uma linha por pessoa que salvou, então
    // desduplicamos por artista+título aqui mesmo. Vai por lerFila() porque o
    // acervo inteiro importa: um teto aqui esconderia justamente o salvamento
    // antigo que nunca entrou no Observatório.
    const salvas = await lerFila<{
      track_title?: string
      artist_name?: string
      isrc?: string | null
    }>(
      () =>
        db
          .from('tracks')
          .select('track_title, artist_name, isrc')
          .order('id', { ascending: false }),
      Infinity
    )

    const unicas = new Map<string, { titulo: string; artista: string; isrc: string | null }>()
    for (const t of salvas) {
      const titulo = t.track_title
      const artista = t.artist_name
      if (!titulo || !artista) continue
      const chave = `${artista.toLowerCase()}|${titulo.toLowerCase()}`
      const ja = unicas.get(chave)
      // Entre as linhas da mesma gravação (uma por pessoa que salvou), a que
      // tem ISRC manda: é a identidade, e as antigas podem tê-lo em branco.
      if (!ja) unicas.set(chave, { titulo, artista, isrc: t.isrc || null })
      else if (!ja.isrc && t.isrc) ja.isrc = t.isrc
    }

    // Só resolvemos quem ainda não está no Observatório — e "estar" tem duas
    // perguntas diferentes, por isso duas leituras:
    //
    //   por ISRC   esta GRAVAÇÃO já é medida? Vale contra o catálogo INTEIRO,
    //              porque a faixa pode ter entrado por chart ou rádio antes de
    //              alguém salvá-la (é a promoção da migration 025).
    //   por texto  esta STRING já foi resolvida? Só vale contra o que entrou
    //              por aqui, e existe para o save anterior à 023, sem ISRC.
    //
    // Antes só havia a segunda, e o texto do Deezer é normalizado na gravação:
    // 'akiaura, LONOWN, DJ Pointless' salvo virava 'Akiaura' observado, o par
    // nunca mais casava e a faixa voltava à busca todas as noites, para sempre.
    // Medido em 16/08/2026, antes desta mudança: 11 gravações eram re-buscadas
    // por noite e 8 delas já estavam no Observatório sob o ISRC salvo.
    //
    // Paginado pelo mesmo motivo de sempre: uma lista truncada aqui não erra
    // para o lado seguro — faria o job re-buscar faixa que já é observada.
    const [observadas, jaObservadas] = await Promise.all([
      lerFila<{ isrc?: string | null }>(
        () =>
          db
            .from('observed_tracks')
            .select('isrc')
            .not('isrc', 'is', null)
            // Ordem explícita: sem ela a paginação por .range() pode repetir ou
            // pular linhas entre uma página e outra.
            .order('deezer_track_id', { ascending: true }),
        Infinity
      ),
      lerFila<{ title?: string; artist_name?: string }>(
        () =>
          db
            .from('observed_tracks')
            .select('title, artist_name')
            .eq('source_list', 'acervo')
            .order('deezer_track_id', { ascending: true }),
        Infinity
      ),
    ])

    const isrcsObservados = new Set(
      observadas.flatMap((o) => (o.isrc ? [o.isrc] : []))
    )

    const conhecidas = new Set(
      jaObservadas.map(
        (o) =>
          `${String(o.artist_name ?? '').toLowerCase()}|${String(o.title ?? '').toLowerCase()}`
      )
    )

    const pendentes = [...unicas.entries()]
      .filter(
        ([chave, g]) =>
          !(g.isrc && isrcsObservados.has(g.isrc)) && !conhecidas.has(chave)
      )
      .slice(0, limiteAcervo)

    // O ISRC primeiro, o texto só como reserva — ver buscarPorIsrc(). Também em
    // paralelo, pelo mesmo motivo da etapa 3: o ritmo é da fila.
    let porIsrc = 0
    const achadas = await Promise.all(
      pendentes.map(async ([, { titulo, artista, isrc }]) => {
        if (isrc) {
          const exata = await buscarPorIsrc(isrc)
          if (exata) {
            porIsrc++
            return exata
          }
        }
        return buscarPorTexto(artista, titulo)
      })
    )

    const doAcervo: FaixaObservada[] = []
    for (const achada of achadas) {
      if (achada && !vistasHoje.has(achada.deezer_track_id)) {
        doAcervo.push(achada)
        vistasHoje.add(achada.deezer_track_id)
      }
    }

    resultado.doAcervo = doAcervo.length
    resultado.pontos += await gravar(doAcervo, 'acervo')
    // `porIsrc` contra `resolvidas` é o número a acompanhar: enquanto a segunda
    // for maior, ainda há save resolvido no palpite. `candidatas` teimosamente
    // alto é o sinal antigo de volta — gravação salva que o Deezer não tem.
    log.info(
      { candidatas: pendentes.length, resolvidas: doAcervo.length, porIsrc },
      'Observatório: acervo incorporado'
    )
  } catch (err) {
    resultado.falhas++
    log.error({ err }, 'Observatório: incorporação do acervo falhou')
  }

  // -------------------------------------------------------------------------
  // 2.5. Quem é quem: promoção e bandas de cadência
  // -------------------------------------------------------------------------
  // Duas coisas, nesta ordem, e nenhuma delas fala com o Deezer — é SQL puro
  // sobre o que já está no banco, então não gasta nada do orçamento.
  //
  // A promoção primeiro: faixa que alguém salvou passa a ser classificada como
  // acervo, tenha entrado por onde tiver entrado. Antes da migration 025,
  // source_list era gravado na entrada e nunca mais mexido — faixa que entrou
  // pelo chart e foi salva continuava lida como 'chart:81' para sempre. A
  // origem não se perde: fica em origin_list.
  //
  // A classificação depois, porque a banda depende de quem está salva.
  //
  // Roda antes da etapa 3 e depois das etapas 1 e 2 de propósito: assim as
  // faixas que entraram hoje já nascem classificadas, e as do chart já estão
  // com last_checked_at de hoje quando a fila for lida — saem da fila sozinhas,
  // sem lista de exclusão.
  try {
    const { data: promovidas, error: errPromo } = await db.rpc('promote_saved_observed_tracks')
    if (errPromo) throw errPromo
    resultado.promovidasAoAcervo = Number(promovidas) || 0

    // A cadência vem em lotes desde a migration 035, e o laço é AQUI, fora do
    // banco — não por estilo. `statement_timeout` é armado para o statement de
    // cima, a chamada da função; paginar por dentro dela, num laço plpgsql,
    // não moveria o relógio, porque o relógio é o da chamada inteira. Mesma
    // lição da 031 com a fila.
    //
    // O lote é grande de propósito: o custo por faixa é baixo (uma junção
    // contra três conjuntos pequenos) e o que precisa caber no relógio é a
    // ESCRITA. 20.000 dão folga larga sobre os ~10s que derrubavam o passo
    // quando ele tentava o catálogo inteiro de uma vez.
    const loteCadencia = num('OBS_LOTE_CADENCIA', 20_000)
    // 500 lotes de 20.000 são 10 milhões de faixas — 20x o teto do catálogo.
    // O teto existe para o caso de o cursor deixar de avançar: sem ele, um
    // contrato quebrado na função viraria laço infinito segurando a rodada.
    const MAX_LOTES = 500

    let cursor: string | null = null
    do {
      const { data: cadencia, error: errCadencia } = await db.rpc('refresh_observatory_cadence', {
        p_cadencia_morna: cadenciaMorna,
        p_cadencia_fria: cadenciaFria,
        p_janela_movimento: janelaMovimento,
        p_janela_novidade: janelaNovidade,
        p_lote: loteCadencia,
        p_depois: cursor,
      })
      if (errCadencia) throw errCadencia

      const c = (cadencia ?? {}) as {
        reclassificadas?: number
        examinadas?: number
        proximo?: string | null
        distribuicao?: Record<string, number>
      }
      resultado.reclassificadas += Number(c.reclassificadas) || 0
      resultado.cadenciaExaminadas += Number(c.examinadas) || 0
      resultado.cadenciaLotes++
      // A distribuição só vem no último lote; os intermediários mandam {}.
      if (c.distribuicao && Object.keys(c.distribuicao).length > 0) {
        resultado.bandas = c.distribuicao
      }

      cursor = c.proximo ?? null
      if (cursor && resultado.cadenciaLotes >= MAX_LOTES) {
        throw new Error(
          `Cadência: ${resultado.cadenciaLotes} lotes sem terminar (cursor em ${cursor}) — o cursor não está avançando`
        )
      }
    } while (cursor)

    log.info(
      {
        promovidas: resultado.promovidasAoAcervo,
        reclassificadas: resultado.reclassificadas,
        lotes: resultado.cadenciaLotes,
        examinadas: resultado.cadenciaExaminadas,
        bandas: resultado.bandas,
        cadencias: { quente: 1, morna: cadenciaMorna, fria: cadenciaFria },
      },
      'Observatório: cadência recalculada'
    )
  } catch (err) {
    resultado.falhas++
    // Não é fatal: sem recálculo, a etapa 3 usa a banda da rodada anterior. O
    // pior caso é medir com a classificação de ontem, não deixar de medir.
    log.error({ err }, 'Observatório: recálculo de cadência falhou')
  }

  // Uma faixa não é consultada duas vezes na mesma rodada, mesmo que caia nos
  // critérios das etapas 3 e 4 ao mesmo tempo.
  const consultadasNestaRodada = new Set<string>()

  type LinhaObservada = LinhaParaMedir

  /**
   * Consulta /track/{id} de cada linha e monta as medições prontas para gravar.
   * A mesma resposta traz rank e ISRC, então as etapas 3 e 4 compartilham este
   * caminho — quem é medido também ganha ISRC, sem requisição extra.
   *
   * As consultas saem todas de uma vez porque quem controla o ritmo é a fila de
   * deezerCatalog.ts, não este laço. Pedir uma faixa, esperar a resposta e só
   * então pedir a próxima somava a latência do Deezer a CADA faixa e segurava a
   * varredura em ~3,5 req/s mesmo com a cota permitindo 10.
   */
  const consultarLote = async (linhas: LinhaObservada[]) => {
    // O de-dup é feito antes de disparar, e de uma vez: assim continua valendo
    // "uma consulta por faixa por rodada" mesmo com as chamadas concorrentes.
    const aConsultar = linhas.filter((r) => {
      if (consultadasNestaRodada.has(r.deezer_track_id)) return false
      consultadasNestaRodada.add(r.deezer_track_id)
      return true
    })

    const respostas = await Promise.all(
      aConsultar.map(async (linha) => ({
        linha,
        ...(await buscarFaixa(linha.deezer_track_id)),
      }))
    )

    const medidas: FaixaObservada[] = []
    const sumiram: string[] = []
    const tentados = aConsultar.map((r) => r.deezer_track_id)

    for (const { linha: r, faixa, notFound } of respostas) {
      if (notFound) {
        sumiram.push(r.deezer_track_id)
        continue
      }
      // Falha transitória (rede, quota): não grava nada, tenta amanhã.
      if (!faixa) continue

      medidas.push({
        deezer_track_id: r.deezer_track_id,
        deezer_artist_id: faixa.deezer_artist_id ?? r.deezer_artist_id,
        deezer_album_id: faixa.deezer_album_id ?? r.deezer_album_id,
        isrc: faixa.isrc,
        title: faixa.title ?? r.title,
        artist_name: faixa.artist_name ?? r.artist_name,
        album_name: faixa.album_name,
        cover_md5: faixa.cover_md5,
        // O gênero vem do chart de onde a faixa saiu, não da faixa em si;
        // record_observations() preserva o que já está gravado.
        genre: null,
        source_list: r.source_list ?? 'chart:0',
        rank: faixa.rank,
        // /track/{id} é a resposta completa: é daqui que saem a data de
        // lançamento e as participações que a página de faixa mostra.
        duration_seconds: faixa.duration_seconds,
        explicit_lyrics: faixa.explicit_lyrics,
        has_preview: faixa.has_preview,
        release_date: faixa.release_date,
        contributors: faixa.contributors,
      })
    }

    return { medidas, sumiram, tentados }
  }

  const desativar = async (ids: string[]) => {
    if (ids.length === 0) return
    const { data, error } = await db.rpc('deactivate_observed_tracks', { p_ids: ids })
    if (error) {
      log.error({ err: error }, 'Falha ao desativar faixas removidas')
      return
    }
    resultado.desativadas += Number(data) || 0
  }

  /**
   * Consulta a fila em blocos, gravando cada bloco antes de seguir.
   *
   * O progresso precisa ser durável: a ~650ms por requisição (a latência do
   * Deezer manda, não o nosso intervalo), uma fila de 2.500 faixas leva ~27 min.
   * Segurar tudo em memória e gravar só no fim significa que uma queda no
   * minuto 26 joga a rodada inteira fora. Com blocos, o pior caso perdido é um
   * bloco (~3 min).
   */
  const BLOCO = 250

  const processarEmBlocos = async (
    linhas: LinhaObservada[],
    escrever: (r: {
      medidas: FaixaObservada[]
      sumiram: string[]
      tentados: string[]
    }) => Promise<void>
  ) => {
    for (let i = 0; i < linhas.length; i += BLOCO) {
      await escrever(await consultarLote(linhas.slice(i, i + BLOCO)))
    }
  }

  // -------------------------------------------------------------------------
  // 3. Quem venceu a própria cadência
  // -------------------------------------------------------------------------
  // A fila vem pronta do banco (migration 025): só quem está vencida para a
  // própria banda, já ordenada por prioridade e já cortada no orçamento. O job
  // não lê mais o catálogo inteiro para filtrar em memória — sai junto a
  // paginação de 1.000 linhas do PostgREST, que só existia por causa disso.
  //
  // A ordem dentro do orçamento é: quem alguém está acompanhando (stake ou
  // save) primeiro, depois o resto do quente, depois morna, depois fria; e
  // dentro de cada grupo, a mais tempo sem medir na frente.
  try {
    const orcamento = Math.min(orcamentoMedicao, limiteMedicao)
    resultado.orcamentoMedicao = Number.isFinite(orcamento) ? orcamento : 0

    // Quantas estavam vencidas ANTES do corte. É isto que impede o orçamento de
    // ser um teto silencioso — o defeito que o comentário de num() nomeia.
    // Devolve um ESCALAR, e por isso nunca foi truncado: o corte do PostgREST é
    // por linha. Foi o que fez `filaVencida` continuar dizendo a verdade
    // enquanto a fila ao lado dela vinha pela metade.
    const { data: tamanhoFila, error: errTamanho } = await db.rpc('observatory_queue_size')
    if (errTamanho) throw errTamanho
    resultado.filaVencida = Number(tamanhoFila) || 0

    // PAGINADA, e não `db.rpc(...)` direto. O `limit p_limite` de DENTRO da
    // função não substitui o `.range()` de FORA: db.rpc() vai por PostgREST, e
    // PostgREST corta toda resposta em db-max-rows antes de ela chegar ao
    // processo. Entre a 025 e a 031 isso prendeu a etapa 3 em 1.000 faixas por
    // noite com um orçamento de 12.000, todas as noites, sem erro nenhum.
    // A ordem total que a paginação exige está na migration 031.
    const vencidas = await lerFila<LinhaObservada & { cadence_band: string | null }>(
      () => db.rpc('observatory_measurement_queue', { p_limite: resultado.orcamentoMedicao }),
      resultado.orcamentoMedicao
    )
    resultado.filaLida = vencidas.length

    // O guarda que faltava. A leitura tem que trazer o menor entre o que estava
    // vencido e o orçamento; menos que isso é alguma camada cortando no caminho,
    // e isso não pode voltar a ser silencioso.
    const esperado = Math.min(resultado.filaVencida, resultado.orcamentoMedicao)
    if (resultado.filaLida < esperado) {
      log.warn?.(
        {
          esperado,
          lida: resultado.filaLida,
          filaVencida: resultado.filaVencida,
          orcamento: resultado.orcamentoMedicao,
        },
        'Observatório: fila truncada na leitura — veio menos que a fila vencida e que o orçamento'
      )
    }

    const candidatas = vencidas.filter((r) => !vistasHoje.has(r.deezer_track_id))

    // Em que bandas o orçamento foi gasto. É a composição da FILA, não o
    // resultado da medição: faixa que o Deezer não respondeu conta aqui e não
    // em `medidas`. É o número que responde "o orçamento está indo para onde?".
    const filaPorBanda: Record<string, number> = {}
    for (const r of candidatas) {
      const banda = r.cadence_band ?? 'quente'
      filaPorBanda[banda] = (filaPorBanda[banda] ?? 0) + 1
    }

    for await (const lote of medirPorAlbum(candidatas)) {
      resultado.medicaoAlbunsConsultados += lote.albunsConsultados
      resultado.medidasPorAlbum += lote.medidas.length
      resultado.medidasIndividuais += lote.medidas.length
      // Só as faixas com rank válido foram medidas; falhas e ausentes ainda
      // precisam passar por consultarLote, inclusive para confirmar remoção.
      for (const f of lote.medidas) consultadasNestaRodada.add(f.deezer_track_id)
      resultado.pontos += await gravar(lote.medidas, 'medicao-album')
      await processarEmBlocos(lote.individuais, async ({ medidas, sumiram }) => {
        resultado.medidasPorFaixa += medidas.length
        resultado.medidasIndividuais += medidas.length
        resultado.pontos += await gravar(medidas, 'individual')
        await desativar(sumiram)
      })
    }

    // Depois da medição, e contra o que foi medido. Ver o comentário do campo.
    resultado.adiadas = Math.max(0, resultado.filaVencida - resultado.medidasIndividuais)

    // `adiadas` soma duas coisas que pedem reações opostas: o que o orçamento
    // não alcançou (subir OBS_ORCAMENTO_MEDICAO) e o que o Deezer não
    // respondeu (não adianta subir nada). Até 12/09/2026 as duas saíam com o
    // mesmo rótulo, "orçamento esgotado" — com 40.000 de orçamento, 13.000 de
    // fila e 8.000 adiadas, o rótulo mentia todas as noites.
    const foraDoOrcamento = Math.max(0, resultado.filaVencida - resultado.filaLida)
    const naoRespondidas = Math.max(0, resultado.adiadas - foraDoOrcamento)
    const deezer = contadoresDeezer()
    const campos = {
      orcamento: resultado.orcamentoMedicao,
      filaVencida: resultado.filaVencida,
      filaLida: resultado.filaLida,
      medidas: resultado.medidasIndividuais,
      medidasPorAlbum: resultado.medidasPorAlbum,
      medidasPorFaixa: resultado.medidasPorFaixa,
      albunsConsultados: resultado.medicaoAlbunsConsultados,
      filaPorBanda,
      adiadas: resultado.adiadas,
      foraDoOrcamento,
      naoRespondidas,
      desativadas: resultado.desativadas,
      deezer,
    }
    if (naoRespondidas > 0) {
      warn(campos, 'Observatório: Deezer não respondeu parte da fila de medição')
    } else if (foraDoOrcamento > 0) {
      log.info(campos, 'Observatório: orçamento esgotado, fila sobrou para amanhã')
    } else {
      log.info(campos, 'Observatório: medição por álbum e fallback concluída')
    }
  } catch (err) {
    resultado.falhas++
    log.error({ err }, 'Observatório: medição por álbum e fallback falhou')
  }

  // -------------------------------------------------------------------------
  // 4. ISRC pendente — o identificador das páginas
  // -------------------------------------------------------------------------
  // Faixa que entra por chart nasce sem ISRC (o chart não traz esse campo), e
  // sem ISRC ela não tem página: /track/[id] é endereçado pelo ISRC desde a
  // migration 023. Esta etapa deixou de ser um passo intermediário para a ponte
  // do Spotify e virou o que dá página às faixas novas.
  //
  // O caminho principal é /album/{id}/tracks: uma requisição devolve o álbum
  // inteiro com ISRC e rank em todas as faixas (medido: 14/14 nos dois campos).
  // A 10-14 faixas por álbum, isso é ~10x mais barato que /track/{id} um a um,
  // que continua existindo para quem ainda não tem álbum conhecido.
  //
  // A fila é "nunca tentei" e não "está sem ISRC": ver migrations/010. Sem essa
  // distinção, faixa que o Deezer não tem ISRC voltaria para a fila todas as
  // noites, para sempre, travando o avanço.
  try {
    const pendentes = await lerFila<LinhaObservada>(
      () =>
        db
          .from('observed_tracks')
          .select('deezer_track_id, deezer_artist_id, deezer_album_id, title, artist_name, source_list')
          .eq('active', true)
          .is('isrc', null)
          .is('isrc_checked_at', null)
          // Desempate pela PK. added_at tem grupos enormes de linhas idênticas
          // — a descoberta insere ~1.000 faixas numa transação só, e todas ficam
          // com o mesmo timestamp. Medido em 26/08/2026: o maior grupo tem 1.032
          // linhas, MAIOR que a página de lerFila(). Um empate que atravessa a
          // fronteira da página faz o .range() repetir e pular faixa, que é o
          // mesmo defeito que a 031 tirou da fila da etapa 3.
          .order('added_at', { ascending: true })
          .order('deezer_track_id', { ascending: true }),
      limiteIsrc
    )

    let consultadas = 0

    // Agrupa por álbum. As que não têm álbum conhecido — e as que o álbum não
    // souber responder — caem no caminho de uma requisição por faixa.
    const porAlbum = new Map<string, LinhaObservada[]>()
    const umAUm: LinhaObservada[] = []
    for (const r of pendentes) {
      if (r.deezer_album_id) {
        const lista = porAlbum.get(r.deezer_album_id)
        if (lista) lista.push(r)
        else porAlbum.set(r.deezer_album_id, [r])
      } else {
        umAUm.push(r)
      }
    }

    const albuns = [...porAlbum.entries()]
    // Mesmo tamanho de bloco das outras etapas: o progresso precisa ser
    // durável, e quem controla o ritmo é a fila de deezerCatalog.ts.
    const BLOCO_ALBUM = 100

    for (let i = 0; i < albuns.length; i += BLOCO_ALBUM) {
      const bloco = albuns.slice(i, i + BLOCO_ALBUM)

      const respostas = await Promise.all(
        bloco.map(async ([albumId, linhas]) => ({
          linhas,
          ...(await faixasDoAlbum(albumId)),
        }))
      )
      resultado.isrcRequisicoesDeAlbum += bloco.length

      const medidas: FaixaObservada[] = []
      const tentados: string[] = []

      for (const { linhas, faixas, falhou } of respostas) {
        // Rede, quota ou resposta inválida: não marca nada, tenta amanhã.
        // Marcar aqui queimaria o álbum inteiro por causa de um erro passageiro.
        if (falhou) continue

        const doAlbum = new Map(faixas.map((f) => [f.deezer_track_id, f]))

        for (const r of linhas) {
          // Já medida na etapa 3 desta rodada: aquele caminho traz ISRC junto,
          // então não há o que fazer aqui.
          if (consultadasNestaRodada.has(r.deezer_track_id)) continue

          const f = doAlbum.get(r.deezer_track_id)
          // O álbum respondeu mas não lista esta faixa (id de catálogo
          // regional, álbum trocado): volta para o caminho de uma requisição
          // por faixa, em vez de virar uma marca de "tentei" mentirosa.
          if (!f || f.rank == null) {
            umAUm.push(r)
            continue
          }

          consultadasNestaRodada.add(r.deezer_track_id)
          tentados.push(r.deezer_track_id)
          medidas.push({
            deezer_track_id: r.deezer_track_id,
            deezer_artist_id: f.deezer_artist_id ?? r.deezer_artist_id,
            deezer_album_id: r.deezer_album_id,
            isrc: f.isrc,
            title: f.title ?? r.title,
            artist_name: f.artist_name ?? r.artist_name,
            // O endpoint de álbum não repete capa nem álbum em cada faixa, e
            // record_observations preserva o que já está gravado.
            album_name: null,
            cover_md5: null,
            genre: null,
            source_list: r.source_list ?? 'chart:0',
            rank: f.rank,
            duration_seconds: f.duration_seconds,
            explicit_lyrics: f.explicit_lyrics,
            has_preview: f.has_preview,
          })
        }
      }

      resultado.pontos += await gravar(medidas, 'isrc-album')
      const comIsrc = medidas.filter((m) => m.isrc != null).length
      resultado.isrcPreenchidos += comIsrc
      resultado.isrcResolvidosPorAlbum += comIsrc

      // Marca TODOS os consultados, inclusive os que não têm ISRC no Deezer —
      // é isso que os tira da fila e deixa o resto andar.
      if (tentados.length > 0) {
        consultadas += tentados.length
        const { error: errMarca } = await db.rpc('mark_isrc_checked', { p_ids: tentados })
        if (errMarca) log.error({ err: errMarca }, 'Falha ao marcar tentativa de ISRC (álbum)')
      }
    }

    // O resto, pelo caminho antigo: uma requisição por faixa.
    await processarEmBlocos(umAUm, async ({ medidas, sumiram, tentados }) => {
      resultado.pontos += await gravar(medidas, 'isrc')
      const comIsrc = medidas.filter((m) => m.isrc != null).length
      resultado.isrcPreenchidos += comIsrc
      resultado.isrcResolvidosUmAUm += comIsrc
      await desativar(sumiram)

      if (tentados.length > 0) {
        consultadas += tentados.length
        const { error: errMarca } = await db.rpc('mark_isrc_checked', { p_ids: tentados })
        if (errMarca) log.error({ err: errMarca }, 'Falha ao marcar tentativa de ISRC')
      }
    })

    log.info(
      {
        naFila: pendentes.length,
        consultadas,
        comIsrc: resultado.isrcPreenchidos,
        requisicoesDeAlbum: resultado.isrcRequisicoesDeAlbum,
        porAlbum: resultado.isrcResolvidosPorAlbum,
        umAUm: resultado.isrcResolvidosUmAUm,
      },
      'Observatório: ISRC preenchido'
    )
  } catch (err) {
    resultado.falhas++
    log.error({ err }, 'Observatório: etapa de ISRC falhou')
  }

  // -------------------------------------------------------------------------
  // 4b. Gênero e data que faltam — a ficha da página de faixa
  // -------------------------------------------------------------------------
  // Ver src/jobs/albumDetails.ts. Vem antes da descoberta porque o que ela
  // colhe já nasce com gênero e data.
  try {
    const ficha = await preencherFichaDosAlbuns(db, limiteFichaAlbum, log)
    resultado.fichaAlbumFila = ficha.fila
    resultado.fichaAlbumConsultados = ficha.consultados
    resultado.fichaAlbumFaixas = ficha.faixas
    resultado.falhas += ficha.falhas
  } catch (err) {
    resultado.falhas++
    log.error({ err }, 'Observatório: etapa da ficha dos álbuns falhou')
  }

  // -------------------------------------------------------------------------
  // 4c. A ficha da página de artista
  // -------------------------------------------------------------------------
  // Ver src/jobs/artistDetails.ts. Vem depois da 4b e antes da descoberta:
  // os artistas que a descoberta trouxer hoje entram na fila amanhã.
  try {
    const ficha = await preencherFichaDosArtistas(db, limiteFichaArtista, diasFichaArtista, log)
    resultado.fichaArtistaFila = ficha.fila
    resultado.fichaArtistaConsultados = ficha.consultados
    resultado.fichaArtistaGravados = ficha.gravados
    resultado.fichaArtistaInexistentes = ficha.inexistentes
    resultado.fichaArtistaAdiados = ficha.adiados
    resultado.falhas += ficha.falhas
  } catch (err) {
    resultado.falhas++
    log.error({ err }, 'Observatório: etapa da ficha dos artistas falhou')
  }

  // -------------------------------------------------------------------------
  // 5. Descoberta controlada de faixas semelhantes
  // -------------------------------------------------------------------------
  // Vem por último para que as faixas descobertas hoje só entrem nas filas de
  // medição individual e de ISRC amanhã. Assim a expansão inicial não
  // multiplica, na mesma rodada, todas as chamadas mais caras do job.
  try {
    const descoberta = await runCatalogDiscovery(log)
    resultado.descobertaSementes = descoberta.sementesProcessadas
    resultado.descobertaNovas = descoberta.novas
    resultado.descobertaSemCandidata = descoberta.semCandidata
    resultado.descobertaFalhasApi = descoberta.falhasApi
    resultado.descobertaNovasPorAlbum = descoberta.albumNovas
    resultado.descobertaColhidasPorAlbum = descoberta.albumFaixasColhidas
    resultado.descobertaRequisicoesDeAlbum = descoberta.albumRequisicoes
    resultado.descobertaFronteira = descoberta.fronteiraAntes
    resultado.descobertaSemelhancas = descoberta.semelhancas
    resultado.pontos += descoberta.pontos
  } catch (err) {
    resultado.falhas++
    log.error({ err }, 'Observatório: descoberta de faixas falhou')
  }

  // -------------------------------------------------------------------------
  // 6. A vizinhança dos artistas
  // -------------------------------------------------------------------------
  // Ver src/jobs/artistNeighbors.ts. Vem depois da descoberta para já somar
  // o que ela guardou hoje. Só SQL: não passa pelo gateway.
  try {
    const vizinhanca = await remontarVizinhanca(db, lotesVizinhanca, log)
    resultado.vizinhancaPares = vizinhanca.pares
    resultado.vizinhancaArtistas = vizinhanca.artistas
    resultado.vizinhancaDiretos = vizinhanca.diretos
    resultado.vizinhancaSegundo = vizinhanca.segundo
    resultado.falhas += vizinhanca.falhas
  } catch (err) {
    resultado.falhas++
    log.error({ err }, 'Observatório: etapa da vizinhança falhou')
  }

  const deezer = contadoresDeezer()
  const falhasDeezer =
    deezer.quotaEsgotada + deezer.rede + Object.values(deezer.http).reduce((a, b) => a + b, 0)
  log.info(
    { ...resultado, deezer, segundos: Math.round((Date.now() - inicio) / 1000) },
    'Observatório: rodada concluída'
  )
  if (falhasDeezer > 0) {
    // Repetido de propósito, no nível certo: um grep por level 40 tem que
    // achar a noite em que o Deezer falhou sem ler o objeto da rodada inteira.
    warn(
      { falhas: falhasDeezer, ...deezer },
      'Observatório: o Deezer falhou em requisições desta rodada'
    )
  }
  return resultado
}
