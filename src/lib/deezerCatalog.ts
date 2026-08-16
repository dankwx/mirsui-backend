// src/lib/deezerCatalog.ts
// Varredura do catálogo do Deezer para o Observatório (ver migrations/009_observatorio.sql).
//
// Duas coisas mandam no desenho deste arquivo:
//
// 1. O CHART JÁ TRAZ O RANK.
//    /chart/{genero}/tracks devolve até 300 faixas e cada uma vem com o campo
//    `rank`. Ou seja: uma requisição mede 300 faixas. É por isso que a varredura
//    por gênero é a espinha do job — 28 requisições cobrem ~7.700 faixas por
//    noite. Medir uma a uma (/track/{id}) só é preciso para faixa que já está
//    no Observatório e caiu fora do chart — é a parte que custa uma requisição
//    por faixa, e por isso a que dita quanto tempo a rodada leva.
//
// 2. RATE LIMIT.
//    O Deezer corta em ~50 requisições a cada 5s. Ele não devolve Retry-After:
//    responde erro 4 ("Quota limit exceeded") ou simplesmente para. Todo acesso
//    daqui passa por `throttled()`, que espaça as partidas e limita quantas
//    requisições ficam em voo ao mesmo tempo.
//
// Este arquivo tem o próprio `dz()` em vez de reusar o de src/lib/deezer.ts de
// propósito: lá as chamadas nascem de ação do usuário (resolver uma faixa que
// ele acabou de salvar) e não podem entrar numa fila global; aqui são de um job
// noturno, onde ser lento não custa nada.

const BASE = 'https://api.deezer.com'

// ~8 req/s, com folga sob o teto de 10 req/s (50 a cada 5s).
const INTERVALO_MS = 125
// Teto de requisições em voo. A ~500ms de latência, 8 partidas por segundo
// deixam ~4 abertas ao mesmo tempo; o teto existe para o dia em que o Deezer
// ficar lento, quando sem ele a fila abriria dezenas de conexões de uma vez.
const EM_VOO_MAX = 6
const RETENTATIVAS_QUOTA = 2
const ESPERA_QUOTA_MS = 5_000

interface DeezerErro {
  code?: number
  message?: string
}

interface DeezerArtista {
  id?: number
  name?: string
}

interface DeezerAlbum {
  id?: number
  title?: string
  cover?: string
  cover_medium?: string
  md5_image?: string
  // Só vêm em /artist/{id}/albums, não no álbum embutido na faixa.
  record_type?: string
  release_date?: string
}

interface DeezerArtistaRelacionado {
  id?: number
  name?: string
  nb_fan?: number
}

interface DeezerFaixa {
  id?: number
  title?: string
  title_short?: string
  rank?: number
  isrc?: string
  artist?: DeezerArtista
  album?: DeezerAlbum
  error?: DeezerErro
}

interface DeezerLista<T> {
  data?: T[]
  total?: number
  error?: DeezerErro
}

