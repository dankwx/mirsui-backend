import type { FastifyInstance } from 'fastify'
import { supabase, Profile } from '../lib/supabase'
import { requireAuth } from '../plugins/auth'

// Campos que o próprio usuário pode editar — rating/points ficam de fora
const EDITABLE_FIELDS = ['username', 'description', 'display_name', 'avatar_url'] as const

export default async function profileRoutes(app: FastifyInstance) {
  // Listar todos os profiles
  app.get('/profiles', async (request, reply) => {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .order('rating', { ascending: false })

    if (error) {
      app.log.error({ err: error }, 'Erro ao buscar profiles')
      return reply.code(500).send({ error: error.message })
    }

    return reply.send({ profiles: data, count: data?.length || 0 })
  })

  // Buscar profile por ID
  app.get<{ Params: { id: string } }>('/profiles/:id', async (request, reply) => {
    const { id } = request.params

    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', id)
      .single()

    if (error) {
      app.log.warn({ profileId: id }, 'Profile não encontrado')
      return reply.code(404).send({ error: 'Profile não encontrado' })
    }

    return reply.send({ profile: data })
  })

  // Buscar profile por username
  app.get<{ Params: { username: string } }>('/profiles/username/:username', async (request, reply) => {
    const { username } = request.params

    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('username', username)
      .single()

    if (error) {
      app.log.warn({ username }, 'Profile não encontrado')
      return reply.code(404).send({ error: 'Profile não encontrado' })
    }

    return reply.send({ profile: data })
  })

  // Atualizar o próprio profile
  app.patch<{
    Params: { id: string }
    Body: Partial<Profile>
  }>('/profiles/:id', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params

    if (request.user.id !== id) {
      return reply.code(403).send({ error: 'Acesso negado' })
    }

    const updateData: Record<string, unknown> = {}
    for (const field of EDITABLE_FIELDS) {
      if (field in request.body) {
        updateData[field] = request.body[field]
      }
    }

    if (Object.keys(updateData).length === 0) {
      return reply.code(400).send({ error: 'Nenhum campo válido para atualizar' })
    }

    const { data, error } = await supabase
      .from('profiles')
      .update(updateData)
      .eq('id', id)
      .select()
      .single()

    if (error) {
      app.log.error({ err: error, userId: id }, 'Erro ao atualizar profile')
      return reply.code(500).send({ error: error.message })
    }

    app.log.info({ userId: id }, 'Profile atualizado com sucesso')
    return reply.send({ profile: data })
  })
}
