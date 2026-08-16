// src/lib/deezer.ts
// A fonte do site (Deezer — API pública, sem chave, sem token, sem market=).
//   - track.rank    -> popularidade (sobe quando a faixa toca mais)
//   - artist.nb_fan -> fama do artista (usada no multiplicador dos Stakes)
//   - track.isrc    -> a identidade da gravação, que é o endereço das páginas
//
// Era só a métrica dos Stakes: a faixa vinha do Spotify e era casada aqui pelo
// ISRC (exato) ou por busca textual. Desde a fase 3 do plano de independência a
// busca também nasce daqui, então esse casamento deixou de existir na maior
// parte dos casos — a faixa já vem com id do Deezer e ISRC em mãos.
//
// Este arquivo NÃO passa pela fila de src/lib/deezerCatalog.ts, de propósito:
// aqui as chamadas nascem de ação do usuário (buscar, salvar, abrir uma
// página) e não podem esperar atrás de um job noturno.

interface DeezerJson {
  id?: number
  title?: string
  title_short?: string
  isrc?: string
  duration?: number
  rank?: number
  nb_fan?: number
  explicit_lyrics?: boolean
  preview?: string
  release_date?: string
  picture_xl?: string
  picture_big?: string
  md5_image?: string
  artist?: { id?: number; name?: string; picture_big?: string; md5_image?: string }
  album?: { id?: number; title?: string; cover_xl?: string; cover_big?: string; md5_image?: string }
  contributors?: { id?: number; name?: string }[]
  genres?: { data?: { name?: string }[] }
  error?: { code?: number; message?: string }
  data?: DeezerJson[]
}

async function dz(path: string): Promise<DeezerJson | null> {
  try {
    const r = await fetch('https://api.deezer.com' + path)
    if (!r.ok) return null
    return (await r.json()) as DeezerJson
  } catch {
    return null
  }
}

export interface DeezerResolved {
  deezerTrackId: string
  deezerArtistId: string
  rank: number
  nbFan: number
}

/**
 * Acha a faixa no Deezer (ISRC primeiro, depois busca textual) e o nº de fãs do
 * artista. Retorna null se não conseguir casar.
 */
export async function resolveTrack(opts: {
  isrc?: string | null
  artist: string
  title: string
}): Promise<DeezerResolved | null> {
  let track: DeezerJson | null = null

  if (opts.isrc) {
    const t = await dz('/track/isrc:' + encodeURIComponent(opts.isrc))
    if (t && t.id && !t.error) track = t
  }

  if (!track) {
    const q = encodeURIComponent(`${opts.artist} ${opts.title}`.trim())
    const s = await dz('/search?limit=1&q=' + q)
    track = s?.data?.[0] ?? null
  }

  if (!track || !track.id) return null

  const artistId = track.artist?.id
  let nbFan = 0
  if (artistId) {
    const a = await dz('/artist/' + artistId)
    if (a && !a.error) nbFan = Number(a.nb_fan) || 0
  }

  return {
    deezerTrackId: String(track.id),
    deezerArtistId: artistId != null ? String(artistId) : '',
    rank: Number(track.rank) || 0,
    nbFan,
  }
}

/**
 * Gêneros do álbum da faixa identificada pelo ISRC, ou null. O Spotify deixa
 * `genres` vazio para a maioria dos artistas BR/indie, então a página de track
 * usa isto como fallback. Ex.: ["Rap/Hip Hop"].
 */
export async function fetchDeezerGenresByISRC(isrc: string): Promise<string[] | null> {
  if (!isrc) return null

  const track = await dz('/track/isrc:' + encodeURIComponent(isrc))
  const albumId = track?.album?.id
  if (!track || track.error || !albumId) return null

  const album = await dz('/album/' + albumId)
  const names = album?.genres?.data
    ?.map((g) => g.name)
    .filter((n): n is string => !!n)
  return names && names.length > 0 ? names : null
}

/* --------------------------------------------------------- busca de faixas */

/**
 * A faixa como o app e a UI de escolha consomem. Neutra de propósito: nada aqui
 * nomeia uma plataforma, porque o `id` é a identidade da GRAVAÇÃO (o ISRC) e é
 * ela que endereça a página.
 */
export interface FaixaDaBusca {
  /** ISRC quando existe; id do Deezer como escape. É o que vai em /track/<id>. */
  id: string
  title: string
  artist: string
  /** chave opaca do acervo, se a faixa for salva a partir daqui */
  uri: string
  isrc: string | null
  deezerTrackId: string
  deezerArtistId: string | null
  deezerAlbumId: string | null
  albumName: string | null
  /** segundos (o Deezer conta em segundos; o Spotify contava em ms) */
  duration: number
  explicit: boolean
  releaseDate: string | null
  /** miniatura para as linhas da lista */
  thumbnail: string | null
  /** capa grande para o hero */
  cover: string | null
  /** MP3 de 30 s. URL assinada e de vida curta — não gravar em lugar nenhum. */
  preview: string | null
  /** número cru do Deezer; quem quiser 0-100 aplica popScore() */
  rank: number
}

