import type { FastifyInstance } from 'fastify'
import { supabase } from '../lib/supabase'
import { extractToken, getOptionalUser } from '../plugins/auth'
import { emailKey } from '../lib/rateLimitKeys'

// Sem header Authorization, a chave padrão (identityKey) cairia no IP — que é
// sempre o do servidor Next. Chaveando por email, o limite volta a valer por
// conta em vez de trancar todo mundo junto. `hook: 'preValidation'` é
// obrigatório: o hook padrão do plugin roda antes do parsing do corpo.
// Ver src/lib/rateLimitKeys.ts.
const perEmail = { hook: 'preValidation' as const, keyGenerator: emailKey }

// Formato mínimo de email — quem valida de verdade é o GoTrue. Aqui é só pra
// não deixar string arbitrária entrar em log nem virar trabalho à toa.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MAX_EMAIL_LENGTH = 254
const MIN_USERNAME_LENGTH = 3
const MAX_USERNAME_LENGTH = 30

// Conta nova e email já cadastrado respondem exatamente isto. Ver o
// tratamento do authError no signup.
const SIGNUP_OK = 'Conta criada com sucesso! Verifique seu email para confirmar.'

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
      rateLimit: { max: 5, timeWindow: '1 hour', ...perEmail }
    }
  }, async (request, reply) => {
    // A rota não tem schema de validação: o corpo é o que o cliente mandar.
    const raw = (request.body ?? {}) as Partial<Record<'email' | 'password' | 'username', unknown>>
    const email = typeof raw.email === 'string' ? raw.email.trim().toLowerCase() : ''
    const password = typeof raw.password === 'string' ? raw.password : ''
    const username = typeof raw.username === 'string' ? raw.username.trim() : ''

    if (!email || !password || !username) {
      return reply.code(400).send({ error: 'Email, senha e username são obrigatórios' })
    }

    if (email.length > MAX_EMAIL_LENGTH || !EMAIL_RE.test(email)) {
      return reply.code(400).send({ error: 'Email inválido' })
    }

    if (password.length < 6) {
      return reply.code(400).send({ error: 'A senha deve ter no mínimo 6 caracteres' })
    }

    if (username.length < MIN_USERNAME_LENGTH || username.length > MAX_USERNAME_LENGTH) {
      return reply
        .code(400)
        .send({ error: `Username deve ter entre ${MIN_USERNAME_LENGTH} e ${MAX_USERNAME_LENGTH} caracteres` })
    }

    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
      return reply.code(400).send({ error: 'Username pode conter apenas letras, números e underscore' })
    }

    // Só o username é checado aqui, e com .eq(): o valor vai como parâmetro
    // codificado, não concatenado numa string de filtro. O .or() de antes
    // montava `username.eq.${username},email.eq.${email}` na mão — e o email
    // não passava por validação nenhuma, então dava pra fechar a condição e
    // injetar operadores do PostgREST no filtro.
    //
    // O email saiu do pré-check de propósito. Além de o `anon` não ter select
    // na coluna (a migration de RLS revogou, então a query inteira falhava com
    // permission denied e o check nunca rodou de verdade), duas mensagens
    // distintas — "username em uso" vs "email já cadastrado" — fazem do signup
    // um oráculo pra descobrir quem tem conta aqui. Username já é público em
    // /profiles; email não é, e não pode virar.
    const { data: usernameEmUso, error: lookupError } = await supabase
      .from('profiles')
      .select('id')
      .eq('username', username)
      .maybeSingle()

    if (lookupError) {
      // Sem resposta do banco não dá pra afirmar nada; a UNIQUE de
      // profiles.username continua sendo a garantia real (tratada abaixo).
      app.log.error({ err: lookupError }, 'Erro ao checar username no signup')
    } else if (usernameEmUso) {
      app.log.warn({ username }, 'Tentativa de cadastro com username já existente')
      return reply.code(400).send({ error: 'Username já está em uso' })
    }

    // O profile será criado automaticamente via trigger no Supabase
    const { data: authData, error: authError } = await supabase.auth.signUp({
      email,
      password,
      options: {
        // Sem `avatar_url`: o trigger faz `raw_user_meta_data ->> 'avatar_url'`,
        // que vira NULL quando a chave não existe, e NULL é o que liga o
        // fallback de inicial no frontend (components/FotoDePerfil.tsx).
        //
        // Aqui morava uma URL fixa para `user-profile-images/default.jpg` no
        // projeto da nuvem. Esse projeto está restrito por cota desde a
        // migração e responde 402 em TODA leitura, então cada conta criada por
        // email nascia apontando para uma imagem morta — e a home, que é
        // renderizada no servidor, mandava essa URL no HTML. O cadastro por
        // Google já entrava sem estes campos e sempre funcionou; é esse o
        // caminho que o de email passa a seguir.
        //
        // Um JPG genérico hospedado não volta nem quando os bytes forem
        // resgatados: a inicial desenhada é o fallback do produto, e ela não
        // depende de rede nenhuma.
        data: {
          username,
          display_name: generateRandomDisplayName()
        }
      }
    })

    if (authError) {
      // Email já cadastrado responde igualzinho a um cadastro novo: 201 com a
      // mesma mensagem e sem user/session. Quem é dono do email fica sabendo
      // pelo email que o GoTrue manda; quem está sondando de fora, não.
      if (authError.code === 'user_already_exists' || authError.message.includes('already registered')) {
        app.log.warn({ email }, 'Tentativa de cadastro com email já existente')
        return reply.code(201).send({ message: SIGNUP_OK, user: null, session: null })
      }

      // O trigger handle_new_user insere em profiles dentro da transação do
      // GoTrue; se a UNIQUE de username estourar (corrida com o check acima),
      // volta como "Database error saving new user".
      if (/database error/i.test(authError.message)) {
        app.log.error({ err: authError, username }, 'Erro do banco ao criar usuário')
        return reply.code(400).send({ error: 'Não foi possível criar a conta. Tente outro username.' })
      }

      // Mensagem crua do GoTrue fica no log, não na resposta.
      app.log.warn({ err: authError }, 'Signup recusado pelo GoTrue')
      return reply.code(400).send({ error: 'Não foi possível criar a conta' })
    }

    app.log.info({ userId: authData.user?.id, username }, 'Usuário criado no Auth')

    // Com confirmação de email ligada não vem sessão — e aí o user também não
    // vai junto, senão a resposta do cadastro novo (user preenchido) voltaria a
    // se distinguir da do email repetido (user null).
    return reply.code(201).send({
      message: SIGNUP_OK,
      user: authData.session ? authData.user : null,
      session: authData.session
    })
  })

  // Login
  app.post<{
    Body: { email: string; password: string }
  }>('/auth/login', {
    config: {
      rateLimit: { max: 5, timeWindow: '1 minute', ...perEmail }
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
      rateLimit: { max: 3, timeWindow: '1 hour', ...perEmail }
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
      .select('id, username, description, display_name, avatar_url, rating')
      .eq('id', user.id)
      .single()

    if (profileError) {
      app.log.error({ err: profileError, userId: user.id }, 'Erro ao buscar profile')
    }

    return reply.send({ user, profile: profile || null })
  })
}
