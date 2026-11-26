-- psql -v ON_ERROR_STOP=1 -f src/jobs/sininho.sql.test.sql
-- Exercita a migration 054 (o sino do header) dentro de uma transação
-- revertida. Precisa da 053 já aplicada.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

\ir ../../migrations/054_sininho.sql
\ir ../../migrations/054_sininho.sql

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_app_meta_data, created_at, updated_at)
values
  ('00000000-0000-4054-a000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'a@teste054.dev', now(), '{}', now(), now()),
  ('00000000-0000-4054-a000-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'b@teste054.dev', null,  '{}', now(), now()),
  ('00000000-0000-4054-a000-00000000000c', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'c@teste054.dev', now(), '{}', now(), now());
insert into public.profiles (id, username, display_name, avatar_url)
values
  ('00000000-0000-4054-a000-00000000000a', 'teste054a', 'Ana Teste', 'https://exemplo.dev/a.jpg'),
  ('00000000-0000-4054-a000-00000000000b', 'teste054b', null, null),
  ('00000000-0000-4054-a000-00000000000c', 'teste054c', 'Cora', null)
on conflict (id) do nothing;

-- A e C seguem B (e-mail de B não confirmado: o e-mail pula, o sino mostra)
insert into public.followers (follower_id, following_id) values
  ('00000000-0000-4054-a000-00000000000a', '00000000-0000-4054-a000-00000000000b');
insert into public.followers (follower_id, following_id) values
  ('00000000-0000-4054-a000-00000000000c', '00000000-0000-4054-a000-00000000000b');
-- um resumo de saltos para B, mais antigo
insert into public.notificacoes (user_id, tipo, dados, chave, criada_em)
values ('00000000-0000-4054-a000-00000000000b', 'saltos_semana',
        '{"total": 1, "saltos": [{"isrc": "BRXXX2400002", "titulo": "Poison", "antes": 9, "agora": 15}]}',
        'saltos:teste054:2026-47', now() - interval '3 days');
-- o e-mail de B é pulado (não confirmado); o sino ignora isso
select count(*) from public.reivindicar_notificacoes(50);
-- C deixa de seguir: some do sino
delete from public.followers
 where follower_id = '00000000-0000-4054-a000-00000000000c'
   and following_id = '00000000-0000-4054-a000-00000000000b';

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-4054-a000-00000000000b", "role": "authenticated"}';
do $$
declare v int; r record; v_lista jsonb;
begin
  select public.contar_notificacoes_nao_lidas() into v;
  if v <> 2 then raise exception 'sino: B devia ter 2 não lidas (A + resumo), tem %', v; end if;

  select jsonb_agg(to_jsonb(x)) into v_lista from public.minhas_notificacoes(20) x;
  if jsonb_array_length(v_lista) <> 2 then raise exception 'sino: lista devia ter 2, veio %', v_lista; end if;
  if v_lista->0->>'tipo' <> 'seguidor' or v_lista->0->>'ator_username' <> 'teste054a'
     or v_lista->0->>'ator_nome' <> 'Ana Teste' or (v_lista->0->>'lida')::boolean then
    raise exception 'sino: primeiro item errado %', v_lista->0;
  end if;
  if v_lista->1->>'tipo' <> 'saltos_semana' then raise exception 'sino: ordem errada %', v_lista; end if;

  select public.marcar_notificacoes_lidas() into v;
  if v <> 3 then raise exception 'sino: devia marcar 3 (inclui a de C, escondida), marcou %', v; end if;
  select public.contar_notificacoes_nao_lidas() into v;
  if v <> 0 then raise exception 'sino: depois de abrir devia ser 0, é %', v; end if;
  select count(*) into v from public.minhas_notificacoes(20) x where x.lida;
  if v <> 2 then raise exception 'sino: os 2 deviam vir como lidos'; end if;
end $$;

-- A não vê nada de B
set local request.jwt.claims = '{"sub": "00000000-0000-4054-a000-00000000000a", "role": "authenticated"}';
do $$
declare v int;
begin
  select count(*) into v from public.minhas_notificacoes(20);
  if v <> 0 then raise exception 'sino: A viu aviso de B'; end if;
  select public.marcar_notificacoes_lidas() into v;
  if v <> 0 then raise exception 'sino: A marcou aviso de B'; end if;
end $$;
reset role;

-- anon não chama nenhuma
set local role anon;
do $$
begin
  perform public.contar_notificacoes_nao_lidas();
  raise exception 'anon contou';
exception when insufficient_privilege then null;
end $$;
do $$
begin
  perform public.minhas_notificacoes(5);
  raise exception 'anon listou';
exception when insufficient_privilege then null;
end $$;
reset role;

-- o número para em 100
insert into public.notificacoes (user_id, tipo, dados, chave)
select '00000000-0000-4054-a000-00000000000a', 'saltos_semana', '{}', 'saltos:teste054:muitas:' || g
  from generate_series(1, 130) g;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-4054-a000-00000000000a", "role": "authenticated"}';
do $$
declare v int;
begin
  select public.contar_notificacoes_nao_lidas() into v;
  if v <> 100 then raise exception 'sino: contagem devia parar em 100, deu %', v; end if;
  select count(*) into v from public.minhas_notificacoes(500);
  if v <> 50 then raise exception 'sino: lista devia parar em 50, deu %', v; end if;
end $$;
reset role;

select 'sininho ok' as resultado;
rollback;
