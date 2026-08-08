-- 008_remove_like.sql
-- APLICADO em 08/08/2026 no projeto soundsage.
--
-- Fecha o assunto like no banco. Nada no backend nem no front lê ou escreve
-- nessas coisas desde o deploy do 006. Decisão do Daniel: "remova qualquer
-- coisa de like, não uso mais nada de like e não tenho interesse".
--
-- As duas funções eram órfãs — nenhuma chamada em Mirsui/ nem em
-- mirsui-backend/. Ficaram de uma fase em que a contagem do feed morava em
-- RPC. Definições guardadas aqui caso precise reverter:
--
--   check_user_liked_track(p_track_id integer, p_user_id uuid) returns boolean
--     select exists(select 1 from track_likes
--                   where track_id = p_track_id and user_id = p_user_id)
--
--   get_feed_posts_with_interactions(p_limit integer, p_offset integer)
--     returns setof record — versão em RPC da query do feed, devolvendo
--     likes_count e comments_count por sub-select. Substituída pela query em
--     routes/feed.ts + get_track_save_counts.

drop function if exists public.check_user_liked_track(integer, uuid);
drop function if exists public.get_feed_posts_with_interactions(integer, integer);

-- 5 linhas de 2 usuários. Sem view, trigger ou FK dependente; as 6 policies
-- de RLS caem junto com a tabela. Os índices idx_track_likes_track_id,
-- idx_track_likes_user_id e unique_track_like saem junto.
drop table if exists public.track_likes;
