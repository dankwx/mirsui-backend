-- ============================================================
-- Migração de segurança — projeto soundsage (Mirsui)
-- Habilita RLS nas 12 tabelas expostas e cria políticas que
-- casam com os fluxos reais do frontend e do backend Fastify.
--
-- Pré-requisito: o backend precisa estar com o código que
-- repassa o token do usuário (supabaseForUser) — já aplicado.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Funções de sistema viram SECURITY DEFINER
--    (rodam em triggers/processamento e precisam ignorar RLS)
-- ------------------------------------------------------------
alter function public.process_expired_predictions_v2() security definer set search_path = public;
alter function public.calculate_user_rating() security definer set search_path = public;
alter function public.log_track_popularity() security definer set search_path = public;
alter function public.get_user_points(uuid) security definer set search_path = public;

-- credit_user_points só pode ser chamada por outras funções (process_expired),
-- nunca diretamente por clientes — senão qualquer um credita pontos a si mesmo
revoke execute on function public.credit_user_points(uuid, integer, text, integer) from public, anon, authenticated;
revoke execute on function public.credit_user_points(uuid, integer, character varying, text, integer) from public, anon, authenticated;

-- debit_user_points vira SECURITY DEFINER com guarda: o chamador só pode
-- debitar os próprios pontos (sem isso, qualquer um drenaria pontos alheios)
create or replace function public.debit_user_points(
    user_uuid uuid,
    points_amount integer,
    transaction_description text,
    prediction_id integer default null::integer
) returns boolean
language plpgsql security definer set search_path = public as $function$
declare
    current_balance integer;
    new_balance integer;
begin
    -- Guarda: apenas o próprio usuário pode debitar seus pontos
    if auth.uid() is distinct from user_uuid then
        raise notice 'Tentativa de debitar pontos de outro usuário bloqueada';
        return false;
    end if;

    if points_amount <= 0 then
        return false;
    end if;

    current_balance := get_user_points(user_uuid);

    if current_balance < points_amount then
        raise notice 'Saldo insuficiente. Atual: %, Necessário: %', current_balance, points_amount;
        return false;
    end if;

    new_balance := current_balance - points_amount;

    insert into user_points_transactions (
        user_id,
        transaction_type,
        points_amount,
        points_balance_after,
        description,
        related_prediction_id
    ) values (
        user_uuid,
        'debit',
        points_amount,
        new_balance,
        transaction_description,
        prediction_id
    );

    return true;

exception
    when others then
        raise notice 'Erro ao debitar pontos: %', sqlerrm;
        return false;
end;
$function$;

-- ------------------------------------------------------------
-- 2. Habilitar RLS nas tabelas descobertas
-- ------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.tracks enable row level security;
alter table public.favorites enable row level security;
alter table public.followers enable row level security;
alter table public.notes enable row level security;
alter table public.posts enable row level security;
alter table public.trending_stats enable row level security;
alter table public.user_actions enable row level security;
alter table public.track_popularity_history enable row level security;
alter table public.music_predictions enable row level security;
alter table public.user_points_transactions enable row level security;
alter table public.prediction_tracks enable row level security;

-- ------------------------------------------------------------
-- 3. profiles — leitura pública SEM a coluna email,
--    update apenas do próprio perfil e só nas colunas editáveis
-- ------------------------------------------------------------
drop policy if exists "Allow logged-in read access" on public.profiles;
create policy "profiles_select_public" on public.profiles
  for select to anon, authenticated using (true);
create policy "profiles_update_own" on public.profiles
  for update to authenticated
  using (auth.uid() = id) with check (auth.uid() = id);

-- Esconde email e bloqueia escrita em points/rating no nível de coluna
revoke select on public.profiles from anon, authenticated;
grant select (id, username, description, display_name, avatar_url, rating, points, prophet_points)
  on public.profiles to anon, authenticated;
revoke insert, update, delete on public.profiles from anon, authenticated;
grant update (username, description, display_name, avatar_url)
  on public.profiles to authenticated;

-- ------------------------------------------------------------
-- 4. tracks — leitura pública; escrita apenas do dono
-- ------------------------------------------------------------
create policy "tracks_select_public" on public.tracks
  for select to anon, authenticated using (true);
create policy "tracks_insert_own" on public.tracks
  for insert to authenticated with check (auth.uid() = user_id);
create policy "tracks_update_own" on public.tracks
  for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "tracks_delete_own" on public.tracks
  for delete to authenticated using (auth.uid() = user_id);

-- ------------------------------------------------------------
-- 5. favorites / followers — leitura ok; escrita apenas própria
-- ------------------------------------------------------------
create policy "favorites_select_public" on public.favorites
  for select to anon, authenticated using (true);
create policy "favorites_insert_own" on public.favorites
  for insert to authenticated with check (auth.uid() = user_id);
create policy "favorites_delete_own" on public.favorites
  for delete to authenticated using (auth.uid() = user_id);

-- followers já tem política de SELECT ("Allow logged-in read access")
create policy "followers_insert_own" on public.followers
  for insert to authenticated with check (auth.uid() = follower_id);
create policy "followers_delete_own" on public.followers
  for delete to authenticated using (auth.uid() = follower_id);

-- ------------------------------------------------------------
-- 6. Pontos — ledger só legível pelo dono; escrita apenas via
--    funções SECURITY DEFINER (nenhuma política de INSERT)
-- ------------------------------------------------------------
create policy "points_select_own" on public.user_points_transactions
  for select to authenticated using (auth.uid() = user_id);

-- ------------------------------------------------------------
-- 7. Previsões v2 — remove o UPDATE aberto ("System can update")
--    e adiciona DELETE do próprio registro (rollback de débito)
-- ------------------------------------------------------------
drop policy if exists "System can update predictions" on public.music_predictions_v2;
create policy "predictions_v2_delete_own" on public.music_predictions_v2
  for delete to authenticated using (auth.uid() = user_id);

-- prediction_tracks: catálogo público; insert por usuários logados
create policy "prediction_tracks_select_public" on public.prediction_tracks
  for select to anon, authenticated using (true);
create policy "prediction_tracks_insert_auth" on public.prediction_tracks
  for insert to authenticated with check (true);

-- ------------------------------------------------------------
-- 8. Tabelas de leitura pública usadas por RPCs de trending
-- ------------------------------------------------------------
create policy "trending_stats_select_public" on public.trending_stats
  for select to anon, authenticated using (true);
create policy "track_popularity_history_select_public" on public.track_popularity_history
  for select to anon, authenticated using (true);

-- ------------------------------------------------------------
-- 9. Tabelas legadas/não usadas pelo app: RLS ligado sem
--    políticas = totalmente bloqueadas para anon/authenticated
--    (notes, posts, user_actions, music_predictions v1)
-- ------------------------------------------------------------
-- nada a criar — apenas o ENABLE acima
