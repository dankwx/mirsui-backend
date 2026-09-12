// src/scripts/coletarUsernames.ts
// Colhe handles de ouvintes no Last.fm para o pool de usernames semeados:
//
//   npm run seed:usernames -- --paginas 5
//
// Percorre os ~40 artistas de `src/seed/lastfm.ts`, N páginas cada, com 5–9 s
// entre requisições (o Last.fm devolve 406 a partir de ~10 req/min; nesse caso
// o script espera 3 min e tenta a mesma página de novo, até 3 vezes), e grava o resultado dedupado em `seed/usernames.json` (gitignored). Rodar de
// novo SOMA ao arquivo existente — nunca perde handle já colhido. Quem decide
// se um handle já virou perfil é `seeded_profiles.source_username`, não este
// arquivo: ele é só a matéria-prima.
//
// 40 artistas × 5 páginas × 30 ≈ 6 mil handles brutos; com sobreposição entre
// artistas e handles que não passam no regex do Mirsui, sobra menos.

import { ARTISTAS, coletarOuvintes, pausa, intervaloEntreRequisicoes, PAUSA_APOS_406_MS, RateLimited } from '../seed/lastfm'
import { normalizar } from '../seed/username'
import { ARQUIVO_USERNAMES, lerPool, salvarPool } from '../seed/poolDeUsernames'

function argumento(nome: string, padrao: number): number {
  const i = process.argv.indexOf(`--${nome}`)
  if (i === -1) return padrao
  const v = Number(process.argv[i + 1])
  if (!Number.isFinite(v) || v < 1) throw new Error(`--${nome} precisa de um inteiro >= 1`)
  return Math.floor(v)
}

const paginas = argumento('paginas', 5)
const pool = await lerPool()
const conhecidos = new Set(pool.handles)
const antes = conhecidos.size

let requisicoes = 0
let descartados = 0
let falhas = 0
let esperasPor406 = 0

/** A página, com retentativa em 406. Lança se esgotar as tentativas. */
async function coletarComEspera(artista: string, p: number): Promise<string[]> {
  for (let tentativa = 1; ; tentativa++) {
    try {
      requisicoes++
      return await coletarOuvintes(artista, p)
    } catch (err) {
      if (!(err instanceof RateLimited) || tentativa >= 3) throw err
      esperasPor406++
      console.error(`  ~ 406 em ${artista} p.${p}; esperando ${PAUSA_APOS_406_MS / 60000} min (tentativa ${tentativa}/3)`)
      await pausa(PAUSA_APOS_406_MS)
    }
  }
}

async function salvar(): Promise<void> {
  pool.handles = [...conhecidos]
  pool.atualizado_em = new Date().toISOString()
  await salvarPool(pool)
}

console.log(`Last.fm — ${ARTISTAS.length} artistas × ${paginas} páginas (pool atual: ${antes})`)

for (const artista of ARTISTAS) {
  let novosDoArtista = 0
  for (let p = 1; p <= paginas; p++) {
    try {
      const handles = await coletarComEspera(artista, p)
      if (handles.length === 0) break // acabou a lista (ou o artista não existe)
      for (const h of handles) {
        if (!normalizar(h)) { descartados++; continue }
        if (!conhecidos.has(h)) { conhecidos.add(h); novosDoArtista++ }
      }
    } catch (err) {
      falhas++
      console.error(`  ! ${artista} p.${p}: ${err instanceof Error ? err.message : err}`)
    }
    await pausa(intervaloEntreRequisicoes())
  }
  console.log(`  ${artista.padEnd(22)} +${novosDoArtista}`)
  await salvar() // por artista: uma queda no meio não perde o que já veio
}

console.log('\nColeta — resumo')
console.log('  requisições         :', requisicoes)
console.log('  falhas              :', falhas)
console.log('  esperas por 406     :', esperasPor406)
console.log('  descartados (regex) :', descartados)
console.log('  handles novos       :', conhecidos.size - antes)
console.log('  pool total          :', conhecidos.size)
console.log('  arquivo             :', ARQUIVO_USERNAMES)

process.exit(falhas > 0 ? 1 : 0)
