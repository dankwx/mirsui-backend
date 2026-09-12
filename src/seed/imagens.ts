// src/seed/imagens.ts
// As fotos dos perfis semeados: o pool em disco, o upload e a troca.
//
// O acervo são ~400 JPEGs em `$SEED_IMAGENS_DIR` (padrão `/home/ubuntu/imagens`;
// o backend roda como `ubuntu`, dono da pasta — lê, move e apaga sem sudo).
// A regra "nenhuma foto se repete" não é uma checagem, é a estrutura: ao usar
// uma foto o arquivo é MOVIDO de `imagens/` para `imagens/usadas/`, e
// `seeded_profiles.image_file` diz qual é de quem. O pool é o que sobrou na
// raiz; `usadas/` é o que está no ar.
//
// O upload é o mesmo da rota real (`POST /profiles/:id/avatar` em
// `src/routes/profiles.ts`): bucket `user-profile-images`, objeto
// `<uuid>/profile-picture`, `upsert: true`, e `avatar_url` recebe a URL pública
// com `?v=<ts>` para furar o cache — a URL do objeto é fixa, a troca só aparece
// se o `v` mudar.
//
// Trocar a foto de um perfil (o painel `/admin/perfis`) é: sortear outra do
// pool, subir por cima do mesmo objeto, atualizar `avatar_url` e `image_file`,
// e apagar o arquivo antigo de `usadas/`. Apagar de vez, e não devolver ao
// pool: a foto antiga já esteve no ar com esse perfil, e o dono pediu a troca
// porque ela não serviu.

import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { SupabaseClient } from '@supabase/supabase-js'
import { urlPublicaDoStorage } from '../lib/supabase'

export const AVATAR_BUCKET = 'user-profile-images'

export const SEED_IMAGENS_DIR = process.env.SEED_IMAGENS_DIR || '/home/ubuntu/imagens'

export class PoolVazio extends Error {
  constructor(dir: string) {
    super(`acabaram as fotos em ${dir}`)
    this.name = 'PoolVazio'
  }
}

const JPEG_RE = /\.jpe?g$/i

function pastaUsadas(dir: string): string {
  return path.join(dir, 'usadas')
}

/** Nomes dos JPEGs ainda disponíveis na raiz do pool (não desce em `usadas/`). */
export async function listarPool(dir = SEED_IMAGENS_DIR): Promise<string[]> {
  const entradas = await fs.readdir(dir, { withFileTypes: true })
  return entradas.filter(e => e.isFile() && JPEG_RE.test(e.name)).map(e => e.name).sort()
}

export async function contarPool(dir = SEED_IMAGENS_DIR): Promise<number> {
  return (await listarPool(dir)).length
}

/**
 * Sorteia um JPEG do pool e o move para `usadas/`. Devolve o nome do arquivo.
 * Dois processos sorteando ao mesmo tempo podem escolher o mesmo nome; o
 * `rename` do segundo falha com ENOENT e ele sorteia de novo — o arquivo é o
 * lock.
 */
export async function sortearDoPool(dir = SEED_IMAGENS_DIR, rng: () => number = Math.random): Promise<string> {
  await fs.mkdir(pastaUsadas(dir), { recursive: true })
  for (let tentativa = 0; tentativa < 5; tentativa++) {
    const pool = await listarPool(dir)
    if (pool.length === 0) throw new PoolVazio(dir)
    const arquivo = pool[Math.floor(rng() * pool.length)]
    try {
      await fs.rename(path.join(dir, arquivo), path.join(pastaUsadas(dir), arquivo))
      return arquivo
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw err
    }
  }
  throw new PoolVazio(dir)
}

/** Desfaz o `sortearDoPool`: o arquivo volta de `usadas/` para a raiz. */
export async function devolverAoPool(arquivo: string, dir = SEED_IMAGENS_DIR): Promise<void> {
  await fs.rename(path.join(pastaUsadas(dir), arquivo), path.join(dir, arquivo))
}

