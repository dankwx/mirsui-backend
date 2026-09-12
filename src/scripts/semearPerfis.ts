// src/scripts/semearPerfis.ts
// Cria perfis semeados no Mirsui:
//
//   npm run seed:perfis -- --n 20 [--lote 2026-09-12]
//
// Por perfil, em sequência, com 1–2 s de pausa:
//   1. um handle do pool (`seed/usernames.json`) que ainda não virou perfil
//      (`seeded_profiles.source_username`, de qualquer lote) → username
//      alterado (`src/seed/username.ts`), livre em `profiles.username`;
//   2. `auth.admin.createUser` com e-mail `<username>@seed.mirsui.invalid`,
//      senha aleatória, `app_metadata.seeded = true` (a marca da limpeza) e
//      `user_metadata.username/display_name` — o trigger `handle_new_user`
//      cria a linha em `profiles`;
//   3. a data de entrada é sorteada no passado (`src/seed/lote.ts`) e aplicada
//      em `auth.users` pela RPC `seed_backdate_user` (migration 033);
//   4. foto: um JPEG do pool vai para `usadas/` e sobe como avatar (`src/seed/imagens.ts`);
//   5. IA: brief sorteado → 1–3 faixas reais + bio às vezes (`src/seed/openrouter.ts`);
//      as faixas viram fichas com data entre a entrada e agora (`src/seed/ficha.ts`);
//   6. a linha de controle em `seeded_profiles`.
// Qualquer falha depois do passo 2 apaga o `auth.users` recém-criado (a
// cascata leva profile, fichas, tudo), devolve a foto ao pool e segue para o
// próximo handle. Falha ANTES do passo 2 (handle inválido, colisão) só pula.
//
// No fim do lote, cada perfil criado passa a seguir 0–4 outros semeados (de
// qualquer lote), com `followers.created_at` depois de as duas contas
// existirem.
//
// Idempotente por handle: `source_username` gravado nunca é reaproveitado, e
// o handle de um perfil que falhou no meio também não fica marcado — o
// próximo `seed:perfis` pode tentar de novo.

import dotenv from 'dotenv'
import { supabaseAdmin } from '../lib/supabase'
import { lerPool } from '../seed/poolDeUsernames'
import { gerarUsername, gerarDisplayName } from '../seed/username'
import { atribuirFoto, devolverAoPool, contarPool, PoolVazio, SEED_IMAGENS_DIR } from '../seed/imagens'
import { gerarGostoMusical, resolverFaixas, formatarEscolhida, OPENROUTER_MODEL } from '../seed/openrouter'
import { criarFichas, sortearClaimedAt } from '../seed/ficha'
import { sortearDataDeEntrada, sortearSeguidos, embaralhar } from '../seed/lote'
import { pausa } from '../seed/lastfm'

dotenv.config()

const SEED_EMAIL_DOMINIO = 'seed.mirsui.invalid'

function argumento(nome: string, padrao: number): number {
  const i = process.argv.indexOf(`--${nome}`)
  if (i === -1) return padrao
  const v = Number(process.argv[i + 1])
  if (!Number.isFinite(v) || v < 1) throw new Error(`--${nome} precisa de um inteiro >= 1`)
  return Math.floor(v)
}

function argumentoTexto(nome: string, padrao: string): string {
  const i = process.argv.indexOf(`--${nome}`)
  return i === -1 || !process.argv[i + 1] ? padrao : process.argv[i + 1]
}

const n = argumento('n', 5)
const lote = argumentoTexto('lote', new Date().toISOString().slice(0, 10))

