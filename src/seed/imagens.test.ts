import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { listarPool, contarPool, sortearDoPool, devolverAoPool, apagarUsada, PoolVazio } from './imagens'

async function poolTemporario(arquivos: string[]): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mirsui-imagens-'))
  for (const a of arquivos) await fs.writeFile(path.join(dir, a), a)
  return dir
}

test('listarPool: só JPEGs da raiz, ordenados, sem descer em usadas/', async () => {
  const dir = await poolTemporario(['b.jpg', 'a.JPG', 'c.jpeg', 'notas.txt'])
  await fs.mkdir(path.join(dir, 'usadas'))
  await fs.writeFile(path.join(dir, 'usadas', 'z.jpg'), 'z')
  assert.deepEqual(await listarPool(dir), ['a.JPG', 'b.jpg', 'c.jpeg'])
  assert.equal(await contarPool(dir), 3)
})

test('sortearDoPool: move para usadas/ e nunca repete; pool vazio lança PoolVazio', async () => {
  const dir = await poolTemporario(['1.jpg', '2.jpg', '3.jpg'])
  const vistos = new Set<string>()
  for (let i = 0; i < 3; i++) vistos.add(await sortearDoPool(dir))
  assert.equal(vistos.size, 3)
  assert.deepEqual(await listarPool(dir), [])
  assert.deepEqual((await fs.readdir(path.join(dir, 'usadas'))).sort(), ['1.jpg', '2.jpg', '3.jpg'])
  await assert.rejects(sortearDoPool(dir), PoolVazio)
})

test('devolverAoPool e apagarUsada: desfazem e encerram o uso', async () => {
  const dir = await poolTemporario(['x.jpg'])
  const a = await sortearDoPool(dir)
  assert.equal(a, 'x.jpg')
  await devolverAoPool(a, dir)
  assert.deepEqual(await listarPool(dir), ['x.jpg'])

  await sortearDoPool(dir)
  await apagarUsada('x.jpg', dir)
  assert.deepEqual(await fs.readdir(path.join(dir, 'usadas')), [])
  await assert.doesNotReject(apagarUsada('x.jpg', dir))
})