/** Apaga de vez um arquivo de `usadas/`. Não existir não é erro. */
export async function apagarUsada(arquivo: string, dir = SEED_IMAGENS_DIR): Promise<void> {
  try {
    await fs.unlink(path.join(pastaUsadas(dir), arquivo))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
}

/**
 * Sobe um JPEG de `usadas/` como avatar do perfil e grava a URL versionada em
 * `profiles.avatar_url`. Mesmo objeto, mesmo cache-bust da rota real.
 */
export async function enviarAvatar(
  admin: SupabaseClient,
  profileId: string,
  arquivo: string,
  dir = SEED_IMAGENS_DIR
): Promise<string> {
  const buffer = await fs.readFile(path.join(pastaUsadas(dir), arquivo))
  const objeto = `${profileId}/profile-picture`

  const { error: uploadError } = await admin.storage
    .from(AVATAR_BUCKET)
    .upload(objeto, buffer, { contentType: 'image/jpeg', cacheControl: '300', upsert: true })
  if (uploadError) throw new Error(`upload do avatar de ${profileId}: ${uploadError.message}`)

  const { data: { publicUrl } } = admin.storage.from(AVATAR_BUCKET).getPublicUrl(objeto)
  const avatarUrl = `${urlPublicaDoStorage(publicUrl)}?v=${Date.now()}`

  const { error: updateError } = await admin
    .from('profiles')
    .update({ avatar_url: avatarUrl })
    .eq('id', profileId)
  if (updateError) throw new Error(`avatar_url de ${profileId}: ${updateError.message}`)

  return avatarUrl
}

export interface FotoAtribuida {
  avatar_url: string
  image_file: string
}

/**
 * Primeira foto de um perfil recém-criado (script de semeadura): sorteia do
 * pool e sobe. Se o upload falhar, a foto volta ao pool antes de relançar — o
 * chamador apaga o usuário e segue para o próximo sem perder uma imagem.
 * NÃO grava em `seeded_profiles`: a linha só existe no fim do perfil inteiro.
 */
export async function atribuirFoto(admin: SupabaseClient, profileId: string, dir = SEED_IMAGENS_DIR): Promise<FotoAtribuida> {
  const arquivo = await sortearDoPool(dir)
  try {
    const avatarUrl = await enviarAvatar(admin, profileId, arquivo, dir)
    return { avatar_url: avatarUrl, image_file: arquivo }
  } catch (err) {
    await devolverAoPool(arquivo, dir).catch(() => {})
    throw err
  }
}

/**
 * Troca a foto de um perfil semeado que já está no ar (painel `/admin/perfis`).
 * Lê o arquivo atual em `seeded_profiles`, sorteia outro, sobe por cima do
 * mesmo objeto, atualiza `avatar_url` e `image_file`, e só então apaga o
 * antigo de `usadas/`. Ordem importa: se o upload ou o update falhar, o novo
 * volta ao pool e o antigo continua onde estava — o perfil não fica sem foto.
 *
 * Lança `PoolVazio` (a rota responde 409) e `Error('perfil não é semeado')`
 * quando o id não está em `seeded_profiles` (a rota responde 404).
 */
export async function trocarFoto(admin: SupabaseClient, profileId: string, dir = SEED_IMAGENS_DIR): Promise<FotoAtribuida> {
  const { data: atual, error } = await admin
    .from('seeded_profiles')
    .select('image_file')
    .eq('profile_id', profileId)
    .maybeSingle()
  if (error) throw new Error(`seeded_profiles de ${profileId}: ${error.message}`)
  if (!atual) throw new Error('perfil não é semeado')

  const novo = await sortearDoPool(dir)
  let avatarUrl: string
  try {
    avatarUrl = await enviarAvatar(admin, profileId, novo, dir)
    const { error: updateError } = await admin
      .from('seeded_profiles')
      .update({ image_file: novo })
      .eq('profile_id', profileId)
    if (updateError) throw new Error(`image_file de ${profileId}: ${updateError.message}`)
  } catch (err) {
    await devolverAoPool(novo, dir).catch(() => {})
    throw err
  }

  if (atual.image_file !== novo) await apagarUsada(atual.image_file, dir)
  return { avatar_url: avatarUrl, image_file: novo }
}
