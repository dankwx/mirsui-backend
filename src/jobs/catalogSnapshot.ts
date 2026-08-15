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
//      100 faixas já com rank.
//   2. Traz para o Observatório as faixas que os usuários salvaram e que ainda
//      não estavam sendo medidas. É a ponta obscura do catálogo — o chart sozinho
//      enviesa tudo para o que já estourou, e "antes de estourar" é a tese.
//   3. Mede individualmente quem já é observado mas não apareceu em chart hoje,
//      do menos recentemente medido para o mais recente. É o passo que faz o
//      Observatório continuar seguindo uma faixa depois que ela sai do chart —
//      inclusive na descida.
//
// Nada aqui é obrigatório para o job ser útil: se um passo falhar, os outros
// gravam mesmo assim. Um dia com metade dos pontos vale muito mais que um dia
// sem ponto nenhum, porque esse dia não volta.

import { supabaseAdmin } from '../lib/supabase'
import { popScore } from '../lib/stakePoints'
import { findSpotifyIdByIsrc } from '../lib/spotify'
import { runCatalogDiscovery } from './catalogDiscovery'
import {
  listarGeneros,
  chartDoGenero,
  buscarFaixa,
  buscarPorTexto,
  type FaixaObservada,
} from '../lib/deezerCatalog'

interface Log {
  info: (o: unknown, m?: string) => void
  error: (o: unknown, m?: string) => void
  warn?: (o: unknown, m?: string) => void
}

export interface ResultadoObservatorio {
  pontos: number
  doChart: number
  doAcervo: number
  medidasIndividuais: number
  isrcPreenchidos: number
  spotifyResolvidos: number
  spotifyNaoAchados: number
  /** requisições que falharam (429, rede): voltam à fila amanhã */
  spotifyFalhasTransitorias: number
  descobertaSementes: number
  descobertaNovas: number
  descobertaSemCandidata: number
  descobertaFalhasApi: number
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

  const vazio: ResultadoObservatorio = {
    pontos: 0,
    doChart: 0,
    doAcervo: 0,
    medidasIndividuais: 0,
    isrcPreenchidos: 0,
    spotifyResolvidos: 0,
    spotifyNaoAchados: 0,
    spotifyFalhasTransitorias: 0,
    descobertaSementes: 0,
    descobertaNovas: 0,
    descobertaSemCandidata: 0,
    descobertaFalhasApi: 0,
    desativadas: 0,
    falhas: 0,
  }

  if (!supabaseAdmin) {
    log.error({}, 'SUPABASE_SERVICE_ROLE_KEY não configurada — Observatório abortado')
    return vazio
  }
  const db = supabaseAdmin

  const maxGeneros = num('OBS_MAX_GENEROS', Infinity)
  // Este é o único teto real que sobra, e não é nosso: 100 é o máximo que
  // /chart/{id}/tracks devolve numa resposta.
  const limiteChart = num('OBS_LIMITE_CHART', 100)
  const limiteAcervo = num('OBS_LIMITE_ACERVO', Infinity)
  const limiteMedicao = num('OBS_LIMITE_MEDICAO', Infinity)
  const limiteIsrc = num('OBS_LIMITE_ISRC', Infinity)
  const limiteSpotify = num('OBS_LIMITE_SPOTIFY', Infinity)

  const resultado = { ...vazio }
  const inicio = Date.now()

  // Início do dia em UTC — mesma fronteira do índice de idempotência.
  const hojeUTC = new Date()
  hojeUTC.setUTCHours(0, 0, 0, 0)
  const hojeISO = hojeUTC.toISOString()

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
    // Gênero é barato: uma requisição cobre até 100 faixas, e o Deezer tem
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
    const salvas = await lerFila<{ track_title?: string; artist_name?: string }>(
      () => db.from('tracks').select('track_title, artist_name').order('id', { ascending: false }),
      Infinity
    )

    const unicas = new Map<string, { titulo: string; artista: string }>()
    for (const t of salvas) {
      const titulo = t.track_title
      const artista = t.artist_name
      if (!titulo || !artista) continue
      const chave = `${artista.toLowerCase()}|${titulo.toLowerCase()}`
      if (!unicas.has(chave)) unicas.set(chave, { titulo, artista })
    }

