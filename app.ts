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
    'http://localhost:3001',
    'http://localhost:3000',
    'https://mirsui.com',        // ← Adicionar
    'https://www.mirsui.com',    // ← Adicionar (se usar www)
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

// Rota para verificar se o token é válido (usado pelo middleware)
fastify.get('/auth/verify', async (request, reply) => {
  try {
    const authHeader = request.headers.authorization

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.code(401).send({
        authenticated: false,
        error: 'Token não fornecido'
      })
    }

    const token = authHeader.substring(7)

    const { data: { user }, error } = await supabase.auth.getUser(token)

    if (error || !user) {
      return reply.code(401).send({
        authenticated: false,
        error: 'Token inválido ou expirado'
      })
    }

    return reply.send({
      authenticated: true,
      userId: user.id,
      email: user.email
    })
  } catch (err: any) {
    fastify.log.error(err)
    return reply.code(500).send({
      authenticated: false,
      error: 'Erro ao verificar token.'
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

// ==================== ROTAS DO FEED ====================

// Rota para buscar posts do feed com interações
fastify.get<{
  Querystring: { limit?: number; offset?: number }
}>('/feed', async (request, reply) => {
  try {
    // Converter para número para evitar concatenação de strings
    const limit = Number(request.query.limit) || 5
    const offset = Number(request.query.offset) || 0

    fastify.log.info({ limit, offset, rangeEnd: offset + limit - 1 }, 'Buscando posts do feed')

    // Buscar tracks com claimedat não nulo
    const { data: tracks, error: tracksError } = await supabase
      .from('tracks')
      .select(`
        id,
        track_url,
        track_title,
        artist_name,
        album_name,
        popularity,
        track_thumbnail,
        user_id,
        position,
        claimedat,
        track_uri,
        discover_rating,
        claim_message,
        youtube_url,
        profiles:user_id!inner (
          username,
          display_name,
          avatar_url
        )
      `)
      .not('claimedat', 'is', null)
      .order('claimedat', { ascending: false })
      .range(offset, offset + limit - 1)

    fastify.log.info({ tracksCount: tracks?.length || 0 }, 'Tracks retornados do Supabase')

    if (tracksError) {
      fastify.log.error({ err: tracksError }, 'Erro ao buscar posts do feed')
      return reply.code(500).send({ error: 'Erro ao buscar feed' })
    }

    if (!tracks || tracks.length === 0) {
      return reply.send({ posts: [], total: 0 })
    }

    // Buscar contadores de likes e comentários
    const trackIds = tracks.map((track: any) => track.id)

    const [likesResult, commentsResult] = await Promise.all([
      supabase
        .from('track_likes')
        .select('track_id')
        .in('track_id', trackIds),
      supabase
        .from('track_comments')
        .select('track_id')
        .in('track_id', trackIds)
    ])

    // Contar likes por track
    const likesCountByTrack: Record<number, number> = (likesResult.data || []).reduce((acc: Record<number, number>, like: any) => {
      acc[like.track_id] = (acc[like.track_id] || 0) + 1
      return acc
    }, {})

    // Contar comentários por track
    const commentsCountByTrack: Record<number, number> = (commentsResult.data || []).reduce((acc: Record<number, number>, comment: any) => {
      acc[comment.track_id] = (acc[comment.track_id] || 0) + 1
      return acc
    }, {})

    // Processar dados finais
    const postsWithInteractions = tracks.map((track: any) => {
      const profile = track.profiles

      return {
        id: track.id,
        track_url: track.track_url,
        track_title: track.track_title,
        artist_name: track.artist_name,
        album_name: track.album_name,
        popularity: track.popularity,
        track_thumbnail: track.track_thumbnail,
        user_id: track.user_id,
        position: track.position,
        claimedat: track.claimedat,
        track_uri: track.track_uri,
        discover_rating: track.discover_rating,
        claim_message: track.claim_message,
        youtube_url: track.youtube_url,
        username: profile?.username || '',
        display_name: profile?.display_name || null,
        avatar_url: profile?.avatar_url || null,
        likes_count: likesCountByTrack[track.id] || 0,
        comments_count: commentsCountByTrack[track.id] || 0
      }
    })

    return reply.send({ 
      posts: postsWithInteractions, 
      total: postsWithInteractions.length 
    })
  } catch (err: any) {
    fastify.log.error(err)
    return reply.code(500).send({ error: 'Erro ao buscar feed' })
  }
})

// Rota para buscar reivindicações recentes (sem duplicatas)
fastify.get<{
  Querystring: { limit?: number }
}>('/feed/recent-claims', async (request, reply) => {
  try {
    const { limit = 4 } = request.query

    // Buscar mais reivindicações para filtrar duplicatas
    const { data, error } = await supabase
      .from('tracks')
      .select('id, track_title, artist_name, track_thumbnail, track_url, claimedat, track_uri')
      .not('claimedat', 'is', null)
      .order('claimedat', { ascending: false })
      .limit(limit * 5)

    if (error) {
      fastify.log.error({ err: error }, 'Erro ao buscar reivindicações recentes')
      return reply.code(500).send({ error: 'Erro ao buscar reivindicações recentes' })
    }

    if (!data) {
      return reply.send({ claims: [] })
    }

    // Filtrar músicas únicas baseado no track_uri
    const uniqueTracks = new Map<string, any>()

    for (const track of data) {
      if (track.track_uri && !uniqueTracks.has(track.track_uri)) {
        uniqueTracks.set(track.track_uri, {
          id: track.id,
          track_title: track.track_title,
          artist_name: track.artist_name,
          track_thumbnail: track.track_thumbnail,
          track_url: track.track_url,
          claimedat: track.claimedat
        })
      }

      if (uniqueTracks.size >= limit) break
    }

    return reply.send({ claims: Array.from(uniqueTracks.values()) })
  } catch (err: any) {
    fastify.log.error(err)
    return reply.code(500).send({ error: 'Erro ao buscar reivindicações recentes' })
  }
})

// Rota para buscar likes do usuário em tracks específicos
fastify.post<{
  Body: { track_ids: number[] }
}>('/feed/user-likes', async (request, reply) => {
  try {
    const authHeader = request.headers.authorization

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.send({ liked_tracks: [] })
    }

    const token = authHeader.substring(7)
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)

    if (authError || !user) {
      return reply.send({ liked_tracks: [] })
    }

    const { track_ids } = request.body

    if (!track_ids || track_ids.length === 0) {
      return reply.send({ liked_tracks: [] })
    }

    const { data, error } = await supabase
      .from('track_likes')
      .select('track_id')
      .eq('user_id', user.id)
      .in('track_id', track_ids)

    if (error) {
      fastify.log.error({ err: error, userId: user.id }, 'Erro ao buscar likes do usuário')
      return reply.send({ liked_tracks: [] })
    }

    const likedTrackIds = (data || []).map((like: any) => like.track_id)

    return reply.send({ liked_tracks: likedTrackIds })
  } catch (err: any) {
    fastify.log.error(err)
    return reply.code(500).send({ error: 'Erro ao buscar likes do usuário' })
  }
})

// ==================== ROTAS DE TRACKS ====================

// Dar like em uma track
fastify.post<{
  Params: { id: string }
}>('/tracks/:id/like', async (request, reply) => {
  try {
    const authHeader = request.headers.authorization
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'Token não fornecido' })
    }

    const token = authHeader.substring(7)
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)

    if (authError || !user) {
      return reply.code(401).send({ error: 'Usuário não autenticado' })
    }

    const trackId = parseInt(request.params.id)

    // Inserir like
    const { error } = await supabase
      .from('track_likes')
      .insert({ 
        track_id: trackId,
        user_id: user.id
      })

    if (error) {
      fastify.log.error({ err: error, userId: user.id, trackId }, 'Erro ao dar like')
      return reply.code(400).send({ error: error.message })
    }

    fastify.log.info({ userId: user.id, trackId }, 'Like adicionado')
    return reply.send({ success: true })
  } catch (err: any) {
    fastify.log.error(err)
    return reply.code(500).send({ error: 'Erro interno do servidor' })
  }
})

