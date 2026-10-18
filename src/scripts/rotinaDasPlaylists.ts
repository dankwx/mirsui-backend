// src/scripts/rotinaDasPlaylists.ts
// A rotina das playlists de medição enquanto o catálogo cresce (migration 045).
//
//   npx tsx src/scripts/rotinaDasPlaylists.ts conferir [--gravar]
//   npx tsx src/scripts/rotinaDasPlaylists.ts novas <pasta>
//   npx tsx src/scripts/rotinaDasPlaylists.ts trocadas <pasta>
//   npx tsx src/scripts/rotinaDasPlaylists.ts semear <gabarito.csv> [--sem-isrc] [--em 2026-10-16]
//
// A semana, até o catálogo parar em 500 mil faixas:
//   1. conferir --gravar     lê as playlists cadastradas e marca o que cada uma
//                            trouxe das faixas exportadas para ela
//   2. novas <pasta>         CSV das faixas ativas nunca exportadas, com ISRC,
//                            "Mirsui NNN" a partir da próxima livre
//   3. subir <pasta>/novas.csv no TuneMyMusic (o Playlist name separa as playlists)
//   4. cadastrarPlaylists.ts --usuario 6866594521 --gravar
//   5. semear <pasta>/gabarito.csv
//
// `trocadas <pasta>` é o reenvio PELO NOME do que voltou trocado ou não veio,
// "Mirsui trocadas NN"; depois do upload, `semear <pasta>/gabarito.csv
// --sem-isrc`. Uma vez por faixa: o que já foi sem ISRC não sai de novo.
//
// novas e trocadas só escrevem arquivos. Quem grava a marca é o semear, depois
// do upload, para que um CSV que não chegou a subir não tire faixas da próxima
// exportação. Não rode novas duas vezes sem semear no meio: a numeração e as
// faixas sairiam repetidas.
//
// semear também serve para as exportações feitas antes deste script, pelos .py
// de ~/mirsui-playlists. Lê do gabarito as colunas playlist, deezer_track_id e
// isrc.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { supabaseAdmin } from '../lib/supabase'
import { faixasDaPlaylist } from '../lib/deezerCatalog'
import {
  conferirExportadas,
  linhaCsv,
  proximoNumero,
  repartir,
  type VoltouComo,
} from '../lib/rotinaDasPlaylists'

if (!supabaseAdmin) throw new Error('SUPABASE_SERVICE_ROLE_KEY não configurada')
const db = supabaseAdmin

const FAIXAS_POR_PLAYLIST = 2000
const IDS_POR_ESCRITA = 300

const args = process.argv.slice(2)
const flag = (nome: string) => {
  const i = args.indexOf(nome)
  if (i >= 0) args.splice(i, 1)
  return i >= 0
}
const opcao = (nome: string) => {
  const i = args.indexOf(nome)
  if (i < 0) return null
  const v = args[i + 1] ?? null
  args.splice(i, 2)
  return v
}
const gravar = flag('--gravar')
const semIsrc = flag('--sem-isrc')
const em = opcao('--em')
const [modo, alvo] = args

type Exportada = {
  deezer_track_id: string
  playlist_label: string
  isrc: string | null
  with_isrc: boolean
  came_back: VoltouComo | null
}
type Ativa = {
  deezer_track_id: string
  isrc: string | null
  title: string | null
  artist_name: string | null
  album_name: string | null
}

/** Uma tabela inteira, de 1.000 em 1.000, pela PK (as duas são por deezer_track_id). */
async function lerTudo<T extends { deezer_track_id: string }>(
  tabela: 'observed_tracks' | 'playlist_export_tracks',
  colunas: string,
  filtrar: (q: any) => any = (q) => q
): Promise<T[]> {
  const tudo: T[] = []
  let ultimo: string | null = null
  for (;;) {
    let q = filtrar(db.from(tabela).select(colunas)).order('deezer_track_id').limit(1000)
    if (ultimo) q = q.gt('deezer_track_id', ultimo)
    const { data, error } = await q
    if (error) throw error
    const lote = (data ?? []) as T[]
    tudo.push(...lote)
    if (lote.length < 1000) return tudo
    ultimo = lote[lote.length - 1].deezer_track_id
  }
}

async function rotulosEmUso(exportadas: { playlist_label: string }[]): Promise<string[]> {
  const { data, error } = await db.from('measurement_playlists').select('label')
  if (error) throw error
  return [...exportadas.map((e) => e.playlist_label), ...(data ?? []).map((p) => p.label as string | null ?? '')]
}

function escrever(pasta: string, nome: string, linhas: string[]) {
  writeFileSync(join(pasta, nome), linhas.join('\n') + '\n', 'utf8')
}

