import assert from 'node:assert/strict'
import test from 'node:test'
import { separarPeloTurno } from './catalogMeasurement'

const linha = (id: string, album: string | null) => ({ deezer_track_id: id, deezer_album_id: album })
const nenhuma = new Set<string>()

test('cadência 1 (ou inválida) mede tudo, todo dia', () => {
  const linhas = [linha('1', '10'), linha('2', '20'), linha('3', null)]
  for (const c of [1, 0, NaN]) {
    const r = separarPeloTurno(linhas, 20412, c, nenhuma)
    assert.equal(r.hoje, linhas)
    assert.equal(r.espacadas, 0)
  }
})

test('com cadência 3, cada faixa sai exatamente um dia a cada três', () => {
  // ids do Deezer são sequenciais; o turno tem que espalhar mesmo assim
  const linhas = Array.from({ length: 30_000 }, (_, i) => linha(String(3_000_000_000 + i), String(700_000_000 + i)))
  const vezes = new Map<string, number>()
  const porDia: number[] = []
  for (let dia = 20412; dia < 20412 + 3; dia++) {
    const r = separarPeloTurno(linhas, dia, 3, nenhuma)
    porDia.push(r.hoje.length)
    assert.equal(r.hoje.length + r.espacadas, linhas.length)
    for (const f of r.hoje) vezes.set(f.deezer_track_id, (vezes.get(f.deezer_track_id) ?? 0) + 1)
  }
  assert.equal(vezes.size, linhas.length)
  assert.ok([...vezes.values()].every((n) => n === 1))
  // repartido por igual: nenhum dia com mais de 36% (o ideal é 33,3%)
  for (const n of porDia) assert.ok(n / linhas.length < 0.36, `dia com ${n}`)
  // e o turno se repete: o dia 4 é o dia 1 de novo
  assert.deepEqual(
    separarPeloTurno(linhas, 20415, 3, nenhuma).hoje,
    separarPeloTurno(linhas, 20412, 3, nenhuma).hoje
  )
})

test('as faixas do mesmo álbum saem no mesmo dia', () => {
  const linhas = Array.from({ length: 900 }, (_, i) => linha(String(i), String(Math.floor(i / 9))))
  for (let dia = 0; dia < 3; dia++) {
    const hoje = separarPeloTurno(linhas, dia, 3, nenhuma).hoje
    const albunsHoje = new Set(hoje.map((f) => f.deezer_album_id))
    for (const f of linhas) {
      assert.equal(albunsHoje.has(f.deezer_album_id), hoje.includes(f), `álbum ${f.deezer_album_id} dividido`)
    }
  }
})

test('sem álbum, o turno é pelo id da faixa', () => {
  const linhas = Array.from({ length: 3_000 }, (_, i) => linha(String(i), null))
  const r = separarPeloTurno(linhas, 7, 3, nenhuma)
  assert.ok(r.hoje.length > 800 && r.hoje.length < 1_200)
})

test('quem alguém acompanha sai todo dia', () => {
  const linhas = Array.from({ length: 300 }, (_, i) => linha(String(i), String(i)))
  const sempre = new Set(['5', '50', '250'])
  for (let dia = 0; dia < 3; dia++) {
    const ids = new Set(separarPeloTurno(linhas, dia, 3, sempre).hoje.map((f) => f.deezer_track_id))
    for (const id of sempre) assert.ok(ids.has(id), `${id} faltou no dia ${dia}`)
  }
})