// Remover like de uma track
fastify.delete<{
  Params: { id: string }
}>('/tracks/:id/like', async (request, reply) => {
  try {
    const authHeader = request.headers.authorization
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'Token não fornecido' })
    }

    const token = authHeader.substring(7)
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)

    if (authError || !user) {
      return reply.code(401).send({ error: 'Usuário não autenticado' })
    }

    const trackId = parseInt(request.params.id)

    // Remover like
    const { error } = await supabase
      .from('track_likes')
      .delete()
      .eq('track_id', trackId)
      .eq('user_id', user.id)

    if (error) {
      fastify.log.error({ err: error, userId: user.id, trackId }, 'Erro ao remover like')
      return reply.code(400).send({ error: error.message })
    }

    fastify.log.info({ userId: user.id, trackId }, 'Like removido')
    return reply.send({ success: true })
  } catch (err: any) {
    fastify.log.error(err)
    return reply.code(500).send({ error: 'Erro interno do servidor' })
  }
})

// Buscar comentários de uma track
fastify.get<{
  Params: { id: string }
}>('/tracks/:id/comments', async (request, reply) => {
  try {
    const trackId = parseInt(request.params.id)

    const { data, error } = await supabase
      .from('track_comments')
      .select(`
        id,
        comment_text,
        created_at,
        user_id,
        profiles:user_id (
          username,
          display_name,
          avatar_url
        )
      `)
      .eq('track_id', trackId)
      .order('created_at', { ascending: false })

    if (error) {
      fastify.log.error({ err: error, trackId }, 'Erro ao buscar comentários')
      return reply.code(500).send({ error: error.message })
    }

    return reply.send({ comments: data || [] })
  } catch (err: any) {
    fastify.log.error(err)
    return reply.code(500).send({ error: 'Erro interno do servidor' })
  }
})