const admin = supabaseAdmin
if (!admin) throw new Error('SUPABASE_SERVICE_ROLE_KEY não está no .env')
if (!process.env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY não está no .env')

// ---------------------------------------------------------------------------
// O que já existe

const pool = await lerPool()
if (pool.handles.length === 0) throw new Error('seed/usernames.json vazio — rode `npm run seed:usernames` antes')

const { data: jaSemeados, error: erroSemeados } = await admin
  .from('seeded_profiles')
  .select('profile_id, source_username')
if (erroSemeados) throw new Error(`seeded_profiles: ${erroSemeados.message}`)
const handlesUsados = new Set((jaSemeados ?? []).map(s => s.source_username))
const idsSemeados = (jaSemeados ?? []).map(s => s.profile_id as string)

async function usernameExiste(username: string): Promise<boolean> {
  const { data, error } = await admin!.from('profiles').select('id').eq('username', username).limit(1).maybeSingle()
  if (error) throw new Error(`profiles.username: ${error.message}`)
  return !!data
}

// ---------------------------------------------------------------------------
// Um perfil

interface PerfilCriado {
  id: string
  username: string
  criadoEm: Date
  fichas: number
  bio: boolean
  image_file: string
}

/** A memória de "não repita" do lote: só as faixas que de fato viraram ficha. */
const memoria: string[] = []

async function criarPerfil(handle: string): Promise<PerfilCriado | null> {
  const username = await gerarUsername(handle, usernameExiste)
  if (!username) {
    console.log(`  - ${handle}: sem username possível, pulando`)
    return null
  }
  const displayName = gerarDisplayName(handle, username)
  const email = `${username.toLowerCase()}@${SEED_EMAIL_DOMINIO}`

  const { data: criado, error: erroCriacao } = await admin!.auth.admin.createUser({
    email,
    password: crypto.randomUUID() + crypto.randomUUID(),
    email_confirm: true,
    user_metadata: { username, display_name: displayName },
    app_metadata: { seeded: true, seed_batch: lote }
  })
  if (erroCriacao || !criado.user) {
    console.log(`  - ${handle} → @${username}: createUser falhou (${erroCriacao?.message ?? 'sem usuário'})`)
    return null
  }
  const id = criado.user.id

  let imageFile: string | null = null
  try {
    // 3. a data de entrada
    const criadoEm = sortearDataDeEntrada()
    const { data: datadas, error: erroData } = await admin!.rpc('seed_backdate_user', {
      p_user_id: id,
      p_created_at: criadoEm.toISOString()
    })
    if (erroData) throw new Error(`seed_backdate_user: ${erroData.message}`)
    if (datadas !== 1) throw new Error(`seed_backdate_user mudou ${datadas} linhas (esperava 1)`)

    // 4. a foto
    const foto = await atribuirFoto(admin!, id)
    imageFile = foto.image_file

    // 5. a IA → fichas + bio
    const ia = await gerarGostoMusical(memoria)
    const faixas = await resolverFaixas(ia.tracks)
    const fichas = await criarFichas(admin!, id, faixas, criadoEm)
    for (const f of faixas) memoria.push(formatarEscolhida(f))

    if (ia.bio) {
      const { error: erroBio } = await admin!.from('profiles').update({ description: ia.bio }).eq('id', id)
      if (erroBio) throw new Error(`description: ${erroBio.message}`)
    }

    // 6. a linha de controle
    const { error: erroControle } = await admin!.from('seeded_profiles').insert({
      profile_id: id,
      image_file: imageFile,
      source: 'lastfm',
      source_username: handle,
      batch: lote
    })
    if (erroControle) throw new Error(`seeded_profiles: ${erroControle.message}`)

    return { id, username, criadoEm, fichas: fichas.length, bio: !!ia.bio, image_file: imageFile }
  } catch (err) {
    // 7. desfaz: o usuário (cascata) e a foto
    const { error: erroApagar } = await admin!.auth.admin.deleteUser(id)
    if (erroApagar) console.error(`  ! não consegui apagar ${id} (@${username}): ${erroApagar.message} — apague à mão`)
    if (imageFile) await devolverAoPool(imageFile).catch(() => {})
    console.log(`  - ${handle} → @${username}: ${err instanceof Error ? err.message : err}`)
    if (err instanceof PoolVazio) throw err
    return null
  }
}

// ---------------------------------------------------------------------------
// O lote

console.log(`Semeadura — lote ${lote} · ${n} perfis · modelo ${OPENROUTER_MODEL}`)
console.log(`  pool de handles: ${pool.handles.length} (${handlesUsados.size} já usados) · fotos: ${await contarPool()} em ${SEED_IMAGENS_DIR}`)

const criados: PerfilCriado[] = []
let tentativas = 0

for (const handle of embaralhar(pool.handles)) {
  if (criados.length >= n) break
  if (handlesUsados.has(handle)) continue
  tentativas++
  let perfil: PerfilCriado | null
  try {
    perfil = await criarPerfil(handle)
  } catch (err) {
    if (err instanceof PoolVazio) {
      console.error(`  ! ${err.message} — parando o lote`)
      break
    }
    throw err
  }
  if (perfil) {
    criados.push(perfil)
    handlesUsados.add(handle)
    console.log(
      `  @${perfil.username.padEnd(30)} foto=${perfil.image_file}  fichas=${perfil.fichas}  bio=${perfil.bio ? 'sim' : 'não'}  entrou=${perfil.criadoEm.toISOString().slice(0, 10)}`
    )
  }
  await pausa(1000 + Math.random() * 1000)
}

// ---------------------------------------------------------------------------
// Quem segue quem

const todosSemeados = [...idsSemeados, ...criados.map(c => c.id)]
let seguidas = 0

async function dataDeEntrada(id: string): Promise<Date | null> {
  const { data, error } = await admin!.auth.admin.getUserById(id)
  if (error || !data.user?.created_at) return null
  return new Date(data.user.created_at)
}

for (const perfil of criados) {
  for (const alvo of sortearSeguidos(perfil.id, todosSemeados)) {
    const entradaDoAlvo = await dataDeEntrada(alvo)
    if (!entradaDoAlvo) continue
    const depoisDe = new Date(Math.max(perfil.criadoEm.getTime(), entradaDoAlvo.getTime()))
    const { error } = await admin.from('followers').insert({
      follower_id: perfil.id,
      following_id: alvo,
      created_at: sortearClaimedAt(depoisDe).toISOString()
    })
    if (error && error.code !== '23505') console.error(`  ! follow ${perfil.username} → ${alvo}: ${error.message}`)
    if (!error) seguidas++
  }
}

// ---------------------------------------------------------------------------

console.log('\nSemeadura — resumo')
console.log('  perfis criados   :', criados.length, `de ${n} pedidos`)
console.log('  handles tentados :', tentativas)
console.log('  fichas           :', criados.reduce((s, c) => s + c.fichas, 0))
console.log('  com bio          :', criados.filter(c => c.bio).length)
console.log('  follows          :', seguidas)
console.log('  fotos restantes  :', await contarPool())

process.exit(criados.length < n ? 1 : 0)
