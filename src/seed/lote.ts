// src/seed/lote.ts
// As partes puras do `seed:perfis` (`src/scripts/semearPerfis.ts`), separadas
// para caber num teste: em que dia a conta "entrou", quem segue quem.

import type { Rng } from './username'

/** O Mirsui abriu em jun/2024: nenhuma conta semeada entra antes disso. */
export const ABERTURA = new Date('2024-06-01T00:00:00Z')
/** Janela de entrada: os últimos 180 dias (ou desde a abertura, o que for mais curto). */
export const JANELA_DE_ENTRADA_DIAS = 180

const DIA_MS = 24 * 60 * 60 * 1000

/**
 * A data de cadastro de uma conta semeada: uniforme entre
 * `max(abertura, agora - 180 d)` e ontem. Nunca hoje — a conta que "entrou
 * hoje" e já tem foto, bio e três fichas é a que chama atenção no `/admin`.
 */
export function sortearDataDeEntrada(agora: Date = new Date(), rng: Rng = Math.random): Date {
  const ontem = agora.getTime() - DIA_MS
  const inicio = Math.max(ABERTURA.getTime(), agora.getTime() - JANELA_DE_ENTRADA_DIAS * DIA_MS)
  if (!(ontem > inicio)) return new Date(ontem)
  return new Date(inicio + Math.floor(rng() * (ontem - inicio)))
}

/**
 * Quem este perfil vai seguir: 0–4 outros semeados (de qualquer lote), nunca
 * ele mesmo, sem repetição. Com menos candidatos que o sorteado, segue os que
 * há.
 */
export function sortearSeguidos(eu: string, semeados: readonly string[], rng: Rng = Math.random): string[] {
  const candidatos = semeados.filter(id => id !== eu)
  const quantos = Math.min(Math.floor(rng() * 5), candidatos.length)
  const escolhidos: string[] = []
  const restantes = [...candidatos]
  while (escolhidos.length < quantos) {
    const i = Math.floor(rng() * restantes.length)
    escolhidos.push(restantes.splice(i, 1)[0])
  }
  return escolhidos
}

/** Embaralha (Fisher–Yates) sem mexer no original. */
export function embaralhar<T>(lista: readonly T[], rng: Rng = Math.random): T[] {
  const copia = [...lista]
  for (let i = copia.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[copia[i], copia[j]] = [copia[j], copia[i]]
  }
  return copia
}
