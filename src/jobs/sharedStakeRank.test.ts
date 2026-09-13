import assert from 'node:assert/strict'
import test from 'node:test'
import { sharedStakeRank } from './sharedStakeRank'

test('mil fichas da mesma música compartilham uma consulta e a mesma observação', async () => {
  let calls = 0
  const read = sharedStakeRank(async (_id, priority) => {
    assert.equal(priority, 'stakes')
    return { rank: ++calls * 100, notFound: false }
  })
  const results = await Promise.all(Array.from({ length: 1000 }, () => read('1')))
  assert.equal(calls, 1)
  assert.deepEqual(read.stats, { uniqueTracks: 1, sharedReads: 999 })
  assert.ok(results.every((r) => r.rank === 100))
  assert.equal((await read('2')).rank, 200)
})

test('falha é compartilhada na rodada sem virar rank zero; nova rodada pode recuperar', async () => {
  let calls = 0
  const source = async () => ({ rank: ++calls === 1 ? null : 50, notFound: false })
  const first = sharedStakeRank(source)
  assert.equal((await first('1')).rank, null)
  assert.equal((await first('1')).rank, null)
  assert.equal(calls, 1)
  assert.equal((await sharedStakeRank(source)('1')).rank, 50)
})

test('remoção confirmada se aplica a todas as fichas da mesma música', async () => {
  let calls = 0
  const read = sharedStakeRank(async () => { calls++; return { rank: null, notFound: true } })
  assert.equal((await read('1')).notFound, true)
  assert.equal((await read('1')).notFound, true)
  assert.equal(calls, 1)
})
