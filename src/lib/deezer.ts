// src/lib/deezer.ts
// Fonte da métrica dos Stakes (Deezer — API pública, sem chave).
//   - track.rank   -> popularidade (sobe quando a faixa toca mais)
//   - artist.nb_fan -> fama do artista (usada no multiplicador)
// A faixa escolhida no Spotify é casada com o Deezer pelo ISRC (exato) e,
// na falta dele, por busca textual "artista título".

interface DeezerJson {
  id?: number
  rank?: number
  nb_fan?: number
  artist?: { id?: number; name?: string }
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
