import assert from 'node:assert/strict'
import test from 'node:test'
import { medirPorAlbum, medirPorPlaylist, type LinhaParaMedir } from './catalogMeasurement'
import type { faixasDaPlaylist, faixasDoAlbum } from '../lib/deezerCatalog'

const linha = (id: string, album: string | null = '10'): LinhaParaMedir => ({
  deezer_track_id: id, deezer_album_id: album, deezer_artist_id: '7',
  title: `Faixa ${id}`, artist_name: 'Artista', source_list: 'acervo',
})
const faixa = (id: string, rank: number | null) => ({
  deezer_track_id: id, rank, isrc: `ISRC${id}`, deezer_artist_id: null,
  title: null, artist_name: null,
})
const coletar = async (linhas: LinhaParaMedir[], consultar: typeof faixasDoAlbum) => {
  const lotes = []
  for await (const lote of medirPorAlbum(linhas, consultar)) lotes.push(lote)
  return {
    medidas: lotes.flatMap((l) => l.medidas),
    individuais: lotes.flatMap((l) => l.individuais),
    albuns: lotes.reduce((n, l) => n + l.albunsConsultados, 0),
  }
}

test('cinco músicas usam um álbum e preservam cinco ranks por ID, incluindo zero', async () => {
  const chamadas: string[] = []
  const r = await coletar(['1', '2', '3', '4', '5'].map((id) => linha(id)), async (id) => {
    chamadas.push(id)
    return { falhou: false, faixas: [faixa('5', 500), faixa('2', 20), faixa('1', 0),
      faixa('4', 400), faixa('3', 30), faixa('fora-da-fila', 999)] }
  })
  assert.deepEqual(chamadas, ['10'])
  assert.deepEqual(r.medidas.map((f) => [f.deezer_track_id, f.rank]),
    [['1', 0], ['2', 20], ['3', 30], ['4', 400], ['5', 500]])
  assert.equal(r.medidas[0].source_list, 'acervo')
  assert.equal(r.medidas[0].deezer_artist_id, '7')
  assert.equal(r.medidas[0].deezer_album_id, '10')
  assert.equal(r.medidas[0].isrc, 'ISRC1')
  assert.deepEqual(r.individuais, [])
})

test('ausente e rank inválido têm fallback; nunca recebem rank de outra faixa', async () => {
  const r = await coletar(['1', '2', '3', '4'].map((id) => linha(id)), async () => ({
    falhou: false, faixas: [faixa('1', 45), faixa('3', null), faixa('4', NaN)],
  }))
  assert.deepEqual(r.medidas.map((f) => f.deezer_track_id), ['1'])
  assert.deepEqual(r.individuais.map((f) => f.deezer_track_id), ['2', '3', '4'])
})

test('erro do álbum devolve todo o grupo ao caminho individual sem observações falsas', async () => {
  const r = await coletar([linha('1'), linha('2')], async () => ({
    falhou: true, faixas: [faixa('1', 50)],
  }))
  assert.deepEqual(r.medidas, [])
  assert.deepEqual(r.individuais.map((f) => f.deezer_track_id), ['1', '2'])
})

test('álbum vazio também precisa confirmar cada faixa individualmente', async () => {
  const r = await coletar([linha('1'), linha('2')], async () => ({ falhou: false, faixas: [] }))
  assert.equal(r.individuais.length, 2)
  assert.equal(r.medidas.length, 0)
})

test('faixa sem álbum ou única no álbum não gasta chamada extra', async () => {
  const r = await coletar([linha('1', null), linha('2', '20')], async () => {
    assert.fail('não deve consultar álbum')
  })
  assert.deepEqual(r.individuais.map((f) => f.deezer_track_id), ['1', '2'])
  assert.equal(r.albuns, 0)
})

