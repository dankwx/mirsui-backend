// src/seed/lastfm.ts
// De onde vêm os usernames dos perfis semeados.
//
// A página pública de ouvintes de um artista no Last.fm
// (`/music/<artista>/+listeners?page=N`) lista 30 handles por página, sem
// chave e sem login — testado em 12/09/2026. Handles de Last.fm são apelidos
// que as pessoas escolheram para um site de música, então soam como o tipo de
// nome que alguém escolheria aqui; não são nomes reais (o Deezer, por exemplo,
// só dá nome completo do dono da playlist, e foi descartado por isso).
//
// Os handles NÃO entram no site como estão: `src/seed/username.ts` aplica uma
// mutação leve em cada um. O original fica em `seeded_profiles.source_username`.
//
// Ritmo: o plano dizia 1 req/s; na primeira rodada real (12/09/2026) o Varnish
// do Last.fm cortou na 10ª requisição com `406 Rate Limited`
// (`x-debug-error: Triggered-406-Snp`) e ficou fechado por alguns minutos.
// Então: 5–9 s entre requisições (com jitter), e o 406 vira uma pausa longa
// com retentativa em vez de falha. A lista de artistas mistura BR e gringo,
// indie e pop, para o pool não sair com cara de uma cena só.

export const ARTISTAS = [
  // BR
  'Marina Sena', 'Tim Bernardes', 'Jovem Dionisio', 'Ana Frango Elétrico',
  'Liniker', 'Terno Rei', 'BK\'', 'Djonga', 'Luísa Sonza', 'Anitta',
  'Marília Mendonça', 'Gilberto Gil', 'Los Hermanos', 'Boogarins', 'Duda Beat',
  'Baco Exu do Blues', 'Emicida', 'Pabllo Vittar', 'Chico Buarque', 'Mallu Magalhães',
  // gringo
  'Phoebe Bridgers', 'Mitski', 'Radiohead', 'Arctic Monkeys', 'Tame Impala',
  'The Strokes', 'Beach House', 'Frank Ocean', 'Tyler, the Creator', 'SZA',
  'Billie Eilish', 'Lana Del Rey', 'The Weeknd', 'Charli XCX', 'Rosalía',
  'Bad Bunny', 'Mac DeMarco', 'Sufjan Stevens', 'Fleetwood Mac', 'Daft Punk'
]

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36'

/** Intervalo entre requisições, em ms: 5–9 s. */
export function intervaloEntreRequisicoes(): number {
  return 5000 + Math.floor(Math.random() * 4000)
}

/** Quanto esperar depois de um 406 antes de tentar de novo. */
export const PAUSA_APOS_406_MS = 3 * 60 * 1000

export class RateLimited extends Error {
  constructor(artista: string, pagina: number) {
    super(`Last.fm respondeu 406 (rate limited) para ${artista} p.${pagina}`)
    this.name = 'RateLimited'
  }
}

function urlDeOuvintes(artista: string, pagina: number): string {
  // O Last.fm usa `+` para espaço no caminho; o resto vai percent-encoded.
  const slug = encodeURIComponent(artista).replace(/%20/g, '+')
  return `https://www.last.fm/music/${slug}/+listeners?page=${pagina}`
}

/**
 * Handles de uma página de ouvintes. `/user/<handle>` aparece duas vezes por
 * ouvinte (o avatar e a faixa que ele mais ouviu, `/user/<handle>/library/...`);
 * o regex exige aspas logo depois do handle para ficar só com o primeiro.
 * Devolve [] em 404 (artista sem página), lança `RateLimited` em 406 e
 * `Error` em erro de rede/5xx.
 */
export async function coletarOuvintes(artista: string, pagina: number): Promise<string[]> {
  const r = await fetch(urlDeOuvintes(artista, pagina), {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9,pt-BR;q=0.8' }
  })
  if (r.status === 404) return []
  if (r.status === 406) throw new RateLimited(artista, pagina)
  if (!r.ok) throw new Error(`Last.fm respondeu ${r.status} para ${artista} p.${pagina}`)

  const html = await r.text()
  const vistos = new Set<string>()
  for (const m of html.matchAll(/href="\/user\/([^/"?#]+)"/g)) {
    vistos.add(decodeURIComponent(m[1]))
  }
  return [...vistos]
}

export function pausa(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
