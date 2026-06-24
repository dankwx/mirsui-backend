// src/lib/spotify.ts
// Cliente da Web API do Spotify usando o fluxo client_credentials (sem usuário).
// Porta o utils/spotifyService.ts do front (Next.js) para o backend, para que o
// app mobile não precise embutir as credenciais do Spotify.

interface SpotifyTokenResponse {
  access_token: string
  token_type: string
  expires_in: number
}

export interface SpotifyTrack {
  album: {
    id: string
    name: string
    images: { url: string }[]
    release_date: string
    release_date_precision?: string
    total_tracks: number
  }
  artists: { name: string; id: string }[]
  name: string
  popularity: number
  uri: string
  duration_ms: number
  id: string
  explicit: boolean
  track_number: number
  external_ids?: { isrc?: string }
}

export interface SpotifyArtist {
  id: string
  name: string
  images: { url: string }[]
  followers: { total: number }
  genres: string[]
  popularity: number
  uri: string
}

// Cache do token de aplicação (válido por toda a instância do processo).
let cachedAccessToken: string | null = null
let cachedTokenExpiry: number | null = null

async function getAccessToken(): Promise<string | null> {
  const clientId = process.env.SPOTIFY_CLIENT_ID
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET

  if (!clientId || !clientSecret) {
    console.error('SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET não definidos.')
    return null
  }

  if (cachedAccessToken && cachedTokenExpiry && Date.now() < cachedTokenExpiry) {
    return cachedAccessToken
  }

  try {
    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${auth}`,
      },
      body: 'grant_type=client_credentials',
    })

    if (!res.ok) {
      console.error('Falha ao obter token do Spotify:', res.status, await res.text())
      return null
    }

    const data = (await res.json()) as SpotifyTokenResponse
    cachedAccessToken = data.access_token
    // Renova 5 minutos antes de expirar.
    cachedTokenExpiry = Date.now() + data.expires_in * 1000 - 5 * 60 * 1000
    return cachedAccessToken
  } catch (error) {
    console.error('Erro ao buscar token do Spotify:', error)
    return null
  }
}

async function spotifyFetch<T>(path: string): Promise<T | null> {
  const token = await getAccessToken()
  if (!token) return null

  try {
    const res = await fetch(`https://api.spotify.com/v1${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    })

    if (!res.ok) {
      if (res.status === 401) {
        // Token expirou — força renovação na próxima chamada.
        cachedAccessToken = null
        cachedTokenExpiry = null
      }
      console.error(`Falha na requisição ao Spotify (${path}):`, res.status)
      return null
    }

    return (await res.json()) as T
  } catch (error) {
    console.error(`Erro na requisição ao Spotify (${path}):`, error)
    return null
  }
}

export function fetchSpotifyTrackInfo(trackId: string): Promise<SpotifyTrack | null> {
  return spotifyFetch<SpotifyTrack>(`/tracks/${trackId}`)
}

export function fetchSpotifyArtistInfo(artistId: string): Promise<SpotifyArtist | null> {
  return spotifyFetch<SpotifyArtist>(`/artists/${artistId}`)
}

interface SpotifySearchResponse {
  tracks?: { items: SpotifyTrack[] }
}

// Busca faixas no Spotify (capa, metadados, ISRC) — usada para escolher a faixa
// nos Stakes. A popularidade/multiplicador depois vem do Deezer (ver Stake.md).
export async function searchSpotifyTracks(
  query: string,
  limit = 10
): Promise<SpotifyTrack[]> {
  const q = query.trim()
  if (!q) return []
  const safeLimit = Math.min(Math.max(1, Math.floor(limit)), 20)
  const res = await spotifyFetch<SpotifySearchResponse>(
    `/search?q=${encodeURIComponent(q)}&type=track&limit=${safeLimit}&market=BR`
  )
  return res?.tracks?.items ?? []
}
