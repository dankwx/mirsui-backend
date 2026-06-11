import Fastify, { type FastifyError } from 'fastify'
import type { User } from '@supabase/supabase-js'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'

import healthRoutes from './routes/health'
import authRoutes from './routes/auth'
import profileRoutes from './routes/profiles'
import feedRoutes from './routes/feed'
import trackRoutes from './routes/tracks'
import claimRoutes from './routes/claims'
import userRoutes from './routes/user'

export async function buildApp() {
  const app = Fastify({ logger: true })

  const allowedOrigins = new Set([
    'http://localhost:3000',
    'http://localhost:3001',
    'https://mirsui.com',
    'https://www.mirsui.com'
  ])
  if (process.env.FRONTEND_URL) {
    allowedOrigins.add(process.env.FRONTEND_URL)
  }

  await app.register(cors, {
    origin: Array.from(allowedOrigins),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
  })

  await app.register(rateLimit, {
    max: 100,
    timeWindow: '15 minutes'
  })

  // request.user e request.accessToken são populados pelo preHandler requireAuth (src/plugins/auth.ts)
  app.decorateRequest('user', null as unknown as User)
  app.decorateRequest('accessToken', '')

  // Tratamento centralizado de erros inesperados — substitui os try/catch por rota
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error.statusCode && error.statusCode < 500) {
      // Erros do próprio Fastify (validação, rate limit, payload inválido)
      return reply.code(error.statusCode).send({ error: error.message })
    }
    app.log.error({ err: error, url: request.url }, 'Erro não tratado')
    return reply.code(500).send({ error: 'Erro interno do servidor' })
  })

  await app.register(healthRoutes)
  await app.register(authRoutes)
  await app.register(profileRoutes)
  await app.register(feedRoutes)
  await app.register(trackRoutes)
  await app.register(claimRoutes)
  await app.register(userRoutes)

  return app
}
