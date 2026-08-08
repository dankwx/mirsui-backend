import { createHash } from 'node:crypto'
import type { FastifyRequest } from 'fastify'

// Chaves do rate limit.
//
// Por que não dá pra usar o IP: o frontend Next chama este backend sempre do
// servidor — server components (app/(dashboard)/stakes/get-stakes.ts) e route
// handlers (app/api/**/route.ts). Nenhuma chamada sai do browser direto pra cá.
// Então `request.ip` é sempre o mesmo endereço e o limite global vira um balde
// único pra base inteira: 100 req / 15 min pro app todo, não por pessoa.
//
// A chave passa a ser a identidade de quem pediu.

function digest(value: string): string {
  // 24 chars de sha256 bastam pra não colidir e mantêm a chave curta no store.
  // O hash também evita guardar email/token em texto puro na memória do store.
  return createHash('sha256').update(value).digest('base64url').slice(0, 24)
}

/**
 * Lê o `sub` (id do usuário) do JWT do Supabase SEM verificar a assinatura.
 *
 * Isso é de propósito: a verificação de verdade é o `requireAuth`
 * (src/plugins/auth.ts), que roda depois e rejeita token inválido. Aqui o valor
 * serve só pra separar baldes, e usar o `sub` em vez do token cru importa
 * porque o access token do Supabase rotaciona a cada ~1h — hashear o token
 * daria um balde novo a cada refresh e zeraria o limite sozinho.
 */
function subjectFromJwt(token: string): string | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    const payload: unknown = JSON.parse(
      Buffer.from(parts[1], 'base64url').toString('utf8')
    )
    const sub = (payload as { sub?: unknown } | null)?.sub
    return typeof sub === 'string' && sub.length > 0 ? sub : null
  } catch {
    return null
  }
}

/**
 * Chave padrão (rotas autenticadas e de auth opcional): o usuário do token.
 * Cai no IP só quando não há token — tráfego anônimo, que continua num balde
 * compartilhado porque não há nada melhor pra chavear sem o frontend repassar
 * o IP real do visitante.
 */
export function identityKey(request: FastifyRequest): string {
  const header = request.headers.authorization
  if (header?.startsWith('Bearer ')) {
    const token = header.slice(7).trim()
    if (token) {
      const sub = subjectFromJwt(token)
      return sub ? `user:${sub}` : `token:${digest(token)}`
    }
  }
  return `ip:${request.ip}`
}

/**
 * Chave das rotas de auth (signup / login / reset-password): o email do corpo.
 *
 * Essas rotas não têm header Authorization, então a identityKey cairia no IP
 * compartilhado e 5 logins errados de uma pessoa trancariam o login de todo
 * mundo. Chaveando por email, o limite volta a valer por conta.
 *
 * Exige `hook: 'preValidation'` na config da rota: o hook padrão do plugin é
 * `onRequest`, que roda antes do parsing do corpo, e ali `request.body` ainda
 * é undefined. Em `preValidation` o corpo já está parseado — mas ainda não
 * validado, então tudo aqui é defensivo.
 */
export function emailKey(request: FastifyRequest): string {
  const body = request.body as { email?: unknown } | undefined
  const email =
    typeof body?.email === 'string' ? body.email.trim().toLowerCase() : ''
  return email ? `email:${digest(email)}` : `ip:${request.ip}`
}
