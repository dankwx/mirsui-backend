import Fastify, { type FastifyError } from 'fastify'
import type { User } from '@supabase/supabase-js'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'

import healthRoutes from './routes/health'
import authRoutes from './routes/auth'
import profileRoutes from './routes/profiles'
import feedRoutes from './routes/feed'
import claimRoutes from './routes/claims'
import trackRoutes from './routes/tracks'
import stakeRoutes from './routes/stakes'

export async function buildApp() {
  const app = Fastify({ logger: true })

  const isDev = process.env.NODE_ENV !== 'production'

  const allowedOrigins = new Set([
    'http://localhost:3000',
    'http://localhost:3001',
    'https://mirsui.com',
    'https://www.mirsui.com'
  ])
  if (process.env.FRONTEND_URL) {
    allowedOrigins.add(process.env.FRONTEND_URL)
  }

  // Em dev, o Expo web é servido em localhost/IP-da-LAN numa porta variável
  // (8081 no Metro, 19006 no webpack antigo). Liberamos qualquer origem local
  // para não precisar manter portas/IPs na allowlist. Em produção vale só a lista acima.
  const devOriginPattern =
    /^https?:\/\/(localhost|127\.0\.0\.1|10\.0\.2\.2|(\d{1,3}\.){3}\d{1,3})(:\d+)?$/

  await app.register(cors, {
    origin(origin, cb) {
      // Sem header Origin (app nativo, curl, server-to-server) → libera.
      if (!origin) return cb(null, true)
      if (allowedOrigins.has(origin)) return cb(null, true)
      if (isDev && devOriginPattern.test(origin)) return cb(null, true)
      cb(null, false)
    },
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
  await app.register(claimRoutes)
  await app.register(trackRoutes)
  await app.register(stakeRoutes)

  return app
}