function capaDoMd5(md5: string, px: number): string {
  return `https://cdn-images.dzcdn.net/images/cover/${md5}/${px}x${px}-000000-80-0-0.jpg`
}

function paraFaixaDaBusca(t: DeezerJson): FaixaDaBusca | null {
  if (t.id == null) return null
  const titulo = t.title || t.title_short
  if (!titulo) return null

  const md5 = t.album?.md5_image
  const grande = t.album?.cover_xl || t.album?.cover_big || (md5 ? capaDoMd5(md5, 1000) : null)
  const pequena = md5 ? capaDoMd5(md5, 250) : grande

  const nomes = (t.contributors?.length ? t.contributors : t.artist ? [t.artist] : [])
    .map((a) => a?.name)
    .filter((n): n is string => !!n)

  const isrc = t.isrc ?? null

  return {
    id: isrc || String(t.id),
    title: titulo,
    artist: nomes.join(', ') || '—',
    uri: isrc ? `isrc:${isrc}` : `deezer:track:${t.id}`,
    isrc,
    deezerTrackId: String(t.id),
    deezerArtistId: t.artist?.id != null ? String(t.artist.id) : null,
    deezerAlbumId: t.album?.id != null ? String(t.album.id) : null,
    albumName: t.album?.title ?? null,
    duration: Number(t.duration) || 0,
    explicit: !!t.explicit_lyrics,
    releaseDate: t.release_date || null,
    thumbnail: pequena,
    cover: grande,
    preview: t.preview || null,
    rank: Number(t.rank) || 0,
  }
}

/**
 * Busca de faixas para a UI (escolher faixa nos Stakes, adicionar à playlist).
 *
 * Substitui `searchSpotifyTracks`, que foi um dos endpoints a responder 429 com
 * Retry-After de 3h24 na sondagem de 15/08/2026 — ou seja, a busca do app
 * parava de funcionar por horas. Este não tem chave nem token para expirar.
 */
export async function searchTracks(query: string, limit = 10): Promise<FaixaDaBusca[]> {
  const q = query.trim()
  if (!q) return []
  const safeLimit = Math.min(Math.max(1, Math.floor(limit)), 50)

  const res = await dz(`/search?limit=${safeLimit}&q=${encodeURIComponent(q)}`)
  return (res?.data ?? []).flatMap((t) => {
    const f = paraFaixaDaBusca(t)
    return f ? [f] : []
  })
}

/** A ficha de uma gravação pelo ISRC. Uma requisição, sem chave. */
export async function getTrackByIsrc(isrc: string): Promise<FaixaDaBusca | null> {
  const codigo = isrc.trim()
  if (!codigo) return null
  const t = await dz('/track/isrc:' + encodeURIComponent(codigo))
  if (!t || t.error) return null
  return paraFaixaDaBusca(t)
}

/** Nº de fãs do artista no Deezer — o equivalente honesto de "seguidores". */
export async function getArtistFans(deezerArtistId: string): Promise<number | null> {
  if (!deezerArtistId) return null
  const a = await dz('/artist/' + encodeURIComponent(deezerArtistId))
  if (!a || a.error) return null
  return Number(a.nb_fan) || 0
}

/** Gêneros de um álbum já identificado. Ex.: ["Rap/Hip Hop"]. */
export async function getAlbumGenres(deezerAlbumId: string): Promise<string[] | null> {
  if (!deezerAlbumId) return null
  const album = await dz('/album/' + encodeURIComponent(deezerAlbumId))
  if (!album || album.error) return null
  const nomes = album.genres?.data?.map((g) => g.name).filter((n): n is string => !!n)
  return nomes && nomes.length > 0 ? nomes : null
}

/**
 * Rank atual de uma faixa pelo id Deezer (usado no job diário).
 * `notFound` = faixa saiu do Deezer (code 800). Outras falhas são transitórias.
 */
export async function getTrackRank(
  deezerTrackId: string
): Promise<{ rank: number | null; notFound: boolean }> {
  const t = await dz('/track/' + deezerTrackId)
  if (!t) return { rank: null, notFound: false } // rede/transitório
  if (t.error) {
    return { rank: null, notFound: t.error.code === 800 }
  }
  if (typeof t.rank !== 'number') return { rank: null, notFound: false }
  return { rank: t.rank, notFound: false }
}
