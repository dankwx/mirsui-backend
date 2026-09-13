import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'
import { faixasDoAlbum } from './deezerCatalog'

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })
const mock = (respostas: unknown[]) => {
  const paths: string[] = []
  globalThis.fetch = (async (url: unknown) => {
    paths.push(String(url))
    assert.ok(respostas.length, 'consulta inesperada')
    return new Response(JSON.stringify(respostas.shift()), { status: 200 })
  }) as typeof fetch
  return paths
}

test('álbum paginado mantém ranks e ISRCs individuais de todas as páginas', async () => {
  const paths = mock([
    { data: [{ id: 1, rank: 12, isrc: 'A' }], total: 2,
      next: 'https://api.deezer.com/album/10/tracks?index=1&limit=1' },
    { data: [{ id: 2, rank: 0, isrc: 'B' }], total: 2 },
  ])
  const r = await faixasDoAlbum('10')
  assert.equal(r.falhou, false)
  assert.deepEqual(r.faixas.map((f) => [f.deezer_track_id, f.rank, f.isrc]),
    [['1', 12, 'A'], ['2', 0, 'B']])
  assert.equal(paths.length, 2)
  assert.ok(paths[1].endsWith('limit=300&index=1'))
})

test('falha na segunda página não é confundida com álbum completo', async () => {
  mock([{ data: [{ id: 1, rank: 10 }], next: '/album/10/tracks?index=1' },
    { error: { code: 800 } }])
  assert.deepEqual(await faixasDoAlbum('10'), { faixas: [], falhou: true })
})

test('paginação circular é falha, não um laço infinito', async () => {
  const paths = mock([{ data: [{ id: 1 }], next: '/album/10/tracks?index=0' }])
  assert.equal((await faixasDoAlbum('10')).falhou, true)
  assert.equal(paths.length, 1)
})

test('next de outro recurso não é seguido', async () => {
  const paths = mock([{ data: [{ id: 1 }], next: 'https://example.com/album/10/tracks?index=1' }])
  assert.equal((await faixasDoAlbum('10')).falhou, true)
  assert.equal(paths.length, 1)
})

test('total maior que a lista sem next é resposta incompleta', async () => {
  mock([{ data: [{ id: 1 }], total: 2 }])
  assert.equal((await faixasDoAlbum('10')).falhou, true)
})
