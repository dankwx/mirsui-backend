// src/lib/deezerCatalog.ts
// Varredura do catálogo do Deezer para o Observatório (ver migrations/009_observatorio.sql).
//
// Duas coisas mandam no desenho deste arquivo:
//
// 1. O CHART JÁ TRAZ O RANK.
//    /chart/{genero}/tracks devolve até 100 faixas e cada uma vem com o campo
//    `rank`. Ou seja: uma requisição mede 100 faixas. É por isso que a varredura
//    por gênero é a espinha do job — ~30 requisições cobrem ~3.000 faixas por
//    noite. Medir uma a uma (/track/{id}) só é preciso para faixa que já está
//    no Observatório e caiu fora do chart, e isso tem teto por rodada.
//
// 2. RATE LIMIT.
//    O Deezer corta em ~50 requisições a cada 5s. Ele não devolve Retry-After:
//    responde erro 4 ("Quota limit exceeded") ou simplesmente para. Todo acesso
//    daqui passa por `throttled()`, que serializa e espaça as chamadas.
//
// Este arquivo tem o próprio `dz()` em vez de reusar o de src/lib/deezer.ts de
// propósito: lá as chamadas nascem de ação do usuário (resolver uma faixa que
// ele acabou de salvar) e não podem entrar numa fila global; aqui são de um job
// noturno, onde ser lento não custa nada.

const BASE = 'https://api.deezer.com'

// ~8 req/s, com folga sob o teto de 10 req/s (50 a cada 5s).
const INTERVALO_MS = 125
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
  error?: DeezerErro
}

interface DeezerGenero {
  id?: number
  name?: string
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Fila serial: cada chamada espera a anterior terminar e mais INTERVALO_MS.
let fila: Promise<unknown> = Promise.resolve()

function throttled<T>(fn: () => Promise<T>): Promise<T> {
  const proxima = fila.then(async () => {
    const saida = await fn()
    await sleep(INTERVALO_MS)
    return saida
  })
  // A fila não pode morrer por causa de uma falha isolada.
  fila = proxima.catch(() => undefined)
  return proxima
}

async function dz<T>(path: string): Promise<T | null> {
  return throttled(async () => {
    for (let tentativa = 0; tentativa <= RETENTATIVAS_QUOTA; tentativa++) {
      try {
        const r = await fetch(BASE + path)
        if (!r.ok) return null
        const json = (await r.json()) as T & { error?: DeezerErro }
        // code 4 = quota estourada. Vale esperar e tentar de novo; qualquer
        // outro erro é da própria faixa e quem chamou decide o que fazer.
        if (json?.error?.code === 4 && tentativa < RETENTATIVAS_QUOTA) {
          await sleep(ESPERA_QUOTA_MS)
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
  isrc: string | null
  title: string
  artist_name: string
  album_name: string | null
  cover_md5: string | null
  genre: string | null
  source_list: string
  rank: number
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

/** Chart de um gênero. Uma requisição, até `limite` faixas já com rank. */
export async function chartDoGenero(
  generoId: number,
  generoNome: string | null,
  limite = 100
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
      title: t.title || t.title_short || null,
      artist_name: t.artist?.name ?? null,
      album_name: t.album?.title ?? null,
      cover_md5: extrairCoverMd5(t.album),
    },
    notFound: false,
  }
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
