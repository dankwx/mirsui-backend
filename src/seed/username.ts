// src/seed/username.ts
// Transforma um handle colhido (Last.fm) no username de um perfil semeado.
//
// Duas etapas:
//   1. normalizar — o Mirsui aceita `^[a-zA-Z0-9_]{3,30}$` e o Last.fm aceita
//      `-` e handles mais longos. `-` vira `_`, o resto é cortado a 30. Handle
//      que ainda assim não passa é descartado (devolve null).
//   2. mutar — UMA alteração leve, sorteada, para que o username não seja
//      igual ao de uma pessoa real em outro site: trocar uma letra pela
//      vizinha de teclado, duplicar uma letra, mexer nos dígitos do fim ou
//      inserir um `_`. O original fica guardado em `seeded_profiles.source_username`.
//
// O sorteio recebe um `rng` para o teste ser determinístico; em produção é
// `Math.random`.

export const USERNAME_RE = /^[a-zA-Z0-9_]{3,30}$/

const VIZINHAS: Record<string, string> = {
  q: 'wa', w: 'qes', e: 'wrd', r: 'etf', t: 'ryg', y: 'tuh', u: 'yij', i: 'uok', o: 'ipl', p: 'ol',
  a: 'qsz', s: 'awdx', d: 'sefc', f: 'drgv', g: 'fthb', h: 'gyjn', j: 'hukm', k: 'jil', l: 'kop',
  z: 'asx', x: 'zsdc', c: 'xdfv', v: 'cfgb', b: 'vghn', n: 'bhjm', m: 'njk'
}

export type Rng = () => number

function sortear<T>(lista: readonly T[], rng: Rng): T {
  return lista[Math.floor(rng() * lista.length)]
}

export function normalizar(handle: string): string | null {
  const limpo = handle.trim().replace(/-/g, '_').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 30)
  return USERNAME_RE.test(limpo) ? limpo : null
}

type Mutacao = (u: string, rng: Rng) => string | null

const trocarLetra: Mutacao = (u, rng) => {
  const posicoes = [...u].map((c, i) => (VIZINHAS[c.toLowerCase()] ? i : -1)).filter(i => i >= 0)
  if (posicoes.length === 0) return null
  const i = sortear(posicoes, rng)
  const c = u[i]
  const nova = sortear([...VIZINHAS[c.toLowerCase()]], rng)
  const casada = c === c.toUpperCase() ? nova.toUpperCase() : nova
  return u.slice(0, i) + casada + u.slice(i + 1)
}

const duplicarLetra: Mutacao = (u, rng) => {
  const posicoes = [...u].map((c, i) => (/[a-zA-Z]/.test(c) ? i : -1)).filter(i => i >= 0)
  if (posicoes.length === 0) return null
  const i = sortear(posicoes, rng)
  return u.slice(0, i + 1) + u[i] + u.slice(i + 1)
}

const mexerNosDigitos: Mutacao = (u, rng) => {
  const semDigitos = u.replace(/\d+$/, '')
  const qtd = 1 + Math.floor(rng() * 2)
  let digitos = ''
  for (let k = 0; k < qtd; k++) digitos += Math.floor(rng() * 10)
  // 1 ou 2 dígitos no fim: substitui os que já existiam ou acrescenta.
  return semDigitos + digitos
}

const inserirUnderscore: Mutacao = (u, rng) => {
  if (u.includes('_')) return null
  if (u.length < 4) return null
  const i = 1 + Math.floor(rng() * (u.length - 2))
  return u.slice(0, i) + '_' + u.slice(i)
}

const MUTACOES: Mutacao[] = [trocarLetra, trocarLetra, duplicarLetra, mexerNosDigitos, mexerNosDigitos, inserirUnderscore]

/**
 * Uma mutação sorteada sobre um handle já normalizado. Garante que o resultado
 * é diferente do original e passa no regex; tenta até 10 vezes antes de
 * desistir (null).
 */
export function mutar(username: string, rng: Rng = Math.random): string | null {
  for (let tentativa = 0; tentativa < 10; tentativa++) {
    const candidato = sortear(MUTACOES, rng)(username, rng)
    if (!candidato || candidato === username) continue
    const cortado = candidato.slice(0, 30)
    if (cortado !== username && USERNAME_RE.test(cortado)) return cortado
  }
  return null
}

/**
 * Handle da fonte → username livre no Mirsui. `existe` consulta o banco; se o
 * username sorteado colide, sorteia outro (até `tentativas`). Também trata
 * como colisão o próprio handle original — o username final nunca é igual ao
 * de origem, mesmo que ele esteja livre.
 */
export async function gerarUsername(
  original: string,
  existe: (username: string) => Promise<boolean>,
  opts: { rng?: Rng; tentativas?: number } = {}
): Promise<string | null> {
  const rng = opts.rng ?? Math.random
  const base = normalizar(original)
  if (!base) return null
  for (let t = 0; t < (opts.tentativas ?? 8); t++) {
    const candidato = mutar(base, rng)
    if (!candidato) return null
    if (candidato.toLowerCase() === base.toLowerCase()) continue
    if (!(await existe(candidato))) return candidato
  }
  return null
}

/**
 * Nome de exibição a partir do handle ORIGINAL: metade das vezes separa as
 * palavras (`GlassEyesLover` → `Glass Eyes Lover`, `glass_eyes` → `glass eyes`),
 * senão fica igual ao username gerado. Handles sem fronteira de palavra
 * (`cauannn`) caem sempre no segundo caso.
 */
export function gerarDisplayName(original: string, username: string, rng: Rng = Math.random): string {
  const separado = original
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([a-zA-Z])(\d)/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
  const temFronteira = separado.includes(' ')
  if (temFronteira && rng() < 0.5) return separado.slice(0, 40)
  return username
}
