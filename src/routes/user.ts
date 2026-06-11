import type { FastifyInstance } from 'fastify'
import { supabase } from '../lib/supabase'
import { requireAuth } from '../plugins/auth'

export default async function userRoutes(app: FastifyInstance) {
  // Pontos do usuário logado
  app.get('/user/points', { preHandler: requireAuth }, async (request, reply) => {
    const { data: points, error } = await supabase
      .rpc('get_user_points', { user_uuid: request.user.id })

    if (error) {
      app.log.error({ err: error, userId: request.user.id }, 'Erro ao buscar pontos')
      return reply.code(500).send({ error: 'Erro ao buscar pontos do usuário' })
    }

    return reply.send({
      points: points || 0,
      userId: request.user.id
    })
  })
}
