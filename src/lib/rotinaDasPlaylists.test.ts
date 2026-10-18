import assert from 'node:assert/strict'
import test from 'node:test'
import { conferirExportadas, linhaCsv, proximoNumero, repartir } from './rotinaDasPlaylists'

test('conferência casa só pelo id e separa ilegível, trocada e ausente', () => {
  const r = conferirExportadas(
    [
      { deezer_track_id: '1', isrc: 'AAA000000001' },
      { deezer_track_id: '2', isrc: 'AAA000000002' },
      { deezer_track_id: '3', isrc: 'aaa000000003' },
      { deezer_track_id: '4', isrc: 'AAA000000004' },
      { deezer_track_id: '5', isrc: null },
    ],
    [
      { deezer_track_id: '1', isrc: 'AAA000000001', readable: true },
      { deezer_track_id: '2', isrc: 'AAA000000002', readable: false },
      { deezer_track_id: '99', isrc: 'AAA000000003', readable: true },
      { deezer_track_id: '98', isrc: null, readable: null },
    ]
  )
  assert.deepEqual(Object.fromEntries(r), { 1: 'id', 2: 'ilegivel', 3: 'trocada', 4: 'nao_veio', 5: 'nao_veio' })
})

test('próximo número ignora a playlist de teste sem número e outros prefixos', () => {
  const rotulos = ['Mirsui 001', 'Mirsui 156', 'Mirsui trocadas', 'Mirsui trocadas 02', 'My playlist 1', null]
  assert.equal(proximoNumero(rotulos, 'Mirsui'), 157)
  assert.equal(proximoNumero(rotulos, 'Mirsui trocadas'), 3)
  assert.equal(proximoNumero([], 'Mirsui trocadas'), 1)
})

test('CSV com aspas só quando precisa', () => {
  assert.equal(linhaCsv(['Halo', 'DMN', null, 'Mirsui 157', 'Playlist', 'X']), 'Halo,DMN,,Mirsui 157,Playlist,X')
  assert.equal(linhaCsv(['Na Na (From "Vicky")', 'A, B']), '"Na Na (From ""Vicky"")","A, B"')
})

test('reparte em playlists numeradas', () => {
  const p = repartir([1, 2, 3, 4, 5], 2, (n) => `Mirsui ${String(n).padStart(3, '0')}`, 157)
  assert.deepEqual(p, [
    { rotulo: 'Mirsui 157', itens: [1, 2] },
    { rotulo: 'Mirsui 158', itens: [3, 4] },
    { rotulo: 'Mirsui 159', itens: [5] },
  ])
})
