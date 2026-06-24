import type { FastifyInstance, FastifyRequest } from 'fastify'
import { supabase, supabaseForUser, supabaseAdmin, Profile } from '../lib/supabase'
import { extractToken, getOptionalUser, requireAuth } from '../plugins/auth'

const AVATAR_BUCKET = 'user-profile-images'

// Campos que o próprio usuário pode editar — rating/points ficam de fora
const EDITABLE_FIELDS = ['username', 'description', 'display_name', 'avatar_url'] as const

// Campos visíveis publicamente — email fica de fora
const PUBLIC_PROFILE_FIELDS =
  'id, username, display_name, avatar_url, description, rating'

// Faixas que o usuário reivindicou, expostas no perfil
const PROFILE_TRACK_FIELDS =
  'id, track_url, track_uri, track_title, artist_name, album_name, popularity, discover_rating, track_thumbnail, position, claimedat'

// Recado + autor (mesma forma usada no mural do front)
const PROFILE_COMMENT_SELECT =
  'id, content, is_pinned, created_at, author:profiles!profile_comments_author_id_fkey(id, username, display_name, avatar_url)'

const MAX_PROFILE_TRACKS = 100
const MAX_PROFILE_COMMENTS = 50

// Forma estável de um usuário numa lista de seguidores/seguindo.
interface FollowUser {
  id: string
  username: string | null
  display_name: string | null
  avatar_url: string | null
  rating: number | null
  isFollowing: boolean
}

// Normaliza uma linha vinda das RPCs get_user_followers/get_user_following.
function mapFollowUser(row: any, followingSet: Set<string>): FollowUser {
  return {
    id: row.id,
    username: row.username ?? null,
    display_name: row.display_name ?? null,
    avatar_url: row.avatar_url ?? null,
    rating: row.rating ?? null,
    isFollowing: followingSet.has(row.id),
  }
}

// Dado o token (opcional) de quem está vendo a lista, descobre quais dos `ids`
// esse usuário já segue — para o botão "Seguir / Deixar de seguir" aparecer no
// estado certo. Sem token (ou deslogado), ninguém é marcado como seguido.
async function viewerFollowingSet(
  request: FastifyRequest,
  ids: string[]
): Promise<Set<string>> {
  const token = extractToken(request)
  if (!token || ids.length === 0) return new Set()

  const viewer = await getOptionalUser(request)
  if (!viewer) return new Set()

  const { data } = await supabaseForUser(token)
    .from('followers')
    .select('following_id')
    .eq('follower_id', viewer.id)
    .in('following_id', ids)

  return new Set((data ?? []).map((r) => r.following_id as string))
}

