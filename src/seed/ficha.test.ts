import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { FaixaDaBusca } from '../lib/deezer'
import { sortearClaimedAt, montarLinha, criarFicha, criarFichas } from './ficha'
import { filtroDaGravacao } from '../lib/gravacao'

function rngFixo(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

function faixa(over: Partial<FaixaDaBusca> = {}): FaixaDaBusca {
  return {
    id: 'BRXXX2400001',
    title: 'Nobody',
    artist: 'Mitski',
    uri: 'isrc:BRXXX2400001',
    isrc: 'BRXXX2400001',
    deezerTrackId: '123',
    deezerArtistId: '9',
    deezerAlbumId: '77',
    albumName: 'Be the Cowboy',
    duration: 200,
    explicit: false,
    releaseDate: null,
    thumbnail: 'https://cdn/x.jpg',
    cover: null,
    preview: null,
    rank: 417559,
    ...over
  }
}

interface Linha { id: number; user_id: string; track_uri: string; isrc: string | null; position: number; claimedat: string }

/**
 * Um `tracks` de mentira que entende só o que `criarFicha` usa: `.or(filtro)`
 * com `isrc.eq.X,track_uri.eq.Y`, `.eq('user_id')`, `count: 'exact'` e insert.
 */
function bancoFalso(inicial: Linha[] = []) {
  const linhas = [...inicial]
  let proximoId = 1000
  const inserts: Record<string, unknown>[] = []

  function casaFiltro(l: Linha, filtro: string): boolean {
    return filtro.split(',').some(cond => {
      const [campo, , valor] = cond.split('.')
      return (l as unknown as Record<string, unknown>)[campo] === valor
    })
  }

  const from = (tabela: string) => {
    assert.equal(tabela, 'tracks')
    let filtro = ''
    let userId: string | null = null
    let contar = false
    let pendente: Record<string, unknown> | null = null
    const q = {
      select(_cols: string, opts?: { count?: string; head?: boolean }) {
        if (opts?.count === 'exact') contar = true
        return q
      },
      eq(campo: string, v: string) {
        assert.equal(campo, 'user_id')
        userId = v
        return q
      },
      or(f: string) {
        filtro = f
        return q
      },
      limit() {
        return q
      },
      insert(rows: Record<string, unknown>[]) {
        pendente = rows[0]
        return q
      },
      single() {
        assert.ok(pendente)
        const l = { id: proximoId++, ...pendente } as unknown as Linha
        linhas.push(l)
        inserts.push(pendente)
        return Promise.resolve({ data: { id: l.id, position: l.position, track_uri: l.track_uri, claimedat: l.claimedat }, error: null })
      },
      maybeSingle() {
        const achada = linhas.find(l => (userId === null || l.user_id === userId) && casaFiltro(l, filtro))
        return Promise.resolve({ data: achada ? { id: achada.id } : null, error: null })
      },
      then(res: (v: unknown) => void) {
        assert.ok(contar)
        const n = linhas.filter(l => casaFiltro(l, filtro)).length
        res({ count: n, error: null })
      }
    }
    return q
  }
  return { admin: { from } as unknown as SupabaseClient, linhas, inserts }
}

test('sortearClaimedAt: dentro da janela; janela vazia devolve o fim', () => {
  const rng = rngFixo(3)
  const inicio = new Date('2025-01-01T00:00:00Z')
  const fim = new Date('2025-06-01T00:00:00Z')
  for (let i = 0; i < 200; i++) {
    const d = sortearClaimedAt(inicio, fim, rng)
    assert.ok(d >= inicio && d < fim, d.toISOString())
  }
  assert.equal(sortearClaimedAt(fim, inicio, rng).getTime(), inicio.getTime())
  assert.equal(sortearClaimedAt(fim, fim, rng).getTime(), fim.getTime())
})

test('montarLinha: a conta da rota — popScore do rank, rating pela posição, url do Deezer', () => {
  const quando = new Date('2025-03-04T05:06:07Z')
  const l = montarLinha('u1', faixa(), 2, quando)
  assert.equal(l.popularity, 42)
  assert.equal(l.discover_rating, 100 - 42 + 50)
  assert.equal(l.track_url, 'https://www.deezer.com/track/123')
  assert.equal(l.track_uri, 'isrc:BRXXX2400001')
  assert.equal(l.isrc, 'BRXXX2400001')
  assert.equal(l.album_name, 'Be the Cowboy')
  assert.equal(l.claimedat, '2025-03-04T05:06:07.000Z')
  assert.equal(l.user_id, 'u1')
  assert.equal(l.position, 2)
  // sem álbum a coluna NOT NULL recebe vazio
  assert.equal(montarLinha('u1', faixa({ albumName: null }), 1, quando).album_name, '')
})

test('criarFicha: posição = fichas da gravação + 1, contando por isrc OU uri', async () => {
  const { admin, inserts } = bancoFalso([
    { id: 1, user_id: 'real', track_uri: 'spotify:track:abc', isrc: 'BRXXX2400001', position: 1, claimedat: '2025-01-01' },
    { id: 2, user_id: 'outro', track_uri: 'isrc:BRXXX2400001', isrc: 'BRXXX2400001', position: 2, claimedat: '2025-02-01' },
    { id: 3, user_id: 'x', track_uri: 'isrc:OUTRA', isrc: 'OUTRA', position: 1, claimedat: '2025-02-01' }
  ])
  const f = await criarFicha(admin, 'seed1', faixa(), new Date('2025-05-05T00:00:00Z'))
  assert.ok(f)
  assert.equal(f.position, 3)
  assert.equal(inserts.length, 1)
  assert.equal(inserts[0].discover_rating, 100 - 42 + 100 / 3)
})

test('criarFicha: sem isrc conta só pela uri; primeira ficha da gravação é a posição 1', async () => {
  const { admin } = bancoFalso([
    { id: 1, user_id: 'a', track_uri: 'isrc:BRXXX2400001', isrc: 'BRXXX2400001', position: 1, claimedat: '2025-01-01' }
  ])
  const f = await criarFicha(admin, 'seed1', faixa({ isrc: null, uri: 'deezer:track:123', id: '123' }), new Date())
  assert.ok(f)
  assert.equal(f.position, 1)
  assert.equal(filtroDaGravacao('deezer:track:123', null), 'track_uri.eq.deezer:track:123')
})

test('criarFicha: o perfil que já tem a gravação não ganha outra (null, nada inserido)', async () => {
  const { admin, inserts } = bancoFalso([
    { id: 1, user_id: 'seed1', track_uri: 'spotify:track:abc', isrc: 'BRXXX2400001', position: 1, claimedat: '2025-01-01' }
  ])
  assert.equal(await criarFicha(admin, 'seed1', faixa(), new Date()), null)
  assert.equal(inserts.length, 0)
})

test('criarFichas: uma por faixa, datas depois da entrada da conta e antes de agora', async () => {
  const { admin, inserts } = bancoFalso()
  const criadoEm = new Date('2025-04-01T00:00:00Z')
  const agora = new Date('2025-09-01T00:00:00Z')
  const fichas = await criarFichas(
    admin,
    'seed1',
    [faixa(), faixa({ isrc: 'GBAAA2400002', uri: 'isrc:GBAAA2400002', id: 'GBAAA2400002', deezerTrackId: '456' })],
    criadoEm,
    { agora, rng: rngFixo(9) }
  )
  assert.equal(fichas.length, 2)
  assert.equal(inserts.length, 2)
  for (const l of inserts) {
    const d = new Date(l.claimedat as string)
    assert.ok(d >= criadoEm && d < agora, l.claimedat as string)
  }
  assert.deepEqual(fichas.map(f => f.position), [1, 1])
})
