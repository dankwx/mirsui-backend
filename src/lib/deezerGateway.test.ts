import assert from 'node:assert/strict'
import test from 'node:test'
import { DeezerGateway, normalizeDeezerPath, type DeezerPriority } from './deezerGateway'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

test('normaliza busca e paginação, rejeita destinos e caminhos fora da API permitida', () => {
  assert.equal(normalizeDeezerPath('/search?q=a%20b&limit=10'), '/search?limit=10&q=a+b')
  for (const p of ['//evil.test/track/1', 'https://evil.test/track/1', '/track/1?access_token=x', '/user/me',
    '/album/1/tracks?limit=999999', '/track/1#x']) assert.throws(() => normalizeDeezerPath(p))
})

test('limite agregado e concorrência valem para prioridades diferentes', async () => {
  const starts: number[] = []
  let active = 0, maxActive = 0
  const gateway = new DeezerGateway({ intervalMs: 15, concurrency: 2, fetch: (async () => {
    starts.push(Date.now()); active++; maxActive = Math.max(maxActive, active)
    await sleep(35); active--; return json({ rank: 1 })
  }) as typeof fetch })
  await Promise.all(Array.from({ length: 8 }, (_, i) => gateway.request(`/track/${i}`, ['interactive', 'catalog', 'stakes'][i % 3] as DeezerPriority)))
  assert.equal(starts.length, 8)
  assert.ok(maxActive <= 2)
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= 14)
})

test('deduplicação em voo cruza consumidores e o cache só atende quem aceita seu frescor', async () => {
  let calls = 0
  const gateway = new DeezerGateway({ intervalMs: 1, fetch: (async () => {
    calls++; await sleep(10); return json({ rank: calls })
  }) as typeof fetch })
  const [a, b] = await Promise.all([gateway.request('/track/1', 'catalog', 0), gateway.request('/track/1', 'interactive')])
  assert.deepEqual(a, b)
  assert.equal(calls, 1)
  const cached = await gateway.request('/track/1', 'interactive')
  assert.ok(cached.ok && cached.cached)
  await gateway.request('/track/1', 'stakes', 0)
  assert.equal(calls, 2)
})

test('403 pausa todos, inclusive chamadas agendadas, e uma resposta antiga não libera', async () => {
  const saved: unknown[] = []
  let calls = 0
  const gateway = new DeezerGateway({ intervalMs: 5, concurrency: 2, backoffMs: 60,
    savePause: (s) => saved.push(s), fetch: (async () => {
      const n = ++calls
      if (n === 1) { await sleep(12); return json({}, 403) }
      if (n === 2) { await sleep(25); return json({ rank: 10 }) }
      return json({ rank: 20 })
    }) as typeof fetch })
  const results = await Promise.all([gateway.request('/track/1', 'catalog', 0),
    gateway.request('/track/2', 'stakes', 0), gateway.request('/track/3', 'interactive', 0)])
  assert.equal(calls, 2)
  assert.ok(results.some((r) => !r.ok && r.reason === 'blocked'))
  assert.ok(!(await gateway.request('/track/4', 'interactive', 0)).ok)
  assert.equal(calls, 2)
  await sleep(65)
  assert.ok((await gateway.request('/track/4', 'stakes', 0)).ok)
  assert.equal(calls, 3)
  assert.equal(saved.length, 2)
})

test('erro 4 no HTTP 200 também pausa; erro 800 permanece distinguível', async () => {
  const gateway = new DeezerGateway({ intervalMs: 1, backoffMs: 10,
    fetch: (async () => json({ error: { code: 4 } })) as typeof fetch })
  const r = await gateway.request('/track/1', 'catalog')
  assert.ok(!r.ok && r.reason === 'blocked')
  let calls = 0
  const missing = new DeezerGateway({ intervalMs: 1,
    fetch: (async () => { calls++; return json({ error: { code: 800 } }) }) as typeof fetch })
  assert.ok((await missing.request('/track/1', 'catalog')).ok)
  await missing.request('/track/1', 'interactive')
  assert.equal(calls, 2, 'erros não entram no cache')
})

test('rodízio atende usuário, Stakes e catálogo sem drenar toda a fila de background primeiro', async () => {
  const paths: string[] = []
  const gateway = new DeezerGateway({ intervalMs: 3, concurrency: 1,
    fetch: (async (url) => { paths.push(String(url)); await sleep(2); return json({ id: 1 }) }) as typeof fetch })
  const work = Array.from({ length: 20 }, (_, i) => gateway.request(`/track/${i}`, 'catalog', 0))
  work.push(gateway.request('/artist/1', 'interactive', 0), gateway.request('/artist/2', 'stakes', 0))
  await Promise.all(work)
  assert.ok(paths.indexOf('https://api.deezer.com/artist/1') < 5)
  assert.ok(paths.indexOf('https://api.deezer.com/artist/2') < 6)
  assert.equal(paths.length, 22)
})

test('pausa persistida sobrevive a uma nova instância', async () => {
  const gateway = new DeezerGateway({ initialPause: { until: Date.now() + 1000, waves: 2 },
    fetch: (async () => { assert.fail('não consultar durante pausa') }) as typeof fetch })
  assert.ok(!(await gateway.request('/track/1', 'stakes')).ok)
})

test('HTTP 429 respeita Retry-After e persiste a pausa', async () => {
  let state = { until: 0, waves: 0 }
  const before = Date.now()
  const gateway = new DeezerGateway({ savePause: (s) => { state = s },
    fetch: (async () => new Response('', { status: 429, headers: { 'retry-after': '60' } })) as typeof fetch })
  const r = await gateway.request('/track/1', 'interactive')
  assert.ok(!r.ok && r.reason === 'blocked')
  assert.ok(state.until >= before + 60_000)
  assert.equal(state.waves, 1)
})

test('timeout libera concorrência e não vira recurso removido', async () => {
  let calls = 0
  const gateway = new DeezerGateway({ intervalMs: 1, concurrency: 1, timeoutMs: 10,
    fetch: (async (_url, init) => {
      if (++calls > 1) return json({ rank: 3 })
      return new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => reject(new Error('timeout')), { once: true })
      })
    }) as typeof fetch })
  const results = await Promise.all([gateway.request('/track/1', 'catalog'), gateway.request('/track/2', 'interactive')])
  assert.ok(!results[0].ok && results[0].reason === 'network')
  assert.ok(results[1].ok)
})

test('fila limitada e expiração evitam trabalho sem consumidor', async () => {
  let calls = 0
  const gateway = new DeezerGateway({ intervalMs: 30, concurrency: 1, maxPending: 2,
    fetch: (async () => { calls++; await sleep(25); return json({ rank: 1 }) }) as typeof fetch })
  const first = gateway.request('/track/1', 'catalog', 0, 1000)
  const expired = gateway.request('/track/2', 'interactive', 0, 5)
  const busy = await gateway.request('/track/3', 'catalog')
  assert.ok(!busy.ok && busy.reason === 'busy')
  assert.ok(!(await expired).ok)
  await first
  await sleep(35)
  assert.equal(calls, 1)
})