export default async function profileRoutes(app: FastifyInstance) {
  // Listar todos os profiles
  app.get('/profiles', async (request, reply) => {
    const { data, error } = await supabase
      .from('profiles')
      .select(PUBLIC_PROFILE_FIELDS)
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
      .select(PUBLIC_PROFILE_FIELDS)
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
      .select(PUBLIC_PROFILE_FIELDS)
      .eq('username', username)
      .single()

    if (error) {
      app.log.warn({ username }, 'Profile não encontrado')
      return reply.code(404).send({ error: 'Profile não encontrado' })
    }

    return reply.send({ profile: data })
  })

  // Faixas reivindicadas pelo usuário (leitura pública)
  app.get<{
    Params: { id: string }
    Querystring: { limit?: string; offset?: string }
  }>('/profiles/:id/tracks', async (request, reply) => {
    const { id } = request.params
    const limit = Math.min(Math.max(Number(request.query.limit) || 50, 1), MAX_PROFILE_TRACKS)
    const offset = Math.max(Number(request.query.offset) || 0, 0)

    const { data: tracks, error } = await supabase
      .from('tracks')
      .select(PROFILE_TRACK_FIELDS)
      .eq('user_id', id)
      .not('claimedat', 'is', null)
      .order('claimedat', { ascending: false })
      .range(offset, offset + limit - 1)

    if (error) {
      app.log.error({ err: error, profileId: id }, 'Erro ao buscar faixas do perfil')
      return reply.code(500).send({ error: 'Erro ao buscar faixas' })
    }

    if (!tracks || tracks.length === 0) {
      return reply.send({ tracks: [] })
    }

    const trackIds = tracks.map((track) => track.id)

    // Quantas pessoas também salvaram cada faixa + favoritas do dono do perfil
    const [likesRes, favsRes] = await Promise.all([
      supabase.from('track_likes').select('track_id').in('track_id', trackIds),
      supabase.from('favorites').select('track_id').eq('user_id', id).in('track_id', trackIds),
    ])

    const likesByTrack: Record<number, number> = {}
    for (const row of likesRes.data || []) {
      likesByTrack[row.track_id] = (likesByTrack[row.track_id] || 0) + 1
    }
    const favoritedIds = new Set((favsRes.data || []).map((row) => row.track_id))

    const result = tracks.map((track) => ({
      ...track,
      likes_count: likesByTrack[track.id] || 0,
      is_favorited: favoritedIds.has(track.id),
    }))

    return reply.send({ tracks: result })
  })

  // Contadores sociais do perfil (seguidores / seguindo).
  // Usa as mesmas RPCs do front (SECURITY DEFINER), que enxergam além do RLS.
  app.get<{ Params: { id: string } }>('/profiles/:id/stats', async (request, reply) => {
    const { id } = request.params

    const [followers, following] = await Promise.all([
      supabase.rpc('get_user_followers', { user_uuid: id }),
      supabase.rpc('get_user_following', { user_uuid: id }),
    ])

    if (followers.error || following.error) {
      app.log.error(
        { errF: followers.error, errG: following.error, profileId: id },
        'Erro ao buscar contadores sociais'
      )
    }

    return reply.send({
      followers: Array.isArray(followers.data) ? followers.data.length : 0,
      following: Array.isArray(following.data) ? following.data.length : 0,
    })
  })

  // Lista de seguidores do perfil. Auth opcional: com token, cada usuário vem
  // marcado com isFollowing (relativo a quem está vendo), para o botão de
  // seguir/deixar de seguir aparecer no estado certo.
  app.get<{ Params: { id: string } }>(
    '/profiles/:id/followers',
    async (request, reply) => {
      const { id } = request.params
      const { data, error } = await supabase.rpc('get_user_followers', {
        user_uuid: id,
      })

      if (error) {
        app.log.error({ err: error, profileId: id }, 'Erro ao buscar seguidores')
        return reply.code(500).send({ error: 'Erro ao buscar seguidores' })
      }

      const rows = Array.isArray(data) ? data : []
      const followingSet = await viewerFollowingSet(
        request,
        rows.map((r: any) => r.id)
      )
      return reply.send({ users: rows.map((r: any) => mapFollowUser(r, followingSet)) })
    }
  )

  // Lista de quem o perfil está seguindo (mesma lógica do isFollowing).
  app.get<{ Params: { id: string } }>(
    '/profiles/:id/following',
    async (request, reply) => {
      const { id } = request.params
      const { data, error } = await supabase.rpc('get_user_following', {
        user_uuid: id,
      })

      if (error) {
        app.log.error({ err: error, profileId: id }, 'Erro ao buscar seguindo')
        return reply.code(500).send({ error: 'Erro ao buscar seguindo' })
      }

      const rows = Array.isArray(data) ? data : []
      const followingSet = await viewerFollowingSet(
        request,
        rows.map((r: any) => r.id)
      )
      return reply.send({ users: rows.map((r: any) => mapFollowUser(r, followingSet)) })
    }
  )

  // Seguir um perfil. Idempotente: seguir de novo não duplica a linha.
  app.post<{ Params: { id: string } }>(
    '/profiles/:id/follow',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params
      const followerId = request.user.id

      if (followerId === id) {
        return reply.code(400).send({ error: 'Você não pode seguir a si mesmo' })
      }

      const { error } = await supabaseForUser(request.accessToken)
        .from('followers')
        .insert({ follower_id: followerId, following_id: id })

      // 23505 = violação de unique (já seguia) → tratamos como sucesso.
      if (error && error.code !== '23505') {
        app.log.error({ err: error, followerId, following: id }, 'Erro ao seguir')
        return reply.code(500).send({ error: 'Erro ao seguir' })
      }

      return reply.send({ success: true, isFollowing: true })
    }
  )

  // Deixar de seguir um perfil.
  app.delete<{ Params: { id: string } }>(
    '/profiles/:id/follow',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params
      const followerId = request.user.id

      const { error } = await supabaseForUser(request.accessToken)
        .from('followers')
        .delete()
        .eq('follower_id', followerId)
        .eq('following_id', id)

      if (error) {
        app.log.error(
          { err: error, followerId, following: id },
          'Erro ao deixar de seguir'
        )
        return reply.code(500).send({ error: 'Erro ao deixar de seguir' })
      }

      return reply.send({ success: true, isFollowing: false })
    }
  )

  // Upload da foto de perfil (apenas o próprio usuário).
  // Recebe a imagem em base64 e envia para o Storage; devolve a URL pública.
  app.post<{
    Params: { id: string }
    Body: { image_base64?: string; content_type?: string }
  }>(
    '/profiles/:id/avatar',
    { preHandler: requireAuth, bodyLimit: 8 * 1024 * 1024 },
    async (request, reply) => {
    const { id } = request.params

    if (request.user.id !== id) {
      return reply.code(403).send({ error: 'Acesso negado' })
    }
    if (!supabaseAdmin) {
      return reply.code(500).send({ error: 'Upload indisponível (service role ausente)' })
    }

    const { image_base64, content_type } = request.body ?? {}
    if (!image_base64) {
      return reply.code(400).send({ error: 'Imagem é obrigatória' })
    }

    const contentType = content_type || 'image/jpeg'
    const buffer = Buffer.from(image_base64, 'base64')
    const filePath = `${id}/profile-picture`

    const { error: uploadError } = await supabaseAdmin.storage
      .from(AVATAR_BUCKET)
      .upload(filePath, buffer, { contentType, cacheControl: '300', upsert: true })

    if (uploadError) {
      app.log.error({ err: uploadError, userId: id }, 'Erro ao enviar avatar')
      return reply.code(500).send({ error: 'Erro ao enviar a imagem' })
    }

    const {
      data: { publicUrl },
    } = supabaseAdmin.storage.from(AVATAR_BUCKET).getPublicUrl(filePath)

    // cache-bust pra que o app recarregue a imagem nova (URL do arquivo é fixa)
    const versionedUrl = `${publicUrl}?v=${Date.now()}`

    const { data, error: updateError } = await supabaseAdmin
      .from('profiles')
      .update({ avatar_url: versionedUrl })
      .eq('id', id)
      .select(PUBLIC_PROFILE_FIELDS)
      .single()

    if (updateError) {
      app.log.error({ err: updateError, userId: id }, 'Erro ao atualizar avatar_url')
      return reply.code(500).send({ error: 'Erro ao salvar a foto' })
    }

    app.log.info({ userId: id }, 'Avatar atualizado com sucesso')
    return reply.send({ avatar_url: versionedUrl, profile: data })
  })

  // Mural de recados do perfil (leitura pública, fixados primeiro)
  app.get<{
    Params: { id: string }
    Querystring: { limit?: string; offset?: string }
  }>('/profiles/:id/comments', async (request, reply) => {
    const { id } = request.params
    const limit = Math.min(Math.max(Number(request.query.limit) || 10, 1), MAX_PROFILE_COMMENTS)
    const offset = Math.max(Number(request.query.offset) || 0, 0)

    const { data, count, error } = await supabase
      .from('profile_comments')
      .select(PROFILE_COMMENT_SELECT, { count: 'exact' })
      .eq('profile_id', id)
      .order('is_pinned', { ascending: false })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)

    if (error) {
      app.log.error({ err: error, profileId: id }, 'Erro ao buscar recados do perfil')
      return reply.code(500).send({ error: 'Erro ao buscar recados' })
    }

    return reply.send({ comments: data || [], total: count || 0 })
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

    const { data, error } = await supabaseForUser(request.accessToken)
      .from('profiles')
      .update(updateData)
      .eq('id', id)
      .select(PUBLIC_PROFILE_FIELDS)
      .single()

    if (error) {
      app.log.error({ err: error, userId: id }, 'Erro ao atualizar profile')
      return reply.code(500).send({ error: error.message })
    }

    app.log.info({ userId: id }, 'Profile atualizado com sucesso')
    return reply.send({ profile: data })
  })
}
