import type { FastifyInstance } from 'fastify'

export default async function healthRoutes(app: FastifyInstance) {
  app.get('/', async (request, reply) => {
    return reply.send({
      status: 'ok',
      message: 'API do Mirsui funcionando!',
      timestamp: new Date().toISOString()
    })
  })

  app.get('/health', async (request, reply) => {
    return reply.send({
      status: 'ok',
      timestamp: new Date().toISOString()
    })
  })
}