// Criar comentário em uma track
fastify.post<{
  Params: { id: string }
  Body: { comment: string }
}>('/tracks/:id/comments', async (request, reply) => {
  try {
    const authHeader = request.headers.authorization
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'Token não fornecido' })
    }

    const token = authHeader.substring(7)
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)

    if (authError || !user) {
      return reply.code(401).send({ error: 'Usuário não autenticado' })
    }

    const trackId = parseInt(request.params.id)
    const { comment } = request.body

    if (!comment || comment.trim().length === 0) {
      return reply.code(400).send({ error: 'Comentário não pode estar vazio' })
    }

    // Inserir comentário
    const { data, error } = await supabase
      .from('track_comments')
      .insert({
        track_id: trackId,
        user_id: user.id,
        comment_text: comment.trim()
      })
      .select(`
        id,
        comment_text,
        created_at,
        user_id,
        profiles:user_id (
          username,
          display_name,
          avatar_url
        )
      `)
      .single()

    if (error) {
      fastify.log.error({ err: error, userId: user.id, trackId }, 'Erro ao criar comentário')
      return reply.code(400).send({ error: error.message })
    }

    fastify.log.info({ userId: user.id, trackId, commentId: data.id }, 'Comentário criado')
    return reply.send({ comment: data })
  } catch (err: any) {
    fastify.log.error(err)
    return reply.code(500).send({ error: 'Erro interno do servidor' })
  }
})

// Deletar comentário
fastify.delete<{
  Params: { commentId: string }
}>('/comments/:commentId', async (request, reply) => {
  try {
    const authHeader = request.headers.authorization
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'Token não fornecido' })
    }

    const token = authHeader.substring(7)
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)

    if (authError || !user) {
      return reply.code(401).send({ error: 'Usuário não autenticado' })
    }

    const commentId = parseInt(request.params.commentId)

    // Verificar se o comentário pertence ao usuário
    const { data: comment, error: fetchError } = await supabase
      .from('track_comments')
      .select('user_id')
      .eq('id', commentId)
      .single()

    if (fetchError || !comment) {
      return reply.code(404).send({ error: 'Comentário não encontrado' })
    }

    if (comment.user_id !== user.id) {
      return reply.code(403).send({ error: 'Não autorizado a deletar este comentário' })
    }

    // Deletar comentário
    const { error } = await supabase
      .from('track_comments')
      .delete()
      .eq('id', commentId)

    if (error) {
      fastify.log.error({ err: error, userId: user.id, commentId }, 'Erro ao deletar comentário')
      return reply.code(400).send({ error: error.message })
    }

    fastify.log.info({ userId: user.id, commentId }, 'Comentário deletado')
    return reply.send({ success: true })
  } catch (err: any) {
    fastify.log.error(err)
    return reply.code(500).send({ error: 'Erro interno do servidor' })
  }
})

