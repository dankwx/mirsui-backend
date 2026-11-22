import assert from 'node:assert/strict'
import test from 'node:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import { remontarVizinhanca } from './artistNeighbors'

type Chamada = { fn: string; args?: Record<string, number> }

// Um PostgREST de mentira: anota cada rpc e falha onde o teste mandar.
function bancoFalso(falhar: (c: Chamada) => boolean = () => false) {
  const chamadas: Chamada[] = []
  const db = {
    rpc: async (fn: string, args?: Record<string, number>) => {
      const c = { fn, args }
      chamadas.push(c)
      if (falhar(c)) return { data: null, error: { message: 'canceling statement due to statement timeout' } }
      if (fn === 'stage_artist_pairs') return { data: 1000, error: null }
      if (fn === 'rebuild_artist_pairs') return { data: 100, error: null }
      return { data: { artistas: 10, diretos: 50, segundo: 20 }, error: null }
    },
  } as unknown as SupabaseClient
  return { db, chamadas }
}

const logMudo = { info: () => {}, error: () => {} }
const nome = (c: Chamada) =>
  c.fn === 'stage_artist_pairs' ? `arestas ${c.args?.p_parte}` : `${c.fn === 'rebuild_artist_pairs' ? 'pares' : 'vizinhos'} ${c.args?.p_lote}/${c.args?.p_lotes}`

test('a rodada junta as arestas em duas partes, soma os pares e monta a vizinhança, em lotes', async () => {
  const { db, chamadas } = bancoFalso()
  const r = await remontarVizinhanca(db, 3, logMudo)
  assert.deepEqual(chamadas.map(nome), [
    'arestas 0',
    'arestas 1',
    'pares 0/3',
    'pares 1/3',
    'pares 2/3',
    'vizinhos 0/3',
    'vizinhos 1/3',
    'vizinhos 2/3',
  ])
  assert.deepEqual(r, { pares: 300, artistas: 30, diretos: 150, segundo: 60, lotes: 3, falhas: 0 })
})

test('arestas pela metade não viram pares: a falha da parte 1 para tudo', async () => {
  const { db, chamadas } = bancoFalso((c) => c.fn === 'stage_artist_pairs' && c.args?.p_parte === 1)
  const r = await remontarVizinhanca(db, 3, logMudo)
  assert.deepEqual(chamadas.map(nome), ['arestas 0', 'arestas 1'])
  assert.equal(r.falhas, 1)
  assert.equal(r.pares, 0)
  assert.equal(r.lotes, 0)
})

test('um lote de pares que falha não impede os outros nem a vizinhança', async () => {
  const { db, chamadas } = bancoFalso((c) => c.fn === 'rebuild_artist_pairs' && c.args?.p_lote === 1)
  const r = await remontarVizinhanca(db, 3, logMudo)
  assert.equal(chamadas.filter((c) => c.fn === 'rebuild_artist_neighbors').length, 3)
  assert.equal(r.pares, 200)
  assert.equal(r.falhas, 1)
  assert.equal(r.lotes, 3)
})

test('zero lotes não chama nada', async () => {
  const { db, chamadas } = bancoFalso()
  await remontarVizinhanca(db, 0, logMudo)
  assert.equal(chamadas.length, 0)
})
