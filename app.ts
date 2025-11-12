import Fastify from 'fastify'
import { supabase, Profile } from './supabase'
import cors from '@fastify/cors'

const fastify = Fastify({
  logger: true
})


// Rota inicial
fastify.get('/', async (request, reply) => {
  reply.send({ hello: 'world', message: 'API do Mirsui funcionando!' })
})

// Rota para buscar todos os profiles
fastify.get('/profiles', async (request, reply) => {
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
    
    if (error) {
      reply.code(500).send({ error: error.message })
      return
    }
    
    reply.send({ profiles: data, count: data?.length || 0 })
  } catch (err) {
    reply.code(500).send({ error: 'Erro ao buscar profiles' })
  }
})

// Rota para buscar um profile por ID
fastify.get<{ Params: { id: string } }>('/profiles/:id', async (request, reply) => {
  try {
    const { id } = request.params
    
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', id)
      .single()
    
    if (error) {
      reply.code(404).send({ error: 'Profile não encontrado' })
      return
    }
    
    reply.send({ profile: data })
  } catch (err) {
    reply.code(500).send({ error: 'Erro ao buscar profile' })
  }
})

// Rota para buscar um profile por username
fastify.get<{ Params: { username: string } }>('/profiles/username/:username', async (request, reply) => {
  try {
    const { username } = request.params
    
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('username', username)
      .single()
    
    if (error) {
      reply.code(404).send({ error: 'Profile não encontrado' })
      return
    }
    
    reply.send({ profile: data })
  } catch (err) {
    reply.code(500).send({ error: 'Erro ao buscar profile' })
  }
})

// Inicia o servidor
fastify.listen({ port: 3000 }, function (err, address) {
  if (err) {
    fastify.log.error(err)
    process.exit(1)
  }
  console.log(`🚀 Servidor rodando em ${address}`)
})