if (modo === 'semear') {
  if (!alvo) throw new Error('semear <gabarito.csv>')
  const [cabecalho, ...corpo] = readFileSync(alvo, 'utf8').trim().split(/\r?\n/)
  const col = cabecalho.split(',')
  const [iPl, iId, iIsrc] = ['playlist', 'deezer_track_id', 'isrc'].map((c) => col.indexOf(c))
  if (iPl < 0 || iId < 0 || iIsrc < 0) throw new Error('o gabarito precisa das colunas playlist, deezer_track_id e isrc')
  const quando = em ? new Date(`${em}T12:00:00-03:00`).toISOString() : new Date().toISOString()

  // O gabarito não tem vírgula dentro de campo: rótulo, posição, ids, ISRC.
  const porId = new Map<string, Record<string, unknown>>()
  for (const l of corpo) {
    const c = l.split(',')
    const isrc = semIsrc ? null : c[iIsrc]?.trim().toUpperCase() || null
    porId.set(c[iId], {
      deezer_track_id: c[iId],
      playlist_label: c[iPl],
      exported_at: quando,
      isrc,
      with_isrc: isrc !== null,
      came_back: null,
      checked_at: null,
    })
  }
  const linhas = [...porId.values()]
  for (let i = 0; i < linhas.length; i += 1000) {
    const { error } = await db
      .from('playlist_export_tracks')
      .upsert(linhas.slice(i, i + 1000), { onConflict: 'deezer_track_id' })
    if (error) throw error
  }
  const rotulos = new Set(linhas.map((l) => l.playlist_label))
  console.log(JSON.stringify({
    semeadas: linhas.length,
    playlists: rotulos.size,
    comIsrc: linhas.filter((l) => l.with_isrc).length,
    exportadasEm: quando,
  }))
} else if (modo === 'conferir') {
  const exportadas = await lerTudo<Exportada>('playlist_export_tracks', 'deezer_track_id, playlist_label, isrc, with_isrc, came_back')
  const { data: cadastradas, error } = await db
    .from('measurement_playlists')
    .select('deezer_playlist_id, label, active')
  if (error) throw error

  const porRotulo = new Map<string, Exportada[]>()
  for (const e of exportadas) {
    const doRotulo = porRotulo.get(e.playlist_label)
    if (doRotulo) doRotulo.push(e)
    else porRotulo.set(e.playlist_label, [e])
  }

  const resultado = new Map<string, VoltouComo>()
  const semPlaylist: string[] = []
  const naoLidas: string[] = []
  const porPlaylist: { rotulo: string; faixas: number; pelo_id: number }[] = []
  for (const [rotulo, linhas] of [...porRotulo].sort(([a], [b]) => a.localeCompare(b))) {
    // Mais de uma playlist com o mesmo título (um upload repetido) conta como uma só.
    const ids = (cadastradas ?? []).filter((p) => p.label === rotulo && p.active).map((p) => p.deezer_playlist_id as string)
    if (ids.length === 0) { semPlaylist.push(rotulo); continue }
    const lidas = await Promise.all(ids.map((id) => faixasDaPlaylist(id)))
    if (lidas.some((l) => l.falhou)) { naoLidas.push(rotulo); continue }
    const r = conferirExportadas(linhas, lidas.flatMap((l) => l.faixas))
    for (const [id, como] of r) resultado.set(id, como)
    const peloId = [...r.values()].filter((c) => c === 'id').length
    porPlaylist.push({ rotulo, faixas: linhas.length, pelo_id: peloId })
    console.log(`${rotulo.padEnd(20)} ${String(linhas.length).padStart(5)} exportadas  ${String(peloId).padStart(5)} pelo id (${(100 * peloId / linhas.length).toFixed(1)}%)`)
  }

  if (gravar) {
    const agora = new Date().toISOString()
    const porComo = new Map<VoltouComo, string[]>()
    for (const [id, como] of resultado) {
      const ids = porComo.get(como)
      if (ids) ids.push(id)
      else porComo.set(como, [id])
    }
    for (const [como, ids] of porComo) {
      for (let i = 0; i < ids.length; i += IDS_POR_ESCRITA) {
        const { error: e } = await db
          .from('playlist_export_tracks')
          .update({ came_back: como, checked_at: agora })
          .in('deezer_track_id', ids.slice(i, i + IDS_POR_ESCRITA))
        if (e) throw e
      }
    }
  }

  const contagem: Record<string, number> = {}
  for (const como of resultado.values()) contagem[como] = (contagem[como] ?? 0) + 1
  const pior = [...porPlaylist].sort((a, b) => a.pelo_id / a.faixas - b.pelo_id / b.faixas).slice(0, 3)
  console.log(JSON.stringify({
    exportadas: exportadas.length,
    conferidas: resultado.size,
    ...contagem,
    gravou: gravar,
    // Rótulo sem playlist: o CSV não subiu, ou o cadastro ainda não rodou.
    semPlaylistCadastrada: semPlaylist.length > 6
      ? [...semPlaylist.slice(0, 3), '...', ...semPlaylist.slice(-2)]
      : semPlaylist,
    naoDeuParaLer: naoLidas,
    piores: pior.map((p) => `${p.rotulo}: ${(100 * p.pelo_id / p.faixas).toFixed(1)}%`),
  }))
} else if (modo === 'novas') {
  if (!alvo) throw new Error('novas <pasta>')
  const ativas = await lerTudo<Ativa>('observed_tracks', 'deezer_track_id, isrc, title, artist_name, album_name', (q) => q.eq('active', true))
  const exportadas = await lerTudo<Exportada>('playlist_export_tracks', 'deezer_track_id, playlist_label')
  const jaFoi = new Set(exportadas.map((e) => e.deezer_track_id))
  const novas = ativas.filter((f) => !jaFoi.has(f.deezer_track_id))
  const primeira = proximoNumero(await rotulosEmUso(exportadas), 'Mirsui')
  const playlists = repartir(novas, FAIXAS_POR_PLAYLIST, (n) => `Mirsui ${String(n).padStart(3, '0')}`, primeira)

  mkdirSync(alvo, { recursive: false })
  escrever(alvo, 'novas.csv', [
    linhaCsv(['Track name', 'Artist name', 'Album', 'Playlist name', 'Type', 'ISRC']),
    ...playlists.flatMap((p) => p.itens.map((f) =>
      linhaCsv([f.title, f.artist_name, f.album_name, p.rotulo, 'Playlist', f.isrc?.toUpperCase()]))),
  ])
  escrever(alvo, 'gabarito.csv', [
    'playlist,posicao,deezer_track_id,isrc',
    ...playlists.flatMap((p) => p.itens.map((f, i) =>
      linhaCsv([p.rotulo, i + 1, f.deezer_track_id, f.isrc?.toUpperCase()]))),
  ])
  console.log(JSON.stringify({
    ativas: ativas.length,
    jaExportadas: ativas.length - novas.length,
    novas: novas.length,
    semIsrc: novas.filter((f) => !f.isrc).length,
    playlists: playlists.map((p) => p.rotulo).filter((_, i, a) => i === 0 || i === a.length - 1).join(' a '),
    arquivos: [join(alvo, 'novas.csv'), join(alvo, 'gabarito.csv')],
  }))
} else if (modo === 'trocadas') {
  if (!alvo) throw new Error('trocadas <pasta>')
  const todas = await lerTudo<Exportada>('playlist_export_tracks', 'deezer_track_id, playlist_label, isrc, with_isrc, came_back')
  const voltaram = todas.filter((e) => e.with_isrc && (e.came_back === 'trocada' || e.came_back === 'nao_veio'))

  // Só as ainda ativas, com o nome de hoje.
  const nomes = new Map<string, Ativa>()
  for (let i = 0; i < voltaram.length; i += IDS_POR_ESCRITA) {
    const { data, error } = await db
      .from('observed_tracks')
      .select('deezer_track_id, isrc, title, artist_name, album_name')
      .eq('active', true)
      .in('deezer_track_id', voltaram.slice(i, i + IDS_POR_ESCRITA).map((e) => e.deezer_track_id))
    if (error) throw error
    for (const f of (data ?? []) as Ativa[]) nomes.set(f.deezer_track_id, f)
  }
  const reenviar = voltaram.filter((e) => nomes.has(e.deezer_track_id))
  const primeira = proximoNumero(await rotulosEmUso(todas), 'Mirsui trocadas')
  const playlists = repartir(reenviar, FAIXAS_POR_PLAYLIST, (n) => `Mirsui trocadas ${String(n).padStart(2, '0')}`, primeira)

  mkdirSync(alvo, { recursive: false })
  // Sem a coluna ISRC: com ela o TuneMyMusic escolheria a mesma edição errada.
  escrever(alvo, 'trocadas.csv', [
    linhaCsv(['Track name', 'Artist name', 'Album', 'Playlist name', 'Type']),
    ...playlists.flatMap((p) => p.itens.map((e) => {
      const f = nomes.get(e.deezer_track_id)!
      return linhaCsv([f.title, f.artist_name, f.album_name, p.rotulo, 'Playlist'])
    })),
  ])
  escrever(alvo, 'gabarito.csv', [
    'playlist,posicao,deezer_track_id,isrc,motivo',
    ...playlists.flatMap((p) => p.itens.map((e, i) =>
      linhaCsv([p.rotulo, i + 1, e.deezer_track_id, e.isrc, e.came_back]))),
  ])
  console.log(JSON.stringify({
    voltaramSemONossoId: voltaram.length,
    reenviar: reenviar.length,
    playlists: playlists.map((p) => p.rotulo).filter((_, i, a) => i === 0 || i === a.length - 1).join(' a '),
    depoisDoUpload: `semear ${join(alvo, 'gabarito.csv')} --sem-isrc`,
  }))
} else {
  throw new Error('modo: conferir | novas <pasta> | trocadas <pasta> | semear <gabarito.csv>')
}
