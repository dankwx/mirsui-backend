import type { FastifyReply, FastifyRequest } from 'fastify'
import type { User } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'

declare module 'fastify' {
  interface FastifyRequest {
    user: User
    accessToken: string
  }
}

export function extractToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization
  if (!header || !header.startsWith('Bearer ')) return null
  return header.slice(7)
}

// Retorna o usuário autenticado ou null, sem rejeitar a requisição
// (para rotas onde a autenticação é opcional)
export async function getOptionalUser(request: FastifyRequest): Promise<User | null> {
  const token = extractToken(request)
  if (!token) return null

  const { data: { user }, error } = await supabase.auth.getUser(token)
  return error ? null : user
}

// preHandler para rotas protegidas: valida o token Bearer e popula request.user
export async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  const token = extractToken(request)
  if (!token) {
    return reply.code(401).send({ error: 'Token não fornecido' })
  }

  const { data: { user }, error } = await supabase.auth.getUser(token)
  if (error || !user) {
    return reply.code(401).send({ error: 'Usuário não autenticado' })
  }

  request.user = user
  request.accessToken = token
}
