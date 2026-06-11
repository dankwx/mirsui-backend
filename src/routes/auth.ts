import type { FastifyInstance } from 'fastify'
import { supabase } from '../lib/supabase'
import { extractToken, getOptionalUser } from '../plugins/auth'

const DEFAULT_AVATAR_URL =
  'https://tqprioqqitimssshcrcr.supabase.co/storage/v1/object/public/user-profile-images/default.jpg'

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
  const adjective = adjectives[Math.floor(Math.random() * adjectives.length)]
  const noun = nouns[Math.floor(Math.random() * nouns.length)]
  const number = Math.floor(Math.random() * 10000)
  return `${adjective}${noun}${number}`
}

export default async function authRoutes(app: FastifyInstance) {
  // Criar nova conta
  app.post<{
    Body: { email: string; password: string; username: string }
  }>('/auth/signup', {
    config: {
      rateLimit: { max: 5, timeWindow: '1 hour' }
    }
  }, async (request, reply) => {
    const { email, password, username } = request.body ?? {}

    if (!email || !password || !username) {
      return reply.code(400).send({ error: 'Email, senha e username são obrigatórios' })
    }

    if (password.length < 6) {
      return reply.code(400).send({ error: 'A senha deve ter no mínimo 6 caracteres' })
    }

    if (username.length < 3) {
      return reply.code(400).send({ error: 'Username deve ter no mínimo 3 caracteres' })
    }

    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
      return reply.code(400).send({ error: 'Username pode conter apenas letras, números e underscore' })
    }

    // Verificar se username ou email já existem (uma única query na tabela profiles)
    const { data: existingProfile } = await supabase
      .from('profiles')
      .select('username, email')
      .or(`username.eq.${username},email.eq.${email}`)
      .maybeSingle()

    if (existingProfile) {
      if (existingProfile.username === username) {
        app.log.warn({ username }, 'Tentativa de cadastro com username já existente')
        return reply.code(400).send({ error: 'Username já está em uso' })
      }
      app.log.warn({ email }, 'Tentativa de cadastro com email já existente')
      return reply.code(400).send({ error: 'Este email já está cadastrado' })
    }

    // O profile será criado automaticamente via trigger no Supabase
    const { data: authData, error: authError } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          username,
          display_name: generateRandomDisplayName(),
          avatar_url: DEFAULT_AVATAR_URL
        }
      }
    })

    if (authError) {
      if (authError.message.includes('already registered')) {
        return reply.code(400).send({ error: 'Este email já está cadastrado' })
      }
      return reply.code(400).send({ error: authError.message })
    }

    app.log.info({ userId: authData.user?.id, username }, 'Usuário criado no Auth')

    return reply.code(201).send({
      message: 'Conta criada com sucesso! Verifique seu email para confirmar.',
      user: authData.user,
      session: authData.session
    })
  })

  // Login
  app.post<{
    Body: { email: string; password: string }
  }>('/auth/login', {
    config: {
      rateLimit: { max: 5, timeWindow: '1 minute' }
    }
  }, async (request, reply) => {
    const { email, password } = request.body ?? {}

    if (!email || !password) {
      return reply.code(400).send({ error: 'Email e senha são obrigatórios' })
    }

    const { data, error } = await supabase.auth.signInWithPassword({ email, password })

    if (error) {
      app.log.warn({ email }, 'Tentativa de login falhou')
      return reply.code(401).send({ error: 'Email ou senha inválidos' })
    }

    app.log.info({ userId: data.user.id }, 'Login realizado com sucesso')

    return reply.send({
      message: 'Login realizado com sucesso',
      user: data.user,
      session: data.session
    })
  })

  // Enviar email de recuperação de senha
  app.post<{
    Body: { email: string; redirectUrl?: string }
  }>('/auth/reset-password', {
    config: {
      rateLimit: { max: 3, timeWindow: '1 hour' }
    }
  }, async (request, reply) => {
    const { email, redirectUrl } = request.body ?? {}

    if (!email) {
      return reply.code(400).send({ error: 'Email é obrigatório' })
    }

    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: redirectUrl || `${process.env.FRONTEND_URL}/reset-password`
    })

    if (error) {
      app.log.error({ err: error }, 'Erro ao enviar email de recuperação')
    } else {
      app.log.info('Email de recuperação enviado')
    }

    // Sempre retorna sucesso para não revelar se o email existe
    return reply.send({
      message: 'Se o email estiver cadastrado, você receberá um link de recuperação.'
    })
  })

  // Logout
  app.post('/auth/logout', async (request, reply) => {
    const token = extractToken(request)

    if (token) {
      // auth.admin.signOut exige a service_role key; com a anon key usamos
      // o endpoint de logout do GoTrue autenticado com o token do próprio usuário
      const response = await fetch(`${process.env.SUPABASE_URL}/auth/v1/logout`, {
        method: 'POST',
        headers: {
          apikey: process.env.SUPABASE_KEY as string,
          Authorization: `Bearer ${token}`
        }
      })

      if (!response.ok) {
        // Mesmo com erro, retorna sucesso para o cliente
        app.log.error({ status: response.status }, 'Erro ao fazer logout no Supabase')
      } else {
        app.log.info('Logout realizado com sucesso')
      }
    }

    return reply.send({ message: 'Logout realizado com sucesso' })
  })

  // Renovar sessão
  app.post<{
    Body: { refresh_token: string }
  }>('/auth/refresh', async (request, reply) => {
    const { refresh_token } = request.body ?? {}

    if (!refresh_token) {
      return reply.code(400).send({ error: 'Refresh token é obrigatório' })
    }

    const { data, error } = await supabase.auth.refreshSession({ refresh_token })

    if (error) {
      app.log.warn('Tentativa de refresh com token inválido')
      return reply.code(401).send({ error: 'Refresh token inválido ou expirado' })
    }

    return reply.send({
      message: 'Token renovado com sucesso',
      session: data.session,
      user: data.user
    })
  })

  // Verificar se o token é válido (usado pelo middleware do frontend)
  app.get('/auth/verify', async (request, reply) => {
    if (!extractToken(request)) {
      return reply.code(401).send({ authenticated: false, error: 'Token não fornecido' })
    }

    const user = await getOptionalUser(request)
    if (!user) {
      return reply.code(401).send({ authenticated: false, error: 'Token inválido ou expirado' })
    }

    return reply.send({
      authenticated: true,
      userId: user.id,
      email: user.email
    })
  })

  // Dados do usuário logado + profile
  app.get('/auth/me', async (request, reply) => {
    if (!extractToken(request)) {
      return reply.code(401).send({ error: 'Token não fornecido' })
    }

    const user = await getOptionalUser(request)
    if (!user) {
      return reply.code(401).send({ error: 'Token inválido ou expirado' })
    }

    // email não vem da tabela profiles (coluna restrita) — já está em user.email
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('id, username, description, display_name, avatar_url, rating, points, prophet_points')
      .eq('id', user.id)
      .single()

    if (profileError) {
      app.log.error({ err: profileError, userId: user.id }, 'Erro ao buscar profile')
    }

    return reply.send({ user, profile: profile || null })
  })
}
