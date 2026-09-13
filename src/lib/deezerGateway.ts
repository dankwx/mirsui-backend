export type DeezerPriority = 'interactive' | 'stakes' | 'catalog'
export type GatewayReply =
  | { ok: true; data: unknown; fetchedAt: number; cached: boolean }
  | { ok: false; status: number; reason: string; retryAfterMs: number }

const BASE = 'https://api.deezer.com'
const PRIORITIES: DeezerPriority[] = ['interactive', 'interactive', 'stakes', 'interactive', 'catalog', 'stakes', 'interactive']

export function normalizeDeezerPath(path: string): string {
  if (!path.startsWith('/') || path.startsWith('//') || path.length > 2048) throw new Error('Invalid Deezer path')
  const url = new URL(path, BASE)
  if (url.origin !== BASE || url.hash || url.username || url.password ||
      !/^\/(?:genre|search(?:\/(?:track|artist|album))?|track\/(?:\d+|isrc:[A-Za-z0-9]+)|album\/\d+(?:\/tracks)?|artist\/\d+(?:\/(?:top|albums|related|radio))?|chart\/\d+(?:\/(?:tracks|albums|artists|playlists))?)$/.test(url.pathname)) {
    throw new Error('Invalid Deezer path')
  }
  for (const [key, value] of url.searchParams) {
    if (!['q', 'limit', 'index', 'order'].includes(key)) throw new Error('Invalid Deezer parameter')
    if (['limit', 'index'].includes(key) && (!/^\d+$/.test(value) || Number(value) > (key === 'limit' ? 300 : 1_000_000))) {
      throw new Error('Invalid Deezer pagination')
    }
  }
  url.searchParams.sort()
  return url.pathname + url.search
}

interface Work {
  path: string
  priority: DeezerPriority
  deadline: number
  promise: Promise<GatewayReply>
  resolve: (r: GatewayReply) => void
}
interface Options {
  intervalMs?: number
  concurrency?: number
  maxPending?: number
  timeoutMs?: number
  backoffMs?: number
  maxBackoffMs?: number
  initialPause?: { until: number; waves: number }
  savePause?: (state: { until: number; waves: number }) => void
  fetch?: typeof fetch
}

/** One instance in one loopback-only process is the shared outbound authority. */
export class DeezerGateway {
  private queue: Work[] = []
  private pending = new Map<string, Work>()
  private cache = new Map<string, { data: unknown; fetchedAt: number; bytes: number }>()
  private cacheBytes = 0
  private active = 0
  private nextStart = 0
  private pausedUntil = 0
  private waves = 0
  private lastBlock = 0
  private cursor = 0
  private timer?: ReturnType<typeof setTimeout>
  private readonly intervalMs: number
  private readonly concurrency: number
  private readonly fetcher: typeof fetch
  readonly stats = { upstream: 0, cacheHits: 0, joined: 0, blockedWaves: 0, failures: 0,
    byPriority: { interactive: 0, stakes: 0, catalog: 0 } }

  constructor(private options: Options = {}) {
    this.intervalMs = options.intervalMs ?? 334
    this.concurrency = options.concurrency ?? 4
    this.fetcher = options.fetch ?? ((...args) => fetch(...args))
    this.pausedUntil = options.initialPause?.until ?? 0
    this.waves = options.initialPause?.waves ?? 0
  }

  snapshot() {
    return { ...this.stats, byPriority: { ...this.stats.byPriority }, active: this.active,
      queued: this.queue.length, pausedUntil: this.pausedUntil, cacheEntries: this.cache.size,
      intervalMs: this.intervalMs }
  }

  request(rawPath: string, priority: DeezerPriority, maxAgeMs = 300_000, waitMs = 10_000): Promise<GatewayReply> {
    const path = normalizeDeezerPath(rawPath)
    const now = Date.now()
    const cached = this.cache.get(path)
    const ageLimit = /^\/(track|search)(\/|\?)/.test(path) ? 900_000 : 86_400_000
    if (cached && maxAgeMs > 0 && now - cached.fetchedAt < Math.min(maxAgeMs, ageLimit)) {
      this.stats.cacheHits++
      return Promise.resolve({ ok: true, data: cached.data, fetchedAt: cached.fetchedAt, cached: true })
    }
    if (now < this.pausedUntil) return Promise.resolve(this.blocked())
    const existing = this.pending.get(path)
    if (existing) {
      this.stats.joined++
      // An interactive read must not remain behind the catalog because it
      // happened to join the same resource after the job queued it.
      if (priority === 'interactive' || (priority === 'stakes' && existing.priority === 'catalog')) existing.priority = priority
      return this.wait(existing.promise, waitMs)
    }
    if (this.pending.size >= (this.options.maxPending ?? 1000)) {
      return Promise.resolve({ ok: false, status: 503, reason: 'busy', retryAfterMs: 1000 })
    }
    let resolve!: Work['resolve']
    const promise = new Promise<GatewayReply>((r) => { resolve = r })
    const work: Work = { path, priority, deadline: now + waitMs, promise, resolve }
    this.queue.push(work)
    this.pending.set(path, work)
    this.pump()
    return this.wait(promise, waitMs)
  }

