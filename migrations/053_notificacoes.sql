-- 053_notificacoes.sql
-- Avisos por e-mail: novo seguidor na hora, e os achados que subiram uma vez
-- por semana.
--
-- (A 049 continua reservada para a paginação por cursor da fila do banco.)
--
-- ------------------------------------------------------------
-- O QUE AVISA, E O QUE NÃO
-- ------------------------------------------------------------
-- Só o que é sobre a pessoa, pensando no Mirsui com muita gente:
--
--   seguidor       alguém começou a seguir você. Na hora, um e-mail por
--                  seguidor: ver gente chegando é o que traz a pessoa de volta.
--   saltos_semana  as faixas que você salvou e mais subiram na semana. Um
--                  e-mail por semana no máximo, com os 3 maiores saltos, para
--                  quem tem 5 saves ou 5 mil.
--
-- Fica de fora o que é sobre o conteúdo: nota de salto, outra pessoa salvando
-- a mesma faixa, atividade de quem você segue. Em escala isso é spam; o lugar
-- dele é a página e o feed.
--
-- ------------------------------------------------------------
-- COMO ANDA
-- ------------------------------------------------------------
-- 1. Todo aviso nasce como uma linha de `notificacoes`, que é a caixa de saída:
--      seguidor       pelo gatilho em `followers`. O site grava o seguir direto
--                     no banco, com a chave do usuário, e o app passa pelo
--                     backend; o gatilho pega os dois.
--      saltos_semana  por `gerar_resumo_de_saltos()`, que o backend chama na
--                     segunda, depois da rodada.
-- 2. O backend reivindica as pendentes a cada 30 s
--    (`reivindicar_notificacoes`), manda pelo Resend e fecha cada uma com
--    `concluir_notificacao`.
--
-- `chave` única é o que impede repetição:
--      seguidor:<quem segue>:<quem foi seguido>  vale para sempre. Seguir,
--          deixar de seguir e seguir de novo não manda outro e-mail.
--      saltos:<pessoa>:<semana ISO>  uma vez por semana.
--
-- ------------------------------------------------------------
-- QUEM NÃO RECEBE
-- ------------------------------------------------------------
--   - perfil semeado (033). O e-mail dele é @seed.mirsui.invalid, e o
--     semeado também não gera aviso de seguidor: "fulano começou a te seguir"
--     vindo de um perfil inventado seria enganar a pessoa.
--   - e-mail não confirmado.
--   - quem desligou o tipo em `preferencias_de_email`.
--   - aviso de seguidor de quem já deixou de seguir antes do envio.
--   - aviso com mais de 3 dias na fila (o limite diário segurou): já é velho.
--
-- ------------------------------------------------------------
-- QUEM PODE O QUÊ
-- ------------------------------------------------------------
-- As tabelas ficam fechadas (RLS ligado, sem política). O backend usa a
-- service role. A pessoa mexe nas próprias preferências por duas portas:
--   - logada, por `minhas_preferencias_de_email`/`salvar_minhas_...`
--     (auth.uid());
--   - pelo link do e-mail, sem login, por `..._pelo_token`. O token é um uuid
--     aleatório por pessoa (122 bits): quem tem o link é a pessoa. É por isso
--     que anon executa essas duas, e só elas.

-- ---------------------------------------------------------------------------
-- 1. Tabelas
-- ---------------------------------------------------------------------------

create table if not exists public.preferencias_de_email (
  user_id        uuid primary key references auth.users (id) on delete cascade,
  seguidor       boolean not null default true,
  saltos         boolean not null default true,
  token          uuid not null unique default gen_random_uuid(),
  atualizada_em  timestamptz not null default now()
);

comment on table public.preferencias_de_email is
  'Quais avisos por e-mail a pessoa recebe, e o token do link de descadastro. Sem linha = tudo ligado. Ver migrations/053_notificacoes.sql';

create table if not exists public.notificacoes (
  id             bigint generated always as identity primary key,
  user_id        uuid not null references auth.users (id) on delete cascade,
  tipo           text not null check (tipo in ('seguidor', 'saltos_semana')),
  -- quem causou o aviso (o seguidor); null no resumo semanal
  ator_id        uuid references auth.users (id) on delete cascade,
  dados          jsonb not null default '{}'::jsonb,
  chave          text not null unique,
  status         text not null default 'pendente'
                 check (status in ('pendente', 'enviando', 'enviada', 'pulada', 'falhou')),
  tentativas     smallint not null default 0,
  -- por que pulou, ou o último erro do envio
  motivo         text,
  criada_em      timestamptz not null default now(),
  atualizada_em  timestamptz not null default now(),
  enviada_em     timestamptz
);

comment on table public.notificacoes is
  'Caixa de saída dos avisos por e-mail. O backend reivindica as pendentes e marca o resultado. Ver migrations/053_notificacoes.sql';