interface DeezerGenero {
  id?: number
  name?: string
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// A fila era serial: cada chamada esperava a resposta da anterior e só então
// contava o intervalo. Isso fazia a latência do Deezer (~500ms) mandar no ritmo
// e a varredura andava a ~1,5 req/s — menos de um quinto do que a cota permite.
// Enquanto o job tinha teto de faixas por rodada isso passava despercebido; sem
// teto, cada req/s desperdiçado vira hora de rodada. Agora o que se agenda é a
// PARTIDA de cada chamada, uma a cada INTERVALO_MS, e a resposta que demore
// segura só a vaga dela.

/** Instante (ms) em que a próxima chamada pode partir. */
let proximaLargada = 0
let emVoo = 0
const esperandoVaga: (() => void)[] = []

async function pegarVaga(): Promise<void> {
  // Ao acordar, a vaga já veio de quem terminou — por isso não incrementa aqui.
  if (emVoo >= EM_VOO_MAX) return new Promise<void>((r) => esperandoVaga.push(r))
  emVoo++
}

function liberarVaga(): void {
  const proximo = esperandoVaga.shift()
  if (proximo) proximo()
  else emVoo--
}

/** Reserva o próximo horário de partida e espera até ele chegar. */
async function aguardarLargada(): Promise<void> {
  const agora = Date.now()
  const largada = Math.max(agora, proximaLargada)
  proximaLargada = largada + INTERVALO_MS
  if (largada > agora) await sleep(largada - agora)
}

/**
 * Segura a fila INTEIRA por um tempo. Quota estourada não é problema de uma
 * chamada só: se apenas quem levou o erro esperasse, as outras continuariam
 * partindo no mesmo ritmo e manteriam o Deezer irritado.
 */
function frearFila(ms: number): void {
  proximaLargada = Math.max(proximaLargada, Date.now() + ms)
}

async function throttled<T>(fn: () => Promise<T>): Promise<T> {
  // A vaga vem antes do horário: reservar largada enquanto se está bloqueado
  // deixaria horários vencidos acumulados, e eles sairiam todos de uma vez.
  await pegarVaga()
  try {
    await aguardarLargada()
    return await fn()
  } finally {
    liberarVaga()
  }
}

async function dz<T>(path: string): Promise<T | null> {
  return throttled(async () => {
    for (let tentativa = 0; tentativa <= RETENTATIVAS_QUOTA; tentativa++) {
      // A primeira largada é a que throttled() já esperou; as retentativas
      // pegam um horário novo, que o freio abaixo empurrou para a frente.
      if (tentativa > 0) await aguardarLargada()
      try {
        const r = await fetch(BASE + path)
        if (!r.ok) return null
        const json = (await r.json()) as T & { error?: DeezerErro }
        // code 4 = quota estourada. Vale esperar e tentar de novo; qualquer
        // outro erro é da própria faixa e quem chamou decide o que fazer.
        if (json?.error?.code === 4 && tentativa < RETENTATIVAS_QUOTA) {
          frearFila(ESPERA_QUOTA_MS)
          continue
        }
        return json
      } catch {
        return null
      }
    }
    return null
  })
}

/**
 * `code: 800` (DataException, "no data") é RESPOSTA, não falha.
 *
 * O Deezer devolve HTTP 200 com este erro quando o recurso existe mas não tem o
 * que se pediu — artista sem rádio, sem relacionados, sem álbum. Medido em
 * 16/08/2026: 10 de 12 artistas da fila de sementes devolvem 800 em
 * `/artist/{id}/radio`, porque são artistas pequenos demais para a Deezer ter
 * montado uma rádio.
 *
 * A distinção importa para todo job que grava marca de "já tentei": tratar 800
 * como falha transitória faz a semente voltar à fila todas as noites, para
 * sempre, falhando sempre — e a fila entope de sementes impossíveis sem que
 * nada no log diga isso. É a mesma lição que `faixasDoAlbum` já registrava
 * ("o álbum não tem esta faixa" contra "não consegui perguntar"); aqui ela vale
 * para os três endpoints de descoberta.
 */
const SEM_DADOS = 800

/** Extrai o md5 da capa: ou vem pronto, ou está no meio da URL do CDN. */
function extrairCoverMd5(album?: DeezerAlbum): string | null {
  if (album?.md5_image) return album.md5_image
  const url = album?.cover_medium || album?.cover || ''
  const m = url.match(/\/images\/cover\/([0-9a-f]{32})\//i)
  return m ? m[1] : null
}

export interface FaixaObservada {
  deezer_track_id: string
  deezer_artist_id: string | null
  /**
   * Álbum da faixa. Sempre veio nas respostas do Deezer e era descartado —
   * guardávamos só o título e o md5 da capa. É o que permite resolver ISRC em
   * lote por /album/{id}/tracks, ~10x mais barato que uma requisição por faixa
   * (migration 024).
   */
  deezer_album_id: string | null
  isrc: string | null
  title: string
  artist_name: string
  album_name: string | null
  cover_md5: string | null
  genre: string | null
  source_list: string
  rank: number
}

export interface ResultadoRadioArtista {
  faixas: FaixaObservada[]
  /** Rede, quota ou resposta inválida: não marque a semente, tente amanhã. */
  falhou: boolean
}

/**
 * Gêneros do Deezer. Vem da API para não engessar ids que podem mudar; se a
 * chamada falhar, cai numa lista mínima conhecida para o job não passar a noite
 * em branco por causa de uma requisição.
 */
export async function listarGeneros(): Promise<{ id: number; name: string }[]> {
  const res = await dz<DeezerLista<DeezerGenero>>('/genre')
  const vindos = (res?.data ?? [])
    .filter((g): g is { id: number; name: string } =>
      typeof g.id === 'number' && typeof g.name === 'string'
    )
    .map((g) => ({ id: g.id, name: g.name }))

  if (vindos.length > 0) return vindos

  return [
    { id: 0, name: 'Todos' },
    { id: 132, name: 'Pop' },
    { id: 116, name: 'Rap/Hip Hop' },
    { id: 152, name: 'Rock' },
    { id: 113, name: 'Dance' },
    { id: 165, name: 'R&B' },
    { id: 85, name: 'Alternativo' },
    { id: 106, name: 'Electro' },
    { id: 12, name: 'Música Brasileira' },
    { id: 81, name: 'Latina' },
    { id: 464, name: 'Metal' },
    { id: 169, name: 'Soul & Funk' },
  ]
}

/**
 * Chart de um gênero. Uma requisição, até `limite` faixas já com rank.
 *
 * O teto real do endpoint é 300, não 100 — `?limit=500` devolve 300 e a
 * paginação por `index` confirma que a lista acaba ali (index=500 volta vazio).
 * Medido em 15/08/2026 nos 28 gêneros: 25 devolvem 300 (chart/0 e Clássica
 * devolvem 299, Música Indiana 280).
 */
export async function chartDoGenero(
  generoId: number,
  generoNome: string | null,
  limite = 300
): Promise<FaixaObservada[]> {
  const res = await dz<DeezerLista<DeezerFaixa>>(
    `/chart/${generoId}/tracks?limit=${limite}`
  )
  if (!res?.data) return []

  return res.data.flatMap((t) => {
    if (t.id == null || typeof t.rank !== 'number') return []
    const titulo = t.title || t.title_short
    const artista = t.artist?.name
    if (!titulo || !artista) return []

    return [
      {
        deezer_track_id: String(t.id),
        deezer_artist_id: t.artist?.id != null ? String(t.artist.id) : null,
        deezer_album_id: t.album?.id != null ? String(t.album.id) : null,
        isrc: t.isrc ?? null,
        title: titulo,
        artist_name: artista,
        album_name: t.album?.title ?? null,
        cover_md5: extrairCoverMd5(t.album),
        genre: generoId === 0 ? null : generoNome,
        source_list: `chart:${generoId}`,
        rank: t.rank,
      },
    ]
  })
}

export interface FaixaDetalhada {
  rank: number
  isrc: string | null
  deezer_artist_id: string | null
  deezer_album_id: string | null
  title: string | null
  artist_name: string | null
  album_name: string | null
  cover_md5: string | null
}

/**
 * Ficha completa de uma faixa pelo id do Deezer. `notFound` = saiu do catálogo
 * (erro 800); qualquer outra falha é transitória e vale tentar amanhã.
 *
 * Devolve ISRC junto com o rank de propósito: /track/{id} traz os dois na mesma
 * resposta, e o ISRC é a única ponte para o id do Spotify — que é como as
 * páginas do site são endereçadas. O chart não traz esse campo, então esta é a
 * ÚNICA forma de casar uma faixa de chart com a página dela.
 */
export async function buscarFaixa(deezerTrackId: string): Promise<{
  faixa: FaixaDetalhada | null
  notFound: boolean
}> {
  const t = await dz<DeezerFaixa>('/track/' + deezerTrackId)
  if (!t) return { faixa: null, notFound: false }
  if (t.error) return { faixa: null, notFound: t.error.code === 800 }
  if (typeof t.rank !== 'number') return { faixa: null, notFound: false }

  return {
    faixa: {
      rank: t.rank,
      isrc: t.isrc ?? null,
      deezer_artist_id: t.artist?.id != null ? String(t.artist.id) : null,
      deezer_album_id: t.album?.id != null ? String(t.album.id) : null,
      title: t.title || t.title_short || null,
      artist_name: t.artist?.name ?? null,
      album_name: t.album?.title ?? null,
      cover_md5: extrairCoverMd5(t.album),
    },
    notFound: false,
  }
}

export interface FaixaDoAlbum {
  deezer_track_id: string
  deezer_artist_id: string | null
  isrc: string | null
  title: string | null
  artist_name: string | null
  rank: number | null
}

/**
 * As faixas de um álbum, com ISRC e rank, numa requisição só.
 *
 * É a alavanca do item 5 da análise de escala (§4.2): a etapa de ISRC gastava
 * 1 requisição por faixa em `/track/{id}` só para ler um campo. Um álbum tem
 * 10-14 faixas, então o custo cai ~10x — e isso deixou de ser otimização
 * quando o ISRC virou o endereço das páginas, porque é esta etapa que dá
 * página às faixas novas.
 *
 * Medido em 15/08/2026: `/album/302127/tracks` devolve 14 faixas, 14 com ISRC
 * e 14 com rank. (`/artist/{id}/top` NÃO traz ISRC — só o de álbum traz.)
 *
 * `falhou` distingue "o álbum não tem esta faixa" de "não consegui perguntar".
 * A diferença é tudo para um job que grava marca de "já tentei": confundir as
 * duas queima a faixa por causa de um erro de rede.
 */
export async function faixasDoAlbum(
  deezerAlbumId: string
): Promise<{ faixas: FaixaDoAlbum[]; falhou: boolean }> {
  const res = await dz<DeezerLista<DeezerFaixa>>(
    `/album/${encodeURIComponent(deezerAlbumId)}/tracks?limit=300`
  )

  if (!res || res.error || !Array.isArray(res.data)) {
    return { faixas: [], falhou: true }
  }

  const faixas = res.data.flatMap((t) => {
    if (t.id == null) return []
    return [
      {
        deezer_track_id: String(t.id),
        deezer_artist_id: t.artist?.id != null ? String(t.artist.id) : null,
        isrc: t.isrc ?? null,
        title: t.title || t.title_short || null,
        artist_name: t.artist?.name ?? null,
        rank: typeof t.rank === 'number' ? t.rank : null,
      },
    ]
  })

  return { faixas, falhou: false }
}

export interface ArtistaRelacionado {
  deezer_artist_id: string
  artist_name: string | null
  /** Fãs no Deezer. É o dial de obscuridade da descoberta por álbum. */
  nb_fan: number | null
}

/**
 * Os 20 artistas que o Deezer considera próximos de um dado artista.
 *
 * É a primeira perna da descoberta por álbum (ADR 002). O que torna este
 * endpoint útil e o `/radio` não é `nb_fan`: ele vem de graça na resposta e
 * permite ESCOLHER o quão obscuro é o próximo salto, em vez de aceitar o que o
 * motor de recomendação achar melhor — que é sempre o mais popular.
 *
 * Medido em 16/08/2026: `/artist/27/related` devolve 20 artistas, 20/20 com
 * `nb_fan`, de 1.656 (Kojak) a 1.455.372 (The Chemical Brothers).
 *
 * ATENÇÃO — o grafo seca: `/artist/58732/related` (artista pequeno) devolve
 * ZERO. Não dá para afundar em profundidade saltando de obscuro em obscuro; a
 * caminhada precisa ser re-semeada do catálogo. É limitação da fonte, e é a
 * razão de o job trabalhar a um salto só.
 */
export async function relacionadosDoArtista(
  deezerArtistId: string
): Promise<{ artistas: ArtistaRelacionado[]; falhou: boolean }> {
  const res = await dz<DeezerLista<DeezerArtistaRelacionado>>(
    `/artist/${encodeURIComponent(deezerArtistId)}/related`
  )

  if (res?.error?.code === SEM_DADOS) return { artistas: [], falhou: false }

  if (!res || res.error || !Array.isArray(res.data)) {
    return { artistas: [], falhou: true }
  }

  const artistas = res.data.flatMap((a) => {
    if (a.id == null) return []
    return [
      {
        deezer_artist_id: String(a.id),
        artist_name: a.name ?? null,
        nb_fan: typeof a.nb_fan === 'number' ? a.nb_fan : null,
      },
    ]
  })

  // Fronteira vazia não é erro: o artista existe, só não tem vizinhos.
  return { artistas, falhou: false }
}

export interface AlbumDoArtista {
  deezer_album_id: string
  title: string | null
  cover_md5: string | null
  /** album | single | ep | compilation */
  record_type: string | null
  release_date: string | null
}

/**
 * A discografia de um artista, paginada.
 *
 * Segunda perna da descoberta por álbum. Uma requisição devolve a lista inteira
 * (medido: 36 álbuns do Daft Punk com `limit=100`), e cada álbum vira depois
 * uma chamada a `faixasDoAlbum` que traz 8-14 faixas com rank E ISRC.
 *
 * `indice` existe porque um artista pode ter mais álbuns do que cabe no
 * orçamento de uma noite: a fronteira guarda onde parou e a rodada seguinte
 * continua dali. A paginação por `index` foi verificada contra a API.
 *
 * `total` volta junto para o job saber quando a discografia acabou — sem isso
 * o artista ficaria na fila para sempre, pedindo uma página vazia por noite.
 */
export async function albunsDoArtista(
  deezerArtistId: string,
  indice = 0,
  limite = 50
): Promise<{ albuns: AlbumDoArtista[]; total: number; falhou: boolean }> {
  const safeLimit = Math.min(100, Math.max(1, Math.floor(limite)))
  const safeIndex = Math.max(0, Math.floor(indice))
  const res = await dz<DeezerLista<DeezerAlbum>>(
    `/artist/${encodeURIComponent(deezerArtistId)}/albums` +
      `?limit=${safeLimit}&index=${safeIndex}`
  )

  // Sem álbum é discografia vazia, não erro: o job marca o artista como
  // exaurido e ele sai da fronteira em vez de ser repescado toda noite.
  if (res?.error?.code === SEM_DADOS) return { albuns: [], total: 0, falhou: false }

  if (!res || res.error || !Array.isArray(res.data)) {
    return { albuns: [], total: 0, falhou: true }
  }

  const albuns = res.data.flatMap((a) => {
    if (a.id == null) return []
    return [
      {
        deezer_album_id: String(a.id),
        title: a.title ?? null,
        cover_md5: extrairCoverMd5(a),
        record_type: a.record_type ?? null,
        release_date: a.release_date ?? null,
      },
    ]
  })

  return { albuns, total: typeof res.total === 'number' ? res.total : albuns.length, falhou: false }
}

/**
 * Acha no Deezer uma faixa que só temos por texto (usado para trazer o acervo
 * do site para o Observatório). Passa pela mesma fila do resto do job.
 */
export async function buscarPorTexto(
  artista: string,
  titulo: string
): Promise<FaixaObservada | null> {
  const q = encodeURIComponent(`${artista} ${titulo}`.trim())
  const res = await dz<DeezerLista<DeezerFaixa>>('/search?limit=1&q=' + q)
  const t = res?.data?.[0]
  if (!t?.id || typeof t.rank !== 'number') return null

  const nomeArtista = t.artist?.name || artista
  const nomeTitulo = t.title || t.title_short || titulo

  return {
    deezer_track_id: String(t.id),
    deezer_artist_id: t.artist?.id != null ? String(t.artist.id) : null,
    deezer_album_id: t.album?.id != null ? String(t.album.id) : null,
    isrc: t.isrc ?? null,
    title: nomeTitulo,
    artist_name: nomeArtista,
    album_name: t.album?.title ?? null,
    cover_md5: extrairCoverMd5(t.album),
    genre: null,
    source_list: 'acervo',
    rank: t.rank,
  }
}

/**
 * Rádio de um artista: mistura faixas do próprio artista e de artistas
 * relacionados. É a aproximação pública do Deezer para "música semelhante";
 * ao contrário do endpoint de artistas relacionados, uma chamada já devolve
 * as próprias faixas candidatas com rank e metadados suficientes para entrar
 * no Observatório.
 *
 * O endpoint não traz ISRC. A etapa de ISRC do próximo snapshot completa essa
 * ponte antes de tentar resolver a faixa no Spotify.
 */
export async function radioDoArtista(
  deezerArtistId: string,
  limite = 15
): Promise<ResultadoRadioArtista> {
  const safeLimit = Math.min(100, Math.max(1, Math.floor(limite)))
  const res = await dz<DeezerLista<DeezerFaixa>>(
    `/artist/${encodeURIComponent(deezerArtistId)}/radio?limit=${safeLimit}`
  )

  // Artista sem rádio é resposta definitiva: a semente vira "sem candidata" e
  // sai da fila. Sem este caso, ela voltaria toda noite para sempre.
  if (res?.error?.code === SEM_DADOS) return { faixas: [], falhou: false }

  if (!res || res.error || !Array.isArray(res.data)) {
    return { faixas: [], falhou: true }
  }

  const faixas = res.data.flatMap((t) => {
    if (t.id == null || typeof t.rank !== 'number') return []
    const titulo = t.title || t.title_short
    const artista = t.artist?.name
    if (!titulo || !artista) return []

    return [
      {
        deezer_track_id: String(t.id),
        deezer_artist_id: t.artist?.id != null ? String(t.artist.id) : null,
        deezer_album_id: t.album?.id != null ? String(t.album.id) : null,
        isrc: null,
        title: titulo,
        artist_name: artista,
        album_name: t.album?.title ?? null,
        cover_md5: extrairCoverMd5(t.album),
        genre: null,
        source_list: `radio:${deezerArtistId}`,
        rank: t.rank,
      },
    ]
  })

  return { faixas, falhou: false }
}
