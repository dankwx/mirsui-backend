import Fastify from 'fastify'
import { supabase, Profile } from './supabase'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'

const fastify = Fastify({
  logger: true
})

// ==================== CONFIGURAÇÕES ====================

// Registrar CORS
await fastify.register(cors, {
  origin: [
    'http://localhost:3001', // Next.js dev
    'http://localhost:3000',
    process.env.FRONTEND_URL || 'http://localhost:3001'
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']
})

// Registrar Rate Limiting
await fastify.register(rateLimit, {
  max: 100, // 100 requisições
  timeWindow: '15 minutes' // por 15 minutos
})

// ==================== FUNÇÕES AUXILIARES ====================

function generateRandomDisplayName(): string {
  const adjectives = [
    'Happy', 'Lucky', 'Clever', 'Brave', 'Gentle', 
    'Kind', 'Swift', 'Calm', 'Wild', 'Bold',
    'Bright', 'Cool', 'Epic', 'Smooth', 'Fresh'
  ]
  const nouns = [
    'Tiger', 'Eagle', 'Dolphin', 'Panda', 'Lion', 
    'Wolf', 'Bear', 'Fox', 'Hawk', 'Shark',
    'Phoenix', 'Dragon', 'Falcon', 'Raven', 'Viper'
  ]
  const randomAdjective = adjectives[Math.floor(Math.random() * adjectives.length)]
  const randomNoun = nouns[Math.floor(Math.random() * nouns.length)]
  const randomNumber = Math.floor(Math.random() * 10000)
  return `${randomAdjective}${randomNoun}${randomNumber}`
}

// ==================== ROTAS DE AUTENTICAÇÃO ====================

// Rota para criar nova conta (signup)
fastify.post<{
  Body: { email: string; password: string; username: string }
}>('/auth/signup', {
  config: {
    rateLimit: {
      max: 5,
      timeWindow: '1 hour'
    }
  }
}, async (request, reply) => {
  try {
    const { email, password, username } = request.body

    // Validações básicas
    if (!email || !password || !username) {
      return reply.code(400).send({ 
        error: 'Email, senha e username são obrigatórios' 
      })
    }

    if (password.length < 6) {
      return reply.code(400).send({ 
        error: 'A senha deve ter no mínimo 6 caracteres' 
      })
    }

    if (username.length < 3) {
      return reply.code(400).send({ 
        error: 'Username deve ter no mínimo 3 caracteres' 
      })
    }

    // Validar formato do username (apenas letras, números e _)
    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
      return reply.code(400).send({ 
        error: 'Username pode conter apenas letras, números e underscore' 
      })
    }

    // Verificar se o username já existe (usar maybeSingle ao invés de single)
    const { data: existingUsername, error: checkError } = await supabase
      .from('profiles')
      .select('username')
      .eq('username', username)
      .maybeSingle()

    // maybeSingle() não lança erro se não encontrar, apenas retorna null
    if (existingUsername) {
      fastify.log.warn({ username }, 'Tentativa de cadastro com username já existente')
      return reply.code(400).send({ 
        error: 'Username já está em uso' 
      })
    }

    // Verificar se o email já existe no Auth (evitar criar usuário duplicado)
    const { data: existingAuthUser, error: authCheckError } = await supabase.auth.admin.listUsers()
    
    if (existingAuthUser?.users) {
      const emailExists = existingAuthUser.users.some(user => user.email === email)
      if (emailExists) {
        fastify.log.warn({ email }, 'Tentativa de cadastro com email já existente')
        return reply.code(400).send({ 
          error: 'Este email já está cadastrado' 
        })
      }
    }

    // Gerar display name aleatório
    const displayName = generateRandomDisplayName()

    // URL padrão para o avatar
    const defaultAvatarUrl = 'https://tqprioqqitimssshcrcr.supabase.co/storage/v1/object/public/user-profile-images/default.jpg'

    // Criar usuário no Supabase Auth
    // O profile será criado automaticamente via trigger no Supabase
    const { data: authData, error: authError } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          username: username,
          display_name: displayName,
          avatar_url: defaultAvatarUrl
        }
      }
    })

    if (authError) {
      if (authError.message.includes('already registered')) {
        return reply.code(400).send({ 
          error: 'Este email já está cadastrado' 
        })
      }
      return reply.code(400).send({ 
        error: authError.message 
      })
    }

    fastify.log.info({ 
      userId: authData.user?.id, 
      username, 
      displayName 
    }, 'Usuário criado no Auth - Profile será criado via trigger')

    return reply.code(201).send({
      message: 'Conta criada com sucesso! Verifique seu email para confirmar.',
      user: authData.user,
      session: authData.session
    })

  } catch (err: any) {
    fastify.log.error(err)
    return reply.code(500).send({ 
      error: 'Erro ao criar conta. Tente novamente.' 
    })
  }
})