create index if not exists notificacoes_fila_idx
  on public.notificacoes (criada_em) where status in ('pendente', 'enviando');
create index if not exists notificacoes_pessoa_idx
  on public.notificacoes (user_id, criada_em desc);
create index if not exists notificacoes_ator_idx
  on public.notificacoes (ator_id) where ator_id is not null;
create index if not exists notificacoes_enviadas_idx
  on public.notificacoes (enviada_em) where status = 'enviada';

-- Uma linha por semana gerada, com ou sem salto: é o que deixa o backend
-- perguntar "já gerei esta semana?" sem recalcular.
create table if not exists public.resumos_de_saltos (
  semana     text primary key check (semana ~ '^\d{4}-\d{2}$'),
  gerado_em  timestamptz not null default now(),
  pessoas    integer not null
);

alter table public.preferencias_de_email enable row level security;
alter table public.notificacoes enable row level security;
alter table public.resumos_de_saltos enable row level security;
revoke all on public.preferencias_de_email from anon, authenticated;
revoke all on public.notificacoes from anon, authenticated;
revoke all on public.resumos_de_saltos from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Novo seguidor — gatilho em followers
-- ---------------------------------------------------------------------------

create or replace function public.notificar_novo_seguidor()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.follower_id = new.following_id then
    return new;
  end if;

  if exists (
    select 1 from auth.users u
     where u.id in (new.follower_id, new.following_id)
       and u.raw_app_meta_data->>'seeded' = 'true'
  ) then
    return new;
  end if;

  insert into public.notificacoes (user_id, tipo, ator_id, chave)
  values (
    new.following_id, 'seguidor', new.follower_id,
    'seguidor:' || new.follower_id || ':' || new.following_id
  )
  on conflict (chave) do nothing;

  return new;
exception when others then
  -- O aviso nunca pode impedir o seguir.
  raise warning 'notificar_novo_seguidor: %', sqlerrm;
  return new;
end;
$$;

revoke all on function public.notificar_novo_seguidor() from public, anon, authenticated;

drop trigger if exists followers_notificar on public.followers;
create trigger followers_notificar
  after insert on public.followers
  for each row execute function public.notificar_novo_seguidor();

-- ---------------------------------------------------------------------------
-- 3. Resumo semanal dos saltos
-- ---------------------------------------------------------------------------
-- A régua é a do aviso de salto do feed (050), na escala 0-100 da página de
-- faixa: pelo menos 5 pontos E 20% a mais de rank em relação ao último ponto
-- gravado até 7 dias atrás.
--
-- Diferença de propósito em relação ao feed: só conta save com mais de 7
-- dias. Quem salvou ontem uma faixa que já vinha subindo não "achou" a
-- subida; se ela continuar, o aviso vem na semana seguinte.
--
-- O salto é da faixa, não da pessoa, então é calculado uma vez por gravação
-- salva e depois espalhado para quem a salvou. Em 26/11/2026 são 6 pessoas
-- reais com save medido e leva milissegundos. O custo cresce com as gravações
-- distintas salvas (uma busca no histórico para cada); se passar do limite do
-- PostgREST, o próximo passo é gravar os saltos da semana numa tabela em
-- lotes e espalhar por pessoa num segundo passo.

