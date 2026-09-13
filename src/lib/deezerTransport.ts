import type { DeezerPriority, GatewayReply } from './deezerGateway'

/** No direct-API fallback: an unavailable broker must never bypass the quota. */
export async function deezerRequest(path: string, priority: DeezerPriority, maxAgeMs = priority === 'interactive' ? 300_000 : 0): Promise<GatewayReply> {
  const token = process.env.DEEZER_GATEWAY_TOKEN
  if (!token) return { ok: false, status: 503, reason: 'not_configured', retryAfterMs: 1000 }
  const waitMs = priority === 'interactive' ? 8000 : 120_000
  try {
    const response = await fetch(`${process.env.DEEZER_GATEWAY_URL || 'http://127.0.0.1:3012'}/request`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ path, priority, maxAgeMs, waitMs }),
      signal: AbortSignal.timeout(waitMs + 2000),
    })
    if (!response.ok) return { ok: false, status: response.status, reason: 'gateway_http', retryAfterMs: 1000 }
    return await response.json() as GatewayReply
  } catch {
    return { ok: false, status: 503, reason: 'gateway_unavailable', retryAfterMs: 1000 }
  }
}
