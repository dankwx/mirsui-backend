import type { FastifyInstance, FastifyReply } from 'fastify'
import { supabase, supabaseForUser } from '../lib/supabase'
import { requireAuth } from '../plugins/auth'

const COMMENT_SELECT = `
  id,
  comment_text,
  created_at,
  user_id,
  track_id,
  profiles:user_id (
    username,
    display_name,
    avatar_url
  )
`

function formatComment(comment: any) {
  const profile = comment.profiles
  return {
    id: comment.id,
    track_id: comment.track_id,
    user_id: comment.user_id,
    comment_text: comment.comment_text,
    created_at: comment.created_at,
    updated_at: comment.created_at,
    username: profile?.username || '',
    display_name: profile?.display_name || null,
    avatar_url: profile?.avatar_url || null
  }
}

// Valida e converte um id numérico vindo da URL; responde 400 se inválido
function parseId(value: string, reply: FastifyReply, label: string): number | null {
  const id = Number(value)
  if (!Number.isInteger(id) || id < 1) {
    reply.code(400).send({ error: `${label} inválido` })
    return null
  }
  return id
}

export default async function trackRoutes(app: FastifyInstance) {
  // Dar like em uma track
  app.post<{
    Params: { id: string }
  }>('/tracks/:id/like', { preHandler: requireAuth }, async (request, reply) => {
    const trackId = parseId(request.params.id, reply, 'ID da track')
    if (trackId === null) return

    const { error } = await supabaseForUser(request.accessToken)
      .from('track_likes')
      .insert({ track_id: trackId, user_id: request.user.id })

    if (error) {
      app.log.error({ err: error, userId: request.user.id, trackId }, 'Erro ao dar like')
      return reply.code(400).send({ error: error.message })
    }

    app.log.info({ userId: request.user.id, trackId }, 'Like adicionado')
    return reply.send({ success: true })
  })

  // Remover like de uma track
  app.delete<{
    Params: { id: string }
  }>('/tracks/:id/like', { preHandler: requireAuth }, async (request, reply) => {
    const trackId = parseId(request.params.id, reply, 'ID da track')
    if (trackId === null) return

    const { data: deletedData, error } = await supabaseForUser(request.accessToken)
      .from('track_likes')
      .delete()
      .eq('track_id', trackId)
      .eq('user_id', request.user.id)
      .select()

    if (error) {
      app.log.error({ err: error, userId: request.user.id, trackId }, 'Erro ao remover like')
      return reply.code(400).send({ error: error.message })
    }

    if (!deletedData || deletedData.length === 0) {
      return reply.code(404).send({ error: 'Like não encontrado' })
    }

    app.log.info({ userId: request.user.id, trackId }, 'Like removido com sucesso')
    return reply.send({ success: true, deleted: deletedData })
  })

  // Buscar comentários de uma track
  app.get<{
    Params: { id: string }
  }>('/tracks/:id/comments', async (request, reply) => {
    const trackId = parseId(request.params.id, reply, 'ID da track')
    if (trackId === null) return

    const { data, error } = await supabase
      .from('track_comments')
      .select(COMMENT_SELECT)
      .eq('track_id', trackId)
      .order('created_at', { ascending: false })

    if (error) {
      app.log.error({ err: error, trackId }, 'Erro ao buscar comentários')
      return reply.code(500).send({ error: error.message })
    }

    return reply.send({ comments: (data || []).map(formatComment) })
  })

  // Criar comentário em uma track
  app.post<{
    Params: { id: string }
    Body: { comment: string }
  }>('/tracks/:id/comments', { preHandler: requireAuth }, async (request, reply) => {
    const trackId = parseId(request.params.id, reply, 'ID da track')
    if (trackId === null) return

    const { comment } = request.body ?? {}

    if (!comment || comment.trim().length === 0) {
      return reply.code(400).send({ error: 'Comentário não pode estar vazio' })
    }

    const { data, error } = await supabaseForUser(request.accessToken)
      .from('track_comments')
      .insert({
        track_id: trackId,
        user_id: request.user.id,
        comment_text: comment.trim()
      })
      .select(COMMENT_SELECT)
      .single()

    if (error) {
      app.log.error({ err: error, userId: request.user.id, trackId }, 'Erro ao criar comentário')
      return reply.code(400).send({ error: error.message })
    }

    app.log.info({ userId: request.user.id, trackId, commentId: data.id }, 'Comentário criado')
    return reply.send({ comment: formatComment(data) })
  })

  // Deletar comentário (apenas o autor)
  app.delete<{
    Params: { commentId: string }
  }>('/comments/:commentId', { preHandler: requireAuth }, async (request, reply) => {
    const commentId = parseId(request.params.commentId, reply, 'ID do comentário')
    if (commentId === null) return

    const { data: comment, error: fetchError } = await supabase
      .from('track_comments')
      .select('user_id')
      .eq('id', commentId)
      .maybeSingle()

    if (fetchError || !comment) {
      return reply.code(404).send({ error: 'Comentário não encontrado' })
    }

    if (comment.user_id !== request.user.id) {
      return reply.code(403).send({ error: 'Não autorizado a deletar este comentário' })
    }

    const { error } = await supabaseForUser(request.accessToken)
      .from('track_comments')
      .delete()
      .eq('id', commentId)

    if (error) {
      app.log.error({ err: error, userId: request.user.id, commentId }, 'Erro ao deletar comentário')
      return reply.code(400).send({ error: error.message })
    }

    app.log.info({ userId: request.user.id, commentId }, 'Comentário deletado')
    return reply.send({ success: true })
  })
}