// ==================== ROTAS DE USUÁRIO ====================

// Buscar pontos do usuário
fastify.get('/user/points', async (request, reply) => {
  try {
    const authHeader = request.headers.authorization
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'Token não fornecido' })
    }

    const token = authHeader.substring(7)
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)

    if (authError || !user) {
      return reply.code(401).send({ error: 'Usuário não autenticado' })
    }

    // Buscar pontos do usuário
    const { data: points, error } = await supabase
      .rpc('get_user_points', { user_uuid: user.id })

    if (error) {
      fastify.log.error({ err: error, userId: user.id }, 'Erro ao buscar pontos')
      return reply.code(500).send({ error: 'Erro ao buscar pontos do usuário' })
    }

    return reply.send({ 
      points: points || 0,
      userId: user.id 
    })
  } catch (err: any) {
    fastify.log.error(err)
    return reply.code(500).send({ error: 'Erro interno do servidor' })
  }
})

// ==================== ROTAS DE CLAIM ====================

// Reivindicar uma música
fastify.post<{
  Body: {
    trackUri: string
    trackName: string
    artistName: string
    albumName: string
    spotifyUrl: string
    trackThumbnail: string
    popularity: number
    duration_ms?: number
    claimMessage?: string
  }
}>('/tracks/claim', async (request, reply) => {
  try {
    const authHeader = request.headers.authorization
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'Token não fornecido' })
    }

    const token = authHeader.substring(7)
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)

    if (authError || !user) {
      return reply.code(401).send({ error: 'Usuário não autenticado' })
    }

    const {
      trackUri,
      trackName,
      artistName,
      albumName,
      spotifyUrl,
      trackThumbnail,
      popularity,
      duration_ms,
      claimMessage
    } = request.body

    // Validações
    if (!trackUri || !trackName || !artistName) {
      return reply.code(400).send({ error: 'Dados da música são obrigatórios' })
    }

    // Verificar se o usuário já reivindicou esta música
    const { data: existingClaim, error: existingError } = await supabase
      .from('tracks')
      .select('id, position, youtube_url')
      .eq('user_id', user.id)
      .eq('track_uri', trackUri)
      .single()

    if (existingError && existingError.code !== 'PGRST116') {
      fastify.log.error({ err: existingError }, 'Erro ao verificar claim existente')
      return reply.code(500).send({ error: 'Erro ao verificar reivindicação' })
    }

    if (existingClaim) {
      return reply.code(409).send({
        error: 'Você já reivindicou esta música',
        position: existingClaim.position,
        youtubeUrl: existingClaim.youtube_url
      })
    }

    // Contar quantas vezes esta música foi reivindicada
    const { count: trackCount, error: countError } = await supabase
      .from('tracks')
      .select('*', { count: 'exact' })
      .eq('track_uri', trackUri)

    if (countError) {
      fastify.log.error({ err: countError }, 'Erro ao contar claims')
      return reply.code(500).send({ error: 'Erro ao processar reivindicação' })
    }

    // A próxima posição será a contagem atual + 1
    const nextPosition = trackCount !== null ? trackCount + 1 : 1

    // Calcular discover_rating
    const discoverRating = 100 - popularity + 100 / nextPosition

    // Inserir claim no banco
    const insertData: any = {
      track_url: spotifyUrl,
      track_uri: trackUri,
      track_title: trackName,
      artist_name: artistName,
      album_name: albumName,
      popularity: popularity || 0,
      discover_rating: discoverRating,
      track_thumbnail: trackThumbnail,
      user_id: user.id,
      position: nextPosition,
      claimedat: new Date().toISOString()
    }

    if (claimMessage && claimMessage.trim()) {
      insertData.claim_message = claimMessage.trim()
    }

    const { data: insertedTrack, error: insertError } = await supabase
      .from('tracks')
      .insert([insertData])
      .select('id, position, youtube_url')
      .single()

    if (insertError) {
      fastify.log.error({ err: insertError, userId: user.id }, 'Erro ao inserir claim')
      return reply.code(500).send({ error: 'Erro ao salvar reivindicação' })
    }

    fastify.log.info({
      userId: user.id,
      trackUri,
      position: nextPosition
    }, 'Música reivindicada com sucesso')

    return reply.code(201).send({
      success: true,
      message: 'Música reivindicada com sucesso!',
      position: nextPosition,
      youtubeUrl: insertedTrack?.youtube_url || null,
      data: insertedTrack
    })
  } catch (err: any) {
    fastify.log.error(err)
    return reply.code(500).send({ error: 'Erro interno do servidor' })
  }
})