    // Só resolvemos quem ainda não está no Observatório. Como a ponte é por
    // busca textual (o acervo não guarda ISRC), comparamos pelo par já gravado.
    // Também paginado: uma lista truncada aqui não erra para o lado seguro —
    // faria o job re-buscar no Deezer, todo dia, faixa que já é observada.
    const jaObservadas = await lerFila<{ title?: string; artist_name?: string }>(
      () =>
        db
          .from('observed_tracks')
          .select('title, artist_name')
          .eq('source_list', 'acervo')
          // Ordem explícita: sem ela a paginação por .range() pode repetir ou
          // pular linhas entre uma página e outra.
          .order('deezer_track_id', { ascending: true }),
      Infinity
    )

    const conhecidas = new Set(
      jaObservadas.map(
        (o) =>
          `${String(o.artist_name ?? '').toLowerCase()}|${String(o.title ?? '').toLowerCase()}`
      )
    )

    const pendentes = [...unicas.entries()]
      .filter(([chave]) => !conhecidas.has(chave))
      .slice(0, limiteAcervo)

    // Também em paralelo, pelo mesmo motivo da etapa 3: o ritmo é da fila.
    const achadas = await Promise.all(
      pendentes.map(([, { titulo, artista }]) => buscarPorTexto(artista, titulo))
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
    log.info(
      { candidatas: pendentes.length, resolvidas: doAcervo.length },
      'Observatório: acervo incorporado'
    )
  } catch (err) {
    resultado.falhas++
    log.error({ err }, 'Observatório: incorporação do acervo falhou')
  }

  // Uma faixa não é consultada duas vezes na mesma rodada, mesmo que caia nos
  // critérios das etapas 3 e 4 ao mesmo tempo.
  const consultadasNestaRodada = new Set<string>()

  interface LinhaObservada {
    deezer_track_id: string
    deezer_artist_id: string | null
    title: string
    artist_name: string
    source_list: string | null
  }

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
  // 3. Quem não apareceu em chart hoje
  // -------------------------------------------------------------------------
  try {
    const atrasadas = await lerFila<LinhaObservada>(
      () =>
        db
          .from('observed_tracks')
          .select('deezer_track_id, deezer_artist_id, title, artist_name, source_list')
          .eq('active', true)
          .or(`last_checked_at.is.null,last_checked_at.lt.${hojeISO}`)
          .order('last_checked_at', { ascending: true, nullsFirst: true }),
      limiteMedicao
    )

    const candidatas = atrasadas.filter((r) => !vistasHoje.has(r.deezer_track_id))

    await processarEmBlocos(candidatas, async ({ medidas, sumiram }) => {
      resultado.medidasIndividuais += medidas.length
      resultado.pontos += await gravar(medidas, 'individual')
      await desativar(sumiram)
    })

    log.info(
      { medidas: resultado.medidasIndividuais, desativadas: resultado.desativadas },
      'Observatório: medições individuais concluídas'
    )
  } catch (err) {
    resultado.falhas++
    log.error({ err }, 'Observatório: medições individuais falharam')
  }

  // -------------------------------------------------------------------------
  // 4. ISRC pendente — a ponte para o Spotify
  // -------------------------------------------------------------------------
  // Faixa que entra por chart nasce sem ISRC, e sem ISRC a página
  // /track/[spotifyId] não consegue achar a curva dela. Esta etapa fecha isso.
  // A fila é "nunca tentei" e não "está sem ISRC": ver migrations/010.
  try {
    const pendentes = await lerFila<LinhaObservada>(
      () =>
        db
          .from('observed_tracks')
          .select('deezer_track_id, deezer_artist_id, title, artist_name, source_list')
          .eq('active', true)
          .is('isrc', null)
          .is('isrc_checked_at', null)
          .order('added_at', { ascending: true }),
      limiteIsrc
    )

    let consultadas = 0

    await processarEmBlocos(pendentes, async ({ medidas, sumiram, tentados }) => {
      resultado.pontos += await gravar(medidas, 'isrc')
      resultado.isrcPreenchidos += medidas.filter((m) => m.isrc != null).length
      await desativar(sumiram)

      // Marca TODOS os consultados, inclusive os que não têm ISRC no Deezer —
      // é isso que os tira da fila e deixa o resto andar.
      if (tentados.length > 0) {
        consultadas += tentados.length
        const { error: errMarca } = await db.rpc('mark_isrc_checked', { p_ids: tentados })
        if (errMarca) log.error({ err: errMarca }, 'Falha ao marcar tentativa de ISRC')
      }
    })

    log.info(
      { consultadas, comIsrc: resultado.isrcPreenchidos },
      'Observatório: ponte de ISRC atualizada'
    )
  } catch (err) {
    resultado.falhas++
    log.error({ err }, 'Observatório: etapa de ISRC falhou')
  }

