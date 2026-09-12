// src/scripts/testarIA.ts
// Ensaio da IA dos perfis semeados, SEM tocar no banco:
//
//   npm run seed:ia -- --n 5
//
// Faz N chamadas ao OpenRouter como o `seed:perfis` faria (brief sorteado,
// memória de "não repita" acumulando entre as chamadas), resolve as faixas no
// Deezer e imprime brief, escolhas, o que casou e a bio — mais os tokens
// gastos, para estimar o custo do lote antes de criar perfil de verdade.

import dotenv from 'dotenv'
import { gerarGostoMusical, resolverFaixa, formatarEscolhida, OPENROUTER_MODEL } from '../seed/openrouter'

dotenv.config()

function argumento(nome: string, padrao: number): number {
  const i = process.argv.indexOf(`--${nome}`)
  if (i === -1) return padrao
  const v = Number(process.argv[i + 1])
  if (!Number.isFinite(v) || v < 1) throw new Error(`--${nome} precisa de um inteiro >= 1`)
  return Math.floor(v)
}

const n = argumento('n', 3)
const memoria: string[] = []
let promptTokens = 0
let completionTokens = 0
let pedidas = 0
let resolvidas = 0

console.log(`modelo: ${OPENROUTER_MODEL}\n`)

for (let i = 1; i <= n; i++) {
  try {
    const r = await gerarGostoMusical(memoria)
    promptTokens += r.uso.prompt_tokens
    completionTokens += r.uso.completion_tokens
    console.log(`#${i}  ${r.brief.tracos.join(', ')} · ${r.brief.generos.join(' + ')} · ${r.brief.decada} · ${r.brief.idioma} · pede ${r.brief.quantidade}`)
    for (const t of r.tracks) {
      pedidas++
      const achada = await resolverFaixa(t)
      if (achada) {
        resolvidas++
        memoria.push(formatarEscolhida(achada))
      }
      console.log(`    IA: ${formatarEscolhida(t)}${achada ? `  →  ${formatarEscolhida(achada)} [pop ${Math.round(achada.rank / 10000)}]` : '  →  (não casou no Deezer)'}`)
    }
    console.log(`    bio (${r.brief.bioEstilo ? `${r.brief.bioEstilo} · ${r.brief.bioAssunto}` : 'sem bio'}): ${r.bio ?? '—'}`)
    console.log(`    tokens: ${r.uso.prompt_tokens} in / ${r.uso.completion_tokens} out\n`)
  } catch (err) {
    console.log(`#${i}  FALHOU: ${(err as Error).message}\n`)
  }
}

console.log(`resumo: ${n} chamadas · ${resolvidas}/${pedidas} faixas resolvidas · ${promptTokens} tokens in · ${completionTokens} tokens out`)