  private wait(promise: Promise<GatewayReply>, waitMs: number): Promise<GatewayReply> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ ok: false, status: 503, reason: 'queue_timeout', retryAfterMs: 1000 }), waitMs)
      promise.then((r) => { clearTimeout(timer); resolve(r) })
    })
  }

  private blocked(): GatewayReply {
    return { ok: false, status: 429, reason: 'blocked', retryAfterMs: Math.max(1, this.pausedUntil - Date.now()) }
  }

  private finish(work: Work, reply: GatewayReply) {
    this.pending.delete(work.path)
    work.resolve(reply)
  }

  private pause(retryAfterMs = 0) {
    const now = Date.now()
    if (now < this.pausedUntil) return // concurrent failures belong to the same wave
    const duration = Math.max(retryAfterMs, Math.min(this.options.maxBackoffMs ?? 300_000,
      (this.options.backoffMs ?? 30_000) * 2 ** this.waves))
    this.pausedUntil = now + duration
    this.lastBlock = now
    this.waves++
    this.stats.blockedWaves++
    this.options.savePause?.({ until: this.pausedUntil, waves: this.waves })
    // No caller sits on an HTTP connection for a ten-minute block. Jobs retry
    // later via this same authority; interactive callers return immediately.
    for (const work of this.queue.splice(0)) this.finish(work, this.blocked())
  }

  private pump() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    const now = Date.now()
    this.queue = this.queue.filter((w) => {
      if (w.deadline > now) return true
      this.finish(w, { ok: false, status: 503, reason: 'queue_timeout', retryAfterMs: 1000 })
      return false
    })
    if (!this.queue.length || this.active >= this.concurrency) return
    // After a block only one probe may be in flight until it succeeds.
    if (this.waves && this.active > 0) return
    const delay = Math.max(this.nextStart, this.pausedUntil) - now
    if (delay > 0) { this.timer = setTimeout(() => this.pump(), delay); return }
    let index = -1
    for (let n = 0; n < PRIORITIES.length && index < 0; n++) {
      const priority = PRIORITIES[this.cursor++ % PRIORITIES.length]
      index = this.queue.findIndex((w) => w.priority === priority)
    }
    const work = this.queue.splice(index < 0 ? 0 : index, 1)[0]
    this.active++
    this.nextStart = now + this.intervalMs
    void this.execute(work, now).finally(() => { this.active--; this.pump() })
    this.pump()
  }

  private async execute(work: Work, startedAt: number) {
    this.stats.upstream++
    this.stats.byPriority[work.priority]++
    try {
      const response = await this.fetcher(BASE + work.path, { redirect: 'error',
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000) })
      if (response.status === 403 || response.status === 429) {
        const header = response.headers.get('retry-after')
        const seconds = Number(header)
        const retry = header ? (Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now()) : 0
        await response.body?.cancel()
        this.pause(Number.isFinite(retry) ? Math.min(Math.max(0, retry), 3_600_000) : 0)
        this.finish(work, this.blocked())
        return
      }
      if (!response.ok) {
        await response.body?.cancel()
        this.stats.failures++
        this.finish(work, { ok: false, status: response.status, reason: 'upstream', retryAfterMs: 1000 })
        return
      }
      const data = await response.json() as { error?: { code?: number } } | null
      if (data?.error?.code === 4) {
        this.pause()
        this.finish(work, this.blocked())
        return
      }
      if (data == null || typeof data !== 'object') throw new Error('Invalid JSON payload')
      // A success already in flight before a block cannot reopen the circuit.
      if (startedAt > this.lastBlock && Date.now() >= this.pausedUntil && this.waves) {
        this.waves = 0
        this.options.savePause?.({ until: 0, waves: 0 })
      }
      const fetchedAt = Date.now()
      if (!data.error) {
        const bytes = Buffer.byteLength(JSON.stringify(data))
        const old = this.cache.get(work.path)
        if (old) { this.cacheBytes -= old.bytes; this.cache.delete(work.path) }
        if (bytes <= 2_000_000) {
          this.cache.set(work.path, { data, fetchedAt, bytes })
          this.cacheBytes += bytes
        }
        while (this.cache.size > 2000 || this.cacheBytes > 32_000_000) {
          const key = this.cache.keys().next().value!
          this.cacheBytes -= this.cache.get(key)!.bytes
          this.cache.delete(key)
        }
      }
      this.finish(work, { ok: true, data, fetchedAt, cached: false })
    } catch {
      this.stats.failures++
      this.finish(work, { ok: false, status: 502, reason: 'network', retryAfterMs: 1000 })
    }
  }
}
