// src/lib/spotify.ts
//
// O que sobrou do Spotify no backend: UMA função, e ela é opcional.
//
// Este arquivo já foi o cliente completo da Web API — busca de faixas, ficha da
// faixa, ficha do artista, tudo com token de client_credentials. Nada disso
// existe mais aqui:
//
//   searchSpotifyTracks     -> src/lib/deezer.ts:searchTracks (sem chave)
//   fetchSpotifyTrackInfo   -> src/lib/deezer.ts:getTrackByIsrc
//   fetchSpotifyArtistInfo  -> src/lib/deezer.ts:getArtistFans
//
// A razão está medida em docs/plano-independencia-do-spotify.md: em 15/08/2026
// a credencial do projeto respondia 429 com Retry-After de 3h24 em /tracks,
// /artists, /search e /artists/{id}/albums, e 403 — que atravessa a janela de
// castigo — em /artists/{id}/top-tracks, /audio-features e /tracks?ids=. Não
// era pico de uso: era a plataforma.
//
// A única coisa que o Spotify ainda faz por nós é dizer QUAL é o id dele para
// uma gravação que já identificamos por ISRC, para que o botão "ouvir no
// Spotify" caia na faixa exata em vez de cair numa busca. É enriquecimento, não
// requisito: sem SPOTIFY_CLIENT_ID/SECRET o site sobe e funciona inteiro, e é
// esse o teste de aceitação do plano.

interface SpotifyTokenResponse {
  access_token: string
  token_type: string
  expires_in: number
}

interface SpotifySearchResponse {
  tracks?: { items: { id: string }[] }
}

/**
 * Quanto se aceita esperar por um 429 antes de desistir da tentativa.
 *
 * Existe porque esta função vive dentro de uma requisição HTTP agora. A janela
 * de castigo do Spotify é medida em HORAS, não nos 30 s que a documentação
 * descreve — o valor observado em 15/08/2026 foi 12.205 s.
 */
const ESPERA_MAXIMA_S = 5

// Cache do token de aplicação (válido por toda a instância do processo).
let cachedAccessToken: string | null = null
let cachedTokenExpiry: number | null = null

/** Há credencial configurada? Sem ela nada aqui roda, e isso não é erro. */
export function spotifyConfigurado(): boolean {
  return !!process.env.SPOTIFY_CLIENT_ID && !!process.env.SPOTIFY_CLIENT_SECRET
}

async function getAccessToken(): Promise<string | null> {
  const clientId = process.env.SPOTIFY_CLIENT_ID
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET

  // Antes isto era console.error. Virou silêncio de propósito: as envs do
  // Spotify passaram a ser OPCIONAIS, e um log de erro a cada visita de página
  // treinaria qualquer um a ignorar os logs do serviço.
  if (!clientId || !clientSecret) return null

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

/**
 * Acha a gravação exata pelo ISRC — a ponte entre a identidade da faixa (o
 * ISRC, que endereça as páginas desde a migration 023) e o id do Spotify, que
 * faz o botão "ouvir no Spotify" cair na faixa certa.
 *
 * Chamada uma vez por gravação, na primeira visita à página dela
 * (POST /tracks/resolve-spotify). Até 15/08/2026 isto rodava 2.027 vezes por
 * noite dentro do job, para o catálogo inteiro, tivesse alguém olhado aquelas
 * faixas ou não.
 *
 * NÃO usa uma busca genérica de propósito. Uma busca devolve `[]` tanto para
 * "o Spotify não tem esta gravação" quanto para "a requisição falhou", e para
 * quem grava marca de "já tentei" essa diferença é tudo: confundir as duas
 * queima a faixa permanentemente por causa de um 429 passageiro. Foi
 * exatamente o que aconteceu no primeiro backfill — 1.904 faixas marcadas como
 * inexistentes quando o Spotify só estava limitando a taxa.
 *
 * `falhou: true` significa "não sei, pergunte de novo depois".
 */
export async function findSpotifyIdByIsrc(
  isrc: string,
  tentativas = 3
): Promise<{ id: string | null; falhou: boolean }> {
  const codigo = isrc.trim()
  if (!codigo) return { id: null, falhou: false }

  const token = await getAccessToken()
  if (!token) return { id: null, falhou: true }

  // `market=BR` continua: não adianta linkar o que o visitante daqui não
  // consegue tocar. A diferença é que agora isso decide só o link do botão, e
  // não se a faixa tem página.
  const url =
    'https://api.spotify.com/v1/search?type=track&limit=1&market=BR&q=' +
    encodeURIComponent(`isrc:${codigo}`)

  for (let n = 0; n < tentativas; n++) {
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      })

      if (res.status === 429) {
        // O Spotify diz em quantos segundos voltar, e respeitar é mais rápido
        // que insistir — insistir renova a punição.
        //
        // Mas há um teto, e ele é novo: esta função saiu do job noturno e
        // passou a ser chamada dentro de uma requisição HTTP. Em 15/08/2026 o
        // Retry-After observado foi de 12.205 s; esperar isso aqui penduraria o
        // pedido do navegador por 3h24. Acima do teto a resposta é "não sei,
        // pergunte depois", que é exatamente o que o botão já sabe tratar —
        // ele continua no deep link de busca e tenta de novo na próxima visita.
        const espera = Number(res.headers.get('Retry-After')) || 2
        if (espera > ESPERA_MAXIMA_S) return { id: null, falhou: true }
        await new Promise((r) => setTimeout(r, (espera + 1) * 1000))
        continue
      }

      if (res.status === 401) {
        cachedAccessToken = null
        cachedTokenExpiry = null
        return { id: null, falhou: true }
      }

      if (!res.ok) return { id: null, falhou: true }

      const json = (await res.json()) as SpotifySearchResponse
      // Resposta boa e vazia: o Spotify realmente não tem esta gravação no
      // mercado BR. É resultado, não falha.
      return { id: json?.tracks?.items?.[0]?.id ?? null, falhou: false }
    } catch {
      return { id: null, falhou: true }
    }
  }

  return { id: null, falhou: true }
}