// Rota para fazer login
fastify.post<{
  Body: { email: string; password: string }
}>('/auth/login', {
  config: {
    rateLimit: {
      max: 5,
      timeWindow: '1 minute'
    }
  }
}, async (request, reply) => {
  try {
    const { email, password } = request.body

    if (!email || !password) {
      return reply.code(400).send({ 
        error: 'Email e senha são obrigatórios' 
      })
    }

    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password
    })

    if (error) {
      fastify.log.warn({ email }, 'Tentativa de login falhou')
      return reply.code(401).send({ 
        error: 'Email ou senha inválidos' 
      })
    }

    fastify.log.info({ userId: data.user.id }, 'Login realizado com sucesso')

    return reply.send({
      message: 'Login realizado com sucesso',
      user: data.user,
      session: data.session
    })

  } catch (err: any) {
    fastify.log.error(err)
    return reply.code(500).send({ 
      error: 'Erro ao fazer login. Tente novamente.' 
    })
  }
})

// Rota para enviar email de recuperação de senha
fastify.post<{
  Body: { email: string; redirectUrl?: string }
}>('/auth/reset-password', {
  config: {
    rateLimit: {
      max: 3,
      timeWindow: '1 hour'
    }
  }
}, async (request, reply) => {
  try {
    const { email, redirectUrl } = request.body

    if (!email) {
      return reply.code(400).send({ 
        error: 'Email é obrigatório' 
      })
    }

    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: redirectUrl || `${process.env.FRONTEND_URL}/reset-password`
    })

    if (error) {
      fastify.log.error({ err: error, email }, 'Erro ao enviar email de recuperação')
      return reply.code(400).send({ 
        error: error.message 
      })
    }

    fastify.log.info({ email }, 'Email de recuperação enviado')

    // Sempre retorna sucesso por segurança (não revelar se email existe)
    return reply.send({
      message: 'Se o email estiver cadastrado, você receberá um link de recuperação.'
    })

  } catch (err: any) {
    fastify.log.error(err)
    return reply.code(500).send({ 
      error: 'Erro ao enviar email de recuperação.' 
    })
  }
})

// Rota para fazer logout
fastify.post('/auth/logout', async (request, reply) => {
  try {
    // Pegar token do header Authorization
    const authHeader = request.headers.authorization
    
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring(7)
      
      // Fazer logout no Supabase
      const { error } = await supabase.auth.admin.signOut(token)

      if (error) {
        fastify.log.error({ err: error }, 'Erro ao fazer logout no Supabase')
        // Mesmo com erro, retorna sucesso para o cliente
      } else {
        fastify.log.info('Logout realizado com sucesso')
      }
    }

    return reply.send({
      message: 'Logout realizado com sucesso'
    })

  } catch (err: any) {
    fastify.log.error(err)
    return reply.code(500).send({ 
      error: 'Erro ao fazer logout.' 
    })
  }
})

// Rota para renovar token (refresh)
fastify.post<{
  Body: { refresh_token: string }
}>('/auth/refresh', async (request, reply) => {
  try {
    const { refresh_token } = request.body

    if (!refresh_token) {
      return reply.code(400).send({ 
        error: 'Refresh token é obrigatório' 
      })
    }

    const { data, error } = await supabase.auth.refreshSession({
      refresh_token
    })

    if (error) {
      fastify.log.warn('Tentativa de refresh com token inválido')
      return reply.code(401).send({ 
        error: 'Refresh token inválido ou expirado' 
      })
    }

    fastify.log.info({ userId: data.user?.id }, 'Token renovado com sucesso')

    return reply.send({
      message: 'Token renovado com sucesso',
      session: data.session,
      user: data.user
    })
  } catch (err: any) {
    fastify.log.error(err)
    return reply.code(500).send({ 
      error: 'Erro ao renovar sessão.' 
    })
  }
})