test('agrupa antes dos blocos e deduplica IDs sem exceder as faixas admitidas', async () => {
  const linhas = [linha('1'), ...Array.from({ length: 300 }, (_, i) => linha(`solo${i}`, null)),
    linha('2'), linha('1')]
  let chamadas = 0
  const r = await coletar(linhas, async () => {
    chamadas++
    return { falhou: false, faixas: [faixa('1', 10), faixa('2', 20)] }
  })
  assert.equal(chamadas, 1)
  assert.equal(r.medidas.length, 2)
  assert.equal(r.individuais.length, 300)
})

test('a medição por álbum leva duração, explícito e prévia, e não apaga data nem participações', async () => {
  const r = await coletar([linha('1'), linha('2')], async () => ({
    falhou: false,
    faixas: [
      { ...faixa('1', 10), duration_seconds: 180, explicit_lyrics: true, has_preview: false },
      { ...faixa('2', 20), duration_seconds: null, explicit_lyrics: null, has_preview: null },
    ],
  }))
  const [um, dois] = r.medidas
  assert.equal(um.duration_seconds, 180)
  assert.equal(um.explicit_lyrics, true)
  assert.equal(um.has_preview, false)
  // Ausente, e não null: record_observations lê as duas coisas como "não
  // disse", mas o contrato é que o álbum nem toca nesses campos.
  assert.equal('release_date' in um, false)
  assert.equal('contributors' in um, false)
  assert.equal(dois.has_preview, null)
})

// Playlists de medição: casamento só pelo id, o resto fica para o álbum.
const daPlaylist = (id: string, rank: number | null, readable: boolean | null = true) => ({
  deezer_track_id: id, rank, readable, isrc: `ISRC${id}`, deezer_artist_id: '8', deezer_album_id: '80',
  title: `Da playlist ${id}`, artist_name: 'Outro', album_name: 'Disco', cover_md5: 'b'.repeat(32),
  duration_seconds: 200, explicit_lyrics: false, has_preview: true, release_date: null, contributors: null,
})
const medirTudo = async (linhas: LinhaParaMedir[], playlists: string[], consultar: typeof faixasDaPlaylist) => {
  const lotes = []
  for await (const lote of medirPorPlaylist(linhas, playlists, consultar)) lotes.push(lote)
  return lotes
}

test('playlist mede pelo id, ignora quem não está na fila e devolve o resto', async () => {
  const lotes = await medirTudo([linha('1'), linha('2'), linha('3'), linha('4')], ['p1'], async () => ({
    falhou: false,
    faixas: [daPlaylist('1', 100), daPlaylist('2', 0), daPlaylist('3', null), daPlaylist('4', 40, false),
      daPlaylist('fora-da-fila', 999)],
  }))
  assert.equal(lotes.length, 1)
  const [l] = lotes
  assert.deepEqual(l.medidas.map((f) => [f.deezer_track_id, f.rank]), [['1', 100], ['2', 0]])
  assert.equal(l.semRank, 2, 'sem rank e readable=false voltam ao caminho atual')
  assert.equal(l.lidas, 5)
  assert.equal(l.medidas[0].source_list, 'acervo', 'a origem é da fila, não da playlist')
  assert.equal(l.medidas[0].deezer_album_id, '80')
  assert.equal(l.medidas[0].cover_md5, 'b'.repeat(32))
})

test('faixa em duas playlists é medida uma vez; playlist que falha não mede nada', async () => {
  const lotes = await medirTudo([linha('1'), linha('2')], ['p1', 'p2', 'p3'], async (id) =>
    id === 'p3' ? { falhou: true, faixas: [] } : { falhou: false, faixas: [daPlaylist('1', 10), daPlaylist(id === 'p2' ? '2' : '1', 20)] })
  assert.deepEqual(lotes.map((l) => [l.playlistId, l.falhou, l.medidas.map((f) => f.deezer_track_id)]),
    [['p1', false, ['1']], ['p2', false, ['2']], ['p3', true, []]])
})

test('outra edição com o mesmo ISRC não é medida no lugar da nossa', async () => {
  const [l] = await medirTudo([linha('1')], ['p1'], async () => ({ falhou: false, faixas: [{ ...daPlaylist('99', 5), isrc: 'ISRC1' }] }))
  assert.deepEqual(l.medidas, [])
})