  // -------------------------------------------------------------------------
  // 5. ISRC → id do Spotify: a ponte até as páginas do site
  // -------------------------------------------------------------------------
  // /track/[spotifyId] renderiza qualquer faixa válida, tenha ou não salvamento.
  // O que faltava era o identificador: sem ele, a Pilha não tinha para onde
  // apontar e as 2.602 faixas medidas ficavam órfãs. Ver migrations/014.
  //
  // A busca vai com market=BR (src/lib/spotify.ts), então faixa indisponível no
  // Brasil não resolve — de propósito: não adianta linkar o que o visitante
  // daqui não consegue tocar.
  try {
    const pendentes = await lerFila<{ deezer_track_id: string; isrc: string }>(
      () =>
        db
          .from('observed_tracks')
          .select('deezer_track_id, isrc')
          .eq('active', true)
          .not('isrc', 'is', null)
          .is('spotify_track_id', null)
          .is('spotify_checked_at', null)
          .order('added_at', { ascending: true }),
      limiteSpotify
    )

    const BLOCO_SPOTIFY = 100

    for (let i = 0; i < pendentes.length; i += BLOCO_SPOTIFY) {
      const bloco = pendentes.slice(i, i + BLOCO_SPOTIFY)
      const linhas: { deezer_track_id: string; spotify_track_id: string | null }[] = []

      for (const p of bloco) {
        // O filtro `isrc:` devolve a gravação exata — casamento por
        // identificador, não por texto.
        const { id, falhou } = await findSpotifyIdByIsrc(p.isrc)

        // Falha transitória não vira registro: se gravássemos, a faixa levaria
        // a marca de "já tentei" e nunca mais voltaria à fila por causa de um
        // 429. Fica de fora do lote e o job pega amanhã.
        if (falhou) {
          resultado.spotifyFalhasTransitorias++
          continue
        }

        linhas.push({ deezer_track_id: p.deezer_track_id, spotify_track_id: id })
        if (id) resultado.spotifyResolvidos++
        else resultado.spotifyNaoAchados++

        // Espaçamento leve: o teto do Spotify é uma janela deslizante e não um
        // número publicado, então o barato é não chegar perto dele.
        await new Promise((r) => setTimeout(r, 120))
      }

      if (linhas.length === 0) continue

      // Marca TODOS os consultados, inclusive os sem resultado: é o que os tira
      // da fila e deixa o resto andar.
      const { error: errGravar } = await db.rpc('record_spotify_ids', {
        p_rows: linhas,
      })
      if (errGravar) {
        resultado.falhas++
        log.error({ err: errGravar }, 'Falha ao gravar ids do Spotify')
      }
    }

    log.info(
      {
        consultadas: pendentes.length,
        resolvidas: resultado.spotifyResolvidos,
        semResultado: resultado.spotifyNaoAchados,
        falhasTransitorias: resultado.spotifyFalhasTransitorias,
      },
      'Observatório: ponte para o Spotify atualizada'
    )
  } catch (err) {
    resultado.falhas++
    log.error({ err }, 'Observatório: etapa do Spotify falhou')
  }

  // -------------------------------------------------------------------------
  // 6. Descoberta controlada de faixas semelhantes
  // -------------------------------------------------------------------------
  // Vem por último para que as faixas descobertas hoje só entrem nas filas de
  // medição individual, ISRC e Spotify amanhã. Assim a expansão inicial não
  // multiplica, na mesma rodada, todas as chamadas mais caras do job.
  try {
    const descoberta = await runCatalogDiscovery(log)
    resultado.descobertaSementes = descoberta.sementesProcessadas
    resultado.descobertaNovas = descoberta.novas
    resultado.descobertaSemCandidata = descoberta.semCandidata
    resultado.descobertaFalhasApi = descoberta.falhasApi
    resultado.pontos += descoberta.pontos
  } catch (err) {
    resultado.falhas++
    log.error({ err }, 'Observatório: descoberta de faixas falhou')
  }

  log.info(
    { ...resultado, segundos: Math.round((Date.now() - inicio) / 1000) },
    'Observatório: rodada concluída'
  )
  return resultado
}
