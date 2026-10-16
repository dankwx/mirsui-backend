// src/scripts/cadastrarPlaylists.ts
// Cadastra as playlists de medição (migration 042) que a rodada vai ler.
//
//   npx tsx src/scripts/cadastrarPlaylists.ts --usuario 6866594521
//   npx tsx src/scripts/cadastrarPlaylists.ts 15864469721 https://www.deezer.com/playlist/15864505581
//   ... --gravar            grava; sem ele, só mostra o que faria
//   ... --minimo 50         % mínimo de faixas do catálogo (pelo id) para cadastrar
//
// Com --usuario, considera as playlists que o perfil CRIOU (a lista do perfil
// também traz as que ele segue). Cada candidata é lida inteira pelo gateway,
// uma requisição por 2.000 faixas, e só entra se a maior parte das faixas for
// do catálogo pelo id do Deezer — é o que separa as playlists do Mirsui das
// playlists pessoais do dono, e o que pega uma importação que deu errado.

import { supabaseAdmin } from '../lib/supabase'
import { faixasDaPlaylist, playlistsDoUsuario } from '../lib/deezerCatalog'
import { deezerRequest } from '../lib/deezerTransport'

if (!supabaseAdmin) throw new Error('SUPABASE_SERVICE_ROLE_KEY não configurada')
const db = supabaseAdmin

const args = process.argv.slice(2)
const opcao = (nome: string) => {
  const i = args.indexOf(nome)
  if (i < 0) return null
  const v = args[i + 1]
  args.splice(i, 2)
  return v ?? null
}
const gravar = args.includes('--gravar')
if (gravar) args.splice(args.indexOf('--gravar'), 1)
const usuario = opcao('--usuario')
const minimo = Number(opcao('--minimo') ?? 50)

const titulos = new Map<string, string | null>()
const candidatas: string[] = []
for (const a of args) {
  const id = a.match(/^\d+$/)?.[0] ?? a.match(/\/playlist\/(\d+)/)?.[1]
  if (!id) throw new Error(`não entendi "${a}": passe o id ou o link www.deezer.com/playlist/<id>`)
  candidatas.push(id)
}
if (usuario) {
  const r = await playlistsDoUsuario(usuario)
  if (r.falhou) throw new Error(`não consegui listar as playlists do perfil ${usuario}`)
  for (const p of r.playlists) {
    if (p.creator_id !== usuario) continue
    titulos.set(p.deezer_playlist_id, p.title)
    candidatas.push(p.deezer_playlist_id)
  }
}
const unicas = [...new Set(candidatas)]
if (unicas.length === 0) throw new Error('nenhuma playlist candidata')

const { data: jaCadastradas, error: errCadastradas } = await db
  .from('measurement_playlists')
  .select('deezer_playlist_id, active')
if (errCadastradas) throw errCadastradas
const ativas = new Set((jaCadastradas ?? []).filter((p) => p.active).map((p) => p.deezer_playlist_id as string))

/** Quantos destes ids são faixas do catálogo. */
const doCatalogo = async (ids: string[]): Promise<number> => {
  let n = 0
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await db
      .from('observed_tracks')
      .select('deezer_track_id')
      .in('deezer_track_id', ids.slice(i, i + 200))
    if (error) throw error
    n += data?.length ?? 0
  }
  return n
}

const linhas: {
  id: string
  titulo: string | null
  faixas: number
  nossas: number
  pct: number
  situacao: string
}[] = []

for (const id of unicas) {
  if (!titulos.has(id)) {
    const meta = await deezerRequest(`/playlist/${id}`, 'catalog')
    titulos.set(id, meta.ok ? ((meta.data as { title?: string }).title ?? null) : null)
  }
  const titulo = titulos.get(id) ?? null
  if (ativas.has(id)) {
    linhas.push({ id, titulo, faixas: 0, nossas: 0, pct: 0, situacao: 'já cadastrada' })
    continue
  }
  const lida = await faixasDaPlaylist(id)
  if (lida.falhou) {
    linhas.push({ id, titulo, faixas: 0, nossas: 0, pct: 0, situacao: 'não deu para ler' })
    continue
  }
  const ids = [...new Set(lida.faixas.map((f) => f.deezer_track_id))]
  const nossas = await doCatalogo(ids)
  const pct = ids.length ? Math.round((1000 * nossas) / ids.length) / 10 : 0
  linhas.push({
    id,
    titulo,
    faixas: lida.faixas.length,
    nossas,
    pct,
    situacao: pct >= minimo ? (gravar ? 'cadastrada' : 'cadastraria') : `abaixo de ${minimo}%`,
  })
  console.log(`${id}  ${(titulo ?? '').padEnd(24)}  ${String(lida.faixas.length).padStart(5)} faixas  ${String(nossas).padStart(5)} do catálogo (${pct}%)`)
}

const aCadastrar = linhas.filter((l) => l.situacao === 'cadastrada')
if (gravar && aCadastrar.length > 0) {
  const { error } = await db.from('measurement_playlists').upsert(
    aCadastrar.map((l) => ({ deezer_playlist_id: l.id, label: l.titulo, active: true })),
    { onConflict: 'deezer_playlist_id' }
  )
  if (error) throw error
}

const por = (s: string) => linhas.filter((l) => l.situacao.startsWith(s)).length
console.log(JSON.stringify({
  candidatas: unicas.length,
  [gravar ? 'cadastradas' : 'cadastraria']: por(gravar ? 'cadastrada' : 'cadastraria'),
  jaCadastradas: por('já'),
  abaixoDoMinimo: por('abaixo'),
  naoLidas: por('não'),
  faixas: linhas.reduce((n, l) => n + l.faixas, 0),
  doCatalogo: linhas.reduce((n, l) => n + l.nossas, 0),
}))
for (const l of linhas.filter((l) => !['cadastrada', 'cadastraria'].includes(l.situacao))) {
  console.log(`  ${l.id}  ${l.titulo ?? ''}: ${l.situacao}${l.faixas ? ` (${l.pct}% do catálogo)` : ''}`)
}