// Verificar status de claim de uma música
fastify.get<{
  Querystring: { trackUri: string }
}>('/tracks/claim/status', async (request, reply) => {
  try {
    const authHeader = request.headers.authorization
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'Token não fornecido' })
    }

    const token = authHeader.substring(7)
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)

    if (authError || !user) {
      return reply.code(401).send({ error: 'Usuário não autenticado' })
    }

    const { trackUri } = request.query

    if (!trackUri) {
      return reply.code(400).send({ error: 'trackUri é obrigatório' })
    }

    const { data: claim, error } = await supabase
      .from('tracks')
      .select('position, youtube_url')
      .eq('user_id', user.id)
      .eq('track_uri', trackUri)
      .single()

    if (error && error.code !== 'PGRST116') {
      fastify.log.error({ err: error }, 'Erro ao verificar claim')
      return reply.code(500).send({ error: 'Erro ao verificar claim' })
    }

    return reply.send({
      claimed: !!claim,
      position: claim?.position || null,
      youtubeUrl: claim?.youtube_url || null
    })
  } catch (err: any) {
    fastify.log.error(err)
    return reply.code(500).send({ error: 'Erro interno do servidor' })
  }
})

// ==================== INICIAR SERVIDOR ====================

const start = async () => {
  try {
    await fastify.listen({ port: 3000, host: '0.0.0.0' })
    console.log('🚀 Backend Mirsui rodando em http://localhost:3000')
    console.log('📋 Rotas de autenticação (100% backend):')
    console.log('   POST /auth/signup   - Criar conta')
    console.log('   POST /auth/login    - Fazer login')
    console.log('   POST /auth/logout   - Fazer logout')
    console.log('   GET  /auth/verify   - Verificar token (middleware)')
    console.log('   GET  /auth/me       - Dados do usuário logado')
    console.log('   POST /auth/refresh  - Renovar token')
    console.log('   POST /auth/reset-password - Recuperar senha')
    console.log('📋 Rotas do Feed:')
    console.log('   GET  /feed          - Buscar posts do feed')
    console.log('   GET  /feed/recent-claims - Buscar reivindicações recentes')
    console.log('   POST /feed/user-likes - Verificar likes do usuário')
    console.log('📋 Rotas de Tracks:')
    console.log('   POST /tracks/:id/like - Dar like em uma track')
    console.log('   DELETE /tracks/:id/like - Remover like de uma track')
    console.log('   GET  /tracks/:id/comments - Buscar comentários de uma track')
    console.log('   POST /tracks/:id/comments - Criar comentário em uma track')
    console.log('📋 Rotas de Comentários:')
    console.log('   DELETE /comments/:commentId - Deletar comentário')
    console.log('📋 Rotas de Usuário:')
    console.log('   GET  /user/points - Buscar pontos do usuário')
    console.log('📋 Rotas de Claim:')
    console.log('   POST /tracks/claim - Reivindicar uma música')
    console.log('   GET  /tracks/claim/status - Verificar status de claim')
    console.log('📋 Outras rotas:')
    console.log('   GET  /              - Health check')
    console.log('   GET  /health        - Health check detalhado')
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
