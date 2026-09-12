// src/seed/poolDeUsernames.ts
// O arquivo `seed/usernames.json` (gitignored): a matéria-prima dos usernames
// semeados, colhida por `seed:usernames` e consumida por `seed:perfis`.
// Quem decide se um handle já virou perfil é `seeded_profiles.source_username`,
// não este arquivo — ele só acumula.

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

export const ARQUIVO_USERNAMES = path.resolve('seed/usernames.json')

export interface PoolDeUsernames {
  atualizado_em: string
  fonte: 'lastfm'
  handles: string[]
}

/** Arquivo ausente ou ilegível = pool vazio. */
export async function lerPool(): Promise<PoolDeUsernames> {
  try {
    const bruto = JSON.parse(await readFile(ARQUIVO_USERNAMES, 'utf8')) as Partial<PoolDeUsernames>
    return { atualizado_em: bruto.atualizado_em ?? '', fonte: 'lastfm', handles: bruto.handles ?? [] }
  } catch {
    return { atualizado_em: '', fonte: 'lastfm', handles: [] }
  }
}

export async function salvarPool(pool: PoolDeUsernames): Promise<void> {
  await mkdir(path.dirname(ARQUIVO_USERNAMES), { recursive: true })
  await writeFile(ARQUIVO_USERNAMES, JSON.stringify(pool, null, 2) + '\n')
}