create or replace function public.gerar_resumo_de_saltos(p_semana text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pessoas integer;
begin
  if p_semana !~ '^\d{4}-\d{2}$' then
    raise exception 'semana inválida: % (use IYYY-IW)', p_semana;
  end if;

  if exists (select 1 from public.resumos_de_saltos where semana = p_semana) then
    return jsonb_build_object('semana', p_semana, 'jaGerado', true);
  end if;

  with salvas as (
    -- cada gravação salva e medida, uma vez
    select distinct
      o.deezer_track_id, o.isrc, o.title, o.artist_name, o.cover_md5, o.last_rank
    from public.tracks t
    join public.observed_tracks o on o.isrc = upper(t.isrc)
    where t.isrc is not null
      and o.active
      and o.last_rank is not null
  ),
  medidas as (
    select
      s.*,
      h.rank as rank_semana,
      least(100, greatest(0, round(h.rank / 10000.0)))::int        as antes,
      least(100, greatest(0, round(s.last_rank / 10000.0)))::int   as agora
    from salvas s
    cross join lateral (
      select h.rank
        from public.track_popularity_history h
       where h.track_uri = 'deezer:track:' || s.deezer_track_id
         and h.recorded_at <= now() - interval '7 days'
       order by h.recorded_at desc
       limit 1
    ) h
  ),
  saltos as (
    select * from medidas
     where agora - antes >= 5
       and last_rank >= rank_semana * 1.2
  ),
  por_pessoa as (
    -- uma linha por pessoa e gravação
    select distinct on (t.user_id, s.deezer_track_id)
      t.user_id, s.deezer_track_id, s.isrc, s.title, s.artist_name,
      s.cover_md5, s.antes, s.agora, s.last_rank
    from saltos s
    join public.tracks t on upper(t.isrc) = s.isrc
    join auth.users u on u.id = t.user_id
    where coalesce(u.raw_app_meta_data->>'seeded', 'false') <> 'true'
      and t.claimedat <= now() - interval '7 days'
    order by t.user_id, s.deezer_track_id
  ),
  ranqueados as (
    select
      p.*,
      row_number() over (partition by p.user_id
                         order by p.agora - p.antes desc, p.last_rank desc) as n,
      count(*) over (partition by p.user_id) as total
    from por_pessoa p
  ),
  inseridas as (
    insert into public.notificacoes (user_id, tipo, dados, chave)
    select
      r.user_id,
      'saltos_semana',
      jsonb_build_object(
        'semana', p_semana,
        'total', max(r.total),
        'saltos', jsonb_agg(
          jsonb_build_object(
            'isrc', r.isrc,
            'titulo', r.title,
            'artista', r.artist_name,
            'capaMd5', r.cover_md5,
            'antes', r.antes,
            'agora', r.agora
          ) order by r.n
        )
      ),
      'saltos:' || r.user_id || ':' || p_semana
    from ranqueados r
    where r.n <= 3
    group by r.user_id
    on conflict (chave) do nothing
    returning 1
  )
  select count(*) into v_pessoas from inseridas;

  insert into public.resumos_de_saltos (semana, pessoas)
  values (p_semana, v_pessoas);

  return jsonb_build_object('semana', p_semana, 'pessoas', v_pessoas);
end;
$$;

revoke all on function public.gerar_resumo_de_saltos(text) from public, anon, authenticated;
grant execute on function public.gerar_resumo_de_saltos(text) to service_role;

-- ---------------------------------------------------------------------------
-- 4. Entrega — reivindicar e concluir
-- ---------------------------------------------------------------------------
-- `for update skip locked` + o status 'enviando' deixam dois processos
-- reivindicarem ao mesmo tempo sem mandar o mesmo e-mail duas vezes. Uma
-- linha presa em 'enviando' há mais de 10 minutos (processo derrubado no meio
-- do envio) volta para a fila; o backend manda com Idempotency-Key, então o
-- Resend não repete o que já tinha aceitado.

create or replace function public.reivindicar_notificacoes(p_limite integer default 20)
returns table (
  id                  bigint,
  tipo                text,
  dados               jsonb,
  tentativas          smallint,
  email               text,
  token               uuid,
  destino_username    text,
  ator_username       text,
  ator_nome           text,
  ator_avatar         text,
  ator_bio            text,
  ator_faixas         integer
)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
begin
  -- notícia velha
  update public.notificacoes
     set status = 'pulada', motivo = 'expirou na fila', atualizada_em = now()
   where status in ('pendente', 'enviando')
     and criada_em < now() - interval '3 days';

  -- presa em 'enviando' depois da última tentativa
  update public.notificacoes
     set status = 'falhou', atualizada_em = now()
   where status = 'enviando'
     and atualizada_em < now() - interval '10 minutes'
     and tentativas >= 3;

  -- quem não deve receber
  update public.notificacoes n
     set status = 'pulada',
         atualizada_em = now(),
         motivo = case
           when coalesce(u.raw_app_meta_data->>'seeded', 'false') = 'true'
             or u.email like '%.invalid'                       then 'perfil semeado'
           when u.email is null or u.email_confirmed_at is null then 'e-mail não confirmado'
           when n.tipo = 'seguidor' and p.seguidor = false      then 'desligou'
           when n.tipo = 'saltos_semana' and p.saltos = false   then 'desligou'
           else 'deixou de seguir'
         end
    from auth.users u
    left join public.preferencias_de_email p on p.user_id = u.id
   where n.status = 'pendente'
     and u.id = n.user_id
     and (
          coalesce(u.raw_app_meta_data->>'seeded', 'false') = 'true'
       or u.email like '%.invalid'
       or u.email is null
       or u.email_confirmed_at is null
       or (n.tipo = 'seguidor' and p.seguidor = false)
       or (n.tipo = 'saltos_semana' and p.saltos = false)
       or (n.tipo = 'seguidor' and not exists (
             select 1 from public.followers f
              where f.follower_id = n.ator_id and f.following_id = n.user_id))
     );

  -- o token do link de descadastro mora na linha de preferências
  insert into public.preferencias_de_email (user_id)
  select distinct n.user_id
    from public.notificacoes n
   where n.status = 'pendente'
  on conflict (user_id) do nothing;

  return query
  with alvo as (
    select n.id
      from public.notificacoes n
     where n.status = 'pendente'
        or (n.status = 'enviando' and n.atualizada_em < now() - interval '10 minutes')
     order by n.criada_em
     limit greatest(p_limite, 0)
     for update skip locked
  ),
  marcadas as (
    update public.notificacoes n
       set status = 'enviando',
           tentativas = n.tentativas + 1,
           atualizada_em = now()
      from alvo
     where n.id = alvo.id
    returning n.id, n.tipo, n.dados, n.tentativas, n.user_id, n.ator_id
  )
  select
    m.id, m.tipo, m.dados, m.tentativas,
    u.email::text,
    p.token,
    d.username::text,
    a.username::text,
    a.display_name::text,
    a.avatar_url::text,
    a.description::text,
    (select count(*) from public.tracks t where t.user_id = m.ator_id)::int
  from marcadas m
  join auth.users u on u.id = m.user_id
  join public.preferencias_de_email p on p.user_id = m.user_id
  left join public.profiles d on d.id = m.user_id
  left join public.profiles a on a.id = m.ator_id;
end;
$$;

-- p_erro null = enviada. Com erro, volta para a fila até a terceira tentativa.
create or replace function public.concluir_notificacao(p_id bigint, p_erro text default null)
returns void
language sql
security definer
set search_path = public
as $$
  update public.notificacoes
     set status = case
                    when p_erro is null then 'enviada'
                    when tentativas >= 3 then 'falhou'
                    else 'pendente'
                  end,
         enviada_em = case when p_erro is null then now() end,
         motivo = left(p_erro, 500),
         atualizada_em = now()
   where id = p_id
     and status = 'enviando';
$$;

revoke all on function public.reivindicar_notificacoes(integer) from public, anon, authenticated;
revoke all on function public.concluir_notificacao(bigint, text) from public, anon, authenticated;
grant execute on function public.reivindicar_notificacoes(integer) to service_role;
grant execute on function public.concluir_notificacao(bigint, text) to service_role;

-- ---------------------------------------------------------------------------
-- 5. Preferências
-- ---------------------------------------------------------------------------
-- Sem linha, tudo ligado. Os "salvar" recebem null para "não mexer".

create or replace function public.minhas_preferencias_de_email()
returns table (seguidor boolean, saltos boolean)
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(p.seguidor, true), coalesce(p.saltos, true)
    from (select auth.uid() as uid) eu
    left join public.preferencias_de_email p on p.user_id = eu.uid
   where eu.uid is not null
$$;

create or replace function public.salvar_minhas_preferencias_de_email(
  p_seguidor boolean default null,
  p_saltos boolean default null
)
returns table (seguidor boolean, saltos boolean)
language sql
security definer
set search_path = public
as $$
  insert into public.preferencias_de_email (user_id, seguidor, saltos)
  select auth.uid(), coalesce(p_seguidor, true), coalesce(p_saltos, true)
   where auth.uid() is not null
  on conflict (user_id) do update
     set seguidor = coalesce(p_seguidor, preferencias_de_email.seguidor),
         saltos = coalesce(p_saltos, preferencias_de_email.saltos),
         atualizada_em = now()
  returning seguidor, saltos
$$;

create or replace function public.preferencias_pelo_token(p_token uuid)
returns table (seguidor boolean, saltos boolean, username text)
language sql
stable
security definer
set search_path = public
as $$
  select p.seguidor, p.saltos, pr.username::text
    from public.preferencias_de_email p
    left join public.profiles pr on pr.id = p.user_id
   where p.token = p_token
$$;

create or replace function public.salvar_preferencias_pelo_token(
  p_token uuid,
  p_seguidor boolean default null,
  p_saltos boolean default null
)
returns table (seguidor boolean, saltos boolean)
language sql
security definer
set search_path = public
as $$
  update public.preferencias_de_email
     set seguidor = coalesce(p_seguidor, seguidor),
         saltos = coalesce(p_saltos, saltos),
         atualizada_em = now()
   where token = p_token
  returning seguidor, saltos
$$;

revoke all on function public.minhas_preferencias_de_email() from public, anon, authenticated;
revoke all on function public.salvar_minhas_preferencias_de_email(boolean, boolean) from public, anon, authenticated;
revoke all on function public.preferencias_pelo_token(uuid) from public, anon, authenticated;
revoke all on function public.salvar_preferencias_pelo_token(uuid, boolean, boolean) from public, anon, authenticated;
grant execute on function public.minhas_preferencias_de_email() to authenticated;
grant execute on function public.salvar_minhas_preferencias_de_email(boolean, boolean) to authenticated;
grant execute on function public.preferencias_pelo_token(uuid) to anon, authenticated;
grant execute on function public.salvar_preferencias_pelo_token(uuid, boolean, boolean) to anon, authenticated;
