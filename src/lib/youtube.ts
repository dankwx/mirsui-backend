// src/lib/youtube.ts
// Busca o vídeo do YouTube de uma faixa via YouTube Data API. Porta o
// utils/youtubeService.ts do front. Sem YOUTUBE_API_KEY, retorna null
// silenciosamente (a tela mostra "Vídeo não disponível").

interface YouTubeVideo {
  id: { videoId: string }
}

interface YouTubeSearchResponse {
  items?: YouTubeVideo[]
}

/**
 * Retorna o videoId do primeiro resultado da busca "título artista", ou null.
 */
export async function searchYouTubeVideoId(
  trackName: string,
  artistName: string
): Promise<string | null> {
  const apiKey = process.env.YOUTUBE_API_KEY
  if (!apiKey) return null

  const query = encodeURIComponent(`${trackName} ${artistName}`.trim())

  try {
    const res = await fetch(
      `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=1&q=${query}&key=${apiKey}`
    )
    if (!res.ok) {
      console.error('Falha ao buscar no YouTube:', res.status)
      return null
    }
    const data = (await res.json()) as YouTubeSearchResponse
    return data.items?.[0]?.id?.videoId ?? null
  } catch (error) {
    console.error('Erro ao buscar no YouTube:', error)
    return null
  }
}
