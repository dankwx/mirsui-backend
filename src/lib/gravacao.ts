// src/lib/gravacao.ts
// A conta de uma ficha: o que identifica uma GRAVAÇÃO no acervo e como a
// posição vira nota. Nasceu em `src/routes/claims.ts` e saiu de lá quando a
// semeadura de perfis (`src/seed/ficha.ts`) precisou fazer a mesma conta com
// a service role — uma fórmula, dois chamadores.

export const ISRC_RE = /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/

/** O ISRC como a rota aceita: maiúsculo, sem espaço, ou null se não bate no formato. */
export function isrcValido(bruto: unknown): string | null {
  const s = String(bruto ?? '').trim().toUpperCase()
  return ISRC_RE.test(s) ? s : null
}

/**
 * O filtro que identifica uma GRAVAÇÃO, e não uma string.
 *
 * `track_uri` é uma chave opaca e continua sendo: as linhas antigas guardam
 * `spotify:track:<id>` e migrá-las seria risco alto no único dado
 * insubstituível do produto (ver docs/plano-independencia-do-spotify.md §7).
 * O que existe agora é `tracks.isrc` ao lado — preenchida no save e
 * retroativamente pela ponte do Observatório (migration 023).
 *
 * Com as duas, a mesma faixa salva por caminhos diferentes (uri do Spotify
 * antes, `isrc:<ISRC>` depois) conta no mesmo lugar, em vez de virar dois
 * contadores paralelos e duas "primeiras pessoas a salvar".
 *
 * Nem o ISRC ([A-Z0-9]{12}) nem as duas formas de uri têm vírgula, então nada
 * aqui precisa de escape para a sintaxe do `.or()` do PostgREST.
 */
export function filtroDaGravacao(trackUri: string, isrc: string | null): string {
  return isrc ? `isrc.eq.${isrc},track_uri.eq.${trackUri}` : `track_uri.eq.${trackUri}`
}

/** Quanto vale ter salvo esta faixa nesta posição: quanto mais obscura e mais cedo, mais. */
export function discoverRating(popularity: number, position: number): number {
  return 100 - popularity + 100 / position
}
