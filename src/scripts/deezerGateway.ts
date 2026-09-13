import 'dotenv/config'
import Fastify from 'fastify'
import { timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { DeezerGateway, type DeezerPriority } from '../lib/deezerGateway'

const token = process.env.DEEZER_GATEWAY_TOKEN
if (!token || token.length < 32) throw new Error('DEEZER_GATEWAY_TOKEN must contain at least 32 characters')
const stateFile = process.env.DEEZER_GATEWAY_STATE_FILE
let initialPause: { until: number; waves: number } | undefined
if (stateFile) {
  try {
    const state = JSON.parse(readFileSync(stateFile, 'utf8'))
    if (!Number.isFinite(state.until) || !Number.isInteger(state.waves) || state.waves < 0) throw new Error('Invalid pause state')
    initialPause = state
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
}
const rps = Number(process.env.DEEZER_REQUESTS_PER_SECOND || 3)
if (!Number.isFinite(rps) || rps <= 0 || rps > 10) throw new Error('Invalid DEEZER_REQUESTS_PER_SECOND')
const gateway = new DeezerGateway({ intervalMs: Math.ceil(1000 / rps), initialPause,
  savePause: stateFile ? (state) => {
    mkdirSync(dirname(stateFile), { recursive: true, mode: 0o700 })
    writeFileSync(`${stateFile}.tmp`, JSON.stringify(state), { mode: 0o600 })
    renameSync(`${stateFile}.tmp`, stateFile)
  } : undefined,
})
const app = Fastify({ bodyLimit: 4096, logger: { redact: ['req.headers.authorization'] } })
app.get('/health', async () => ({ status: 'ok', gateway: gateway.snapshot() }))
app.post<{ Body: { path: string; priority: DeezerPriority; maxAgeMs: number; waitMs: number } }>('/request', {
  schema: { body: { type: 'object', additionalProperties: false, required: ['path', 'priority', 'maxAgeMs', 'waitMs'],
    properties: { path: { type: 'string', maxLength: 2048 }, priority: { enum: ['interactive', 'stakes', 'catalog'] },
      maxAgeMs: { type: 'integer', minimum: 0, maximum: 86400000 }, waitMs: { type: 'integer', minimum: 1, maximum: 120000 } } } },
}, async (request, reply) => {
  const expected = Buffer.from(`Bearer ${token}`)
  const supplied = Buffer.from(request.headers.authorization || '')
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return reply.code(401).send({ error: 'Unauthorized' })
  try {
    const { path, priority, maxAgeMs, waitMs } = request.body
    return await gateway.request(path, priority, maxAgeMs, waitMs)
  } catch { return reply.code(400).send({ error: 'Invalid Deezer request' }) }
})
await app.listen({ host: '127.0.0.1', port: Number(process.env.DEEZER_GATEWAY_PORT || 3012) })
setInterval(() => app.log.info(gateway.snapshot(), 'Deezer shared gateway metrics'), 60_000).unref()