// Rota para verificar usuário logado (me)
fastify.get('/auth/me', async (request, reply) => {
  try {
    const authHeader = request.headers.authorization
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.code(401).send({ 
        error: 'Token não fornecido' 
      })
    }

    const token = authHeader.substring(7)

    const { data: { user }, error } = await supabase.auth.getUser(token)

    if (error || !user) {
      return reply.code(401).send({ 
        error: 'Token inválido ou expirado' 
      })
    }

    // Buscar dados completos do profile
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .single()

    if (profileError) {
      fastify.log.error({ err: profileError, userId: user.id }, 'Erro ao buscar profile')
    }

    return reply.send({
      user,
      profile: profile || null
    })
  } catch (err: any) {
    fastify.log.error(err)
    return reply.code(500).send({ 
      error: 'Erro ao verificar usuário.' 
    })
  }
})

// ==================== ROTAS DE PERFIS ====================

// Rota inicial / Health check
fastify.get('/', async (request, reply) => {
  reply.send({ 
    status: 'ok',
    message: 'API do Mirsui funcionando!',
    timestamp: new Date().toISOString()
  })
})

// Health check endpoint
fastify.get('/health', async (request, reply) => {
  reply.send({ 
    status: 'ok', 
    timestamp: new Date().toISOString() 
  })
})

// Rota para buscar todos os profiles
fastify.get('/profiles', async (request, reply) => {
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .order('rating', { ascending: false })
    
    if (error) {
      fastify.log.error({ err: error }, 'Erro ao buscar profiles')
      reply.code(500).send({ error: error.message })
      return
    }
    
    reply.send({ profiles: data, count: data?.length || 0 })
  } catch (err) {
    fastify.log.error(err)
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
      fastify.log.warn({ profileId: id }, 'Profile não encontrado')
      reply.code(404).send({ error: 'Profile não encontrado' })
      return
    }
    
    reply.send({ profile: data })
  } catch (err) {
    fastify.log.error(err)
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
      fastify.log.warn({ username }, 'Profile não encontrado')
      reply.code(404).send({ error: 'Profile não encontrado' })
      return
    }
    
    reply.send({ profile: data })
  } catch (err) {
    fastify.log.error(err)
    reply.code(500).send({ error: 'Erro ao buscar profile' })
  }
})

// Rota para atualizar profile
fastify.patch<{ 
  Params: { id: string },
  Body: Partial<Profile>
}>('/profiles/:id', async (request, reply) => {
  try {
    const { id } = request.params
    const updateData = request.body

    // Verificar autenticação
    const authHeader = request.headers.authorization
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'Não autorizado' })
    }

    const token = authHeader.substring(7)
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)

    if (authError || !user || user.id !== id) {
      return reply.code(403).send({ error: 'Acesso negado' })
    }

    // Não permitir atualizar certos campos
    const { id: _, ...allowedData } = updateData as any

    const { data, error } = await supabase
      .from('profiles')
      .update(allowedData)
      .eq('id', id)
      .select()
      .single()
    
    if (error) {
      fastify.log.error({ err: error, userId: id }, 'Erro ao atualizar profile')
      reply.code(500).send({ error: error.message })
      return
    }
    
    fastify.log.info({ userId: id }, 'Profile atualizado com sucesso')
    reply.send({ profile: data })
  } catch (err) {
    fastify.log.error(err)
    reply.code(500).send({ error: 'Erro ao atualizar profile' })
  }
})

// ==================== INICIAR SERVIDOR ====================

const start = async () => {
  try {
    await fastify.listen({ port: 3000, host: '0.0.0.0' })
    console.log('🚀 Backend Mirsui rodando em http://localhost:3000')
    console.log('📋 Rotas disponíveis:')
    console.log('   GET  /              - Health check')
    console.log('   GET  /health        - Health check detalhado')
    console.log('   POST /auth/signup   - Criar conta')
    console.log('   POST /auth/login    - Fazer login')
    console.log('   POST /auth/logout   - Fazer logout')
    console.log('   POST /auth/refresh  - Renovar token')
    console.log('   POST /auth/reset-password - Recuperar senha')
    console.log('   GET  /auth/me       - Verificar usuário logado')
    console.log('   GET  /profiles      - Listar profiles')
    console.log('   GET  /profiles/:id  - Buscar profile por ID')
    console.log('   GET  /profiles/username/:username - Buscar por username')
    console.log('   PATCH /profiles/:id - Atualizar profile')
  } catch (err) {
    fastify.log.error(err)
    process.exit(1)
  }
}

start()
