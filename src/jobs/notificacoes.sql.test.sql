-- psql -v ON_ERROR_STOP=1 -f src/jobs/notificacoes.sql.test.sql
-- Exercita a migration 053 dentro de uma transação revertida.
--
-- Precisa de um banco com o esquema da produção e pelo menos dois perfis
-- reais com e-mail confirmado e um semeado (rodado em 26/11/2026 num Postgres
-- descartável com o esquema e os saves da produção).
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

\ir ../../migrations/053_notificacoes.sql
-- Segunda aplicação também deve ser segura.
\ir ../../migrations/053_notificacoes.sql

-- Fila vazia para o teste não depender do que já houver.
delete from public.notificacoes;
delete from public.resumos_de_saltos;

-- Três pessoas de teste: A e B reais e confirmadas, S semeada.
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_app_meta_data, created_at, updated_at)
values
  ('00000000-0000-4053-a000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'a@teste053.dev', now(), '{}', now(), now()),
  ('00000000-0000-4053-a000-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'b@teste053.dev', now(), '{}', now(), now()),
  ('00000000-0000-4053-a000-00000000000c', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'c@teste053.dev', null,  '{}', now(), now()),
  ('00000000-0000-4053-a000-00000000005e', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 's@seed.mirsui.invalid', now(), '{"seeded": true}', now(), now());
insert into public.profiles (id, username, display_name, description)
values
  ('00000000-0000-4053-a000-00000000000a', 'teste053a', 'Ana Teste', 'Garimpa shoegaze'),
  ('00000000-0000-4053-a000-00000000000b', 'teste053b', null, null),
  ('00000000-0000-4053-a000-00000000000c', 'teste053c', null, null),
  ('00000000-0000-4053-a000-00000000005e', 'teste053s', 'Semeado', null)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Gatilho
-- ---------------------------------------------------------------------------
-- A segue B: um aviso para B.
insert into public.followers (follower_id, following_id)
values ('00000000-0000-4053-a000-00000000000a', '00000000-0000-4053-a000-00000000000b');
-- deixa de seguir e segue de novo: continua um só
delete from public.followers
 where follower_id = '00000000-0000-4053-a000-00000000000a'
   and following_id = '00000000-0000-4053-a000-00000000000b';
insert into public.followers (follower_id, following_id)
values ('00000000-0000-4053-a000-00000000000a', '00000000-0000-4053-a000-00000000000b');
-- semeado segue A, A segue o semeado: nenhum aviso
insert into public.followers (follower_id, following_id)
values ('00000000-0000-4053-a000-00000000005e', '00000000-0000-4053-a000-00000000000a'),
       ('00000000-0000-4053-a000-00000000000a', '00000000-0000-4053-a000-00000000005e');
-- B segue C (e-mail não confirmado): aviso nasce, a entrega pula
insert into public.followers (follower_id, following_id)
values ('00000000-0000-4053-a000-00000000000b', '00000000-0000-4053-a000-00000000000c');

do $$
declare v int;
begin
  select count(*) into v from public.notificacoes where tipo = 'seguidor';
  if v <> 2 then raise exception 'gatilho: esperava 2 avisos de seguidor, veio %', v; end if;
  select count(*) into v from public.notificacoes
   where user_id = '00000000-0000-4053-a000-00000000000b'
     and ator_id = '00000000-0000-4053-a000-00000000000a';
  if v <> 1 then raise exception 'gatilho: seguir de novo duplicou (%)', v; end if;
end $$;

-- ---------------------------------------------------------------------------
-- Reivindicar
-- ---------------------------------------------------------------------------
create temp table lote on commit drop as
select * from public.reivindicar_notificacoes(10);

do $$
declare v int; r record;
begin
  select count(*) into v from lote;
  if v <> 1 then raise exception 'reivindicar: esperava 1 (o de B), veio %', v; end if;
  select * into r from lote;
  if r.email <> 'b@teste053.dev' or r.ator_username <> 'teste053a'
     or r.ator_nome <> 'Ana Teste' or r.token is null or r.destino_username <> 'teste053b'
     or r.tentativas <> 1 then
    raise exception 'reivindicar: linha errada %', row_to_json(r);
  end if;
  select count(*) into v from public.notificacoes
   where user_id = '00000000-0000-4053-a000-00000000000c' and status = 'pulada'
     and motivo = 'e-mail não confirmado';
  if v <> 1 then raise exception 'reivindicar: C devia ser pulada por e-mail não confirmado'; end if;
  -- reivindicar de novo não devolve o que está em 'enviando'
  select count(*) into v from public.reivindicar_notificacoes(10);
  if v <> 0 then raise exception 'reivindicar: devolveu a mesma linha duas vezes'; end if;
end $$;

-- erro → volta para a fila; terceira tentativa com erro → falhou
select public.concluir_notificacao((select id from lote), 'timeout');
do $$
declare v text;
begin
  select status into v from public.notificacoes where id = (select id from lote);
  if v <> 'pendente' then raise exception 'concluir: erro na 1ª devia voltar para pendente, ficou %', v; end if;
end $$;
select count(*) from public.reivindicar_notificacoes(10);
select public.concluir_notificacao((select id from lote), 'timeout');
select count(*) from public.reivindicar_notificacoes(10);
select public.concluir_notificacao((select id from lote), 'timeout');
do $$
declare r record;
begin
  select status, tentativas, motivo into r from public.notificacoes where id = (select id from lote);
  if r.status <> 'falhou' or r.tentativas <> 3 or r.motivo <> 'timeout' then
    raise exception 'concluir: 3 erros deviam dar falhou, ficou %', row_to_json(r);
  end if;
end $$;

-- envio certo
update public.notificacoes set status = 'pendente', tentativas = 0 where id = (select id from lote);
select count(*) from public.reivindicar_notificacoes(10);
select public.concluir_notificacao((select id from lote), null);
do $$
declare r record;
begin
  select status, enviada_em, motivo into r from public.notificacoes where id = (select id from lote);
  if r.status <> 'enviada' or r.enviada_em is null or r.motivo is not null then
    raise exception 'concluir: envio certo ficou %', row_to_json(r);
  end if;
end $$;

-- quem deixou de seguir antes do envio não gera e-mail
insert into public.followers (follower_id, following_id)
values ('00000000-0000-4053-a000-00000000000b', '00000000-0000-4053-a000-00000000000a');
delete from public.followers
 where follower_id = '00000000-0000-4053-a000-00000000000b'
   and following_id = '00000000-0000-4053-a000-00000000000a';
do $$
declare v int;
begin
  select count(*) into v from public.reivindicar_notificacoes(10);
  if v <> 0 then raise exception 'reivindicar: mandaria aviso de quem deixou de seguir'; end if;
  select count(*) into v from public.notificacoes
   where user_id = '00000000-0000-4053-a000-00000000000a' and motivo = 'deixou de seguir';
  if v <> 1 then raise exception 'reivindicar: devia marcar "deixou de seguir"'; end if;
end $$;

-- ---------------------------------------------------------------------------
-- Preferências
-- ---------------------------------------------------------------------------
-- pelo token, como anon
set local role anon;
do $$
declare r record; v_token uuid;
begin
  select seguidor, saltos into r from public.preferencias_pelo_token(gen_random_uuid());
  if found then raise exception 'token: token inventado devolveu linha'; end if;
end $$;
reset role;

create temp table tok on commit drop as
select token from public.preferencias_de_email
 where user_id = '00000000-0000-4053-a000-00000000000b';
grant select on tok to anon, authenticated;

set local role anon;
do $$
declare r record;
begin
  select * into r from public.salvar_preferencias_pelo_token((select token from tok), false, null);
  if r.seguidor <> false or r.saltos <> true then
    raise exception 'token: desligar seguidor ficou %', row_to_json(r);
  end if;
  select * into r from public.preferencias_pelo_token((select token from tok));
  if r.username <> 'teste053b' or r.seguidor <> false then
    raise exception 'token: leitura ficou %', row_to_json(r);
  end if;
end $$;
-- anon não lê a tabela nem chama o resto
do $$
begin
  perform 1 from public.preferencias_de_email limit 1;
  raise exception 'anon leu preferencias_de_email';
exception when insufficient_privilege then null;
end $$;
do $$
begin
  perform public.reivindicar_notificacoes(1);
  raise exception 'anon reivindicou';
exception when insufficient_privilege then null;
end $$;
reset role;

-- B desligou seguidor: o próximo aviso dele é pulado
insert into public.followers (follower_id, following_id)
values ('00000000-0000-4053-a000-00000000000c', '00000000-0000-4053-a000-00000000000b');
do $$
declare v int;
begin
  select count(*) into v from public.reivindicar_notificacoes(10);
  if v <> 0 then raise exception 'preferência: mandaria para quem desligou'; end if;
  select count(*) into v from public.notificacoes
   where user_id = '00000000-0000-4053-a000-00000000000b' and status = 'pulada' and motivo = 'desligou';
  if v <> 1 then raise exception 'preferência: devia marcar "desligou"'; end if;
end $$;

-- logada: A, sem linha ainda, vê tudo ligado e desliga os saltos
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-4053-a000-00000000000a", "role": "authenticated"}';
do $$
declare r record;
begin
  select * into r from public.minhas_preferencias_de_email();
  if r.seguidor <> true or r.saltos <> true then raise exception 'minhas: padrão devia ser tudo ligado, veio %', row_to_json(r); end if;
  select * into r from public.salvar_minhas_preferencias_de_email(null, false);
  if r.seguidor <> true or r.saltos <> false then raise exception 'minhas: salvar ficou %', row_to_json(r); end if;
  select * into r from public.minhas_preferencias_de_email();
  if r.saltos <> false then raise exception 'minhas: não persistiu'; end if;
end $$;
reset role;

-- ---------------------------------------------------------------------------
-- Resumo semanal
-- ---------------------------------------------------------------------------
select public.gerar_resumo_de_saltos('2026-48') as primeira;
select public.gerar_resumo_de_saltos('2026-48') as segunda;
do $$
begin
  perform public.gerar_resumo_de_saltos('48');
  raise exception 'semana inválida passou';
exception when raise_exception then
  if sqlerrm not like 'semana inválida%' then raise; end if;
end $$;

-- Ninguém semeado, no máximo 3 saltos por pessoa, todos na régua.
do $$
declare v int;
begin
  select count(*) into v
    from public.notificacoes n join auth.users u on u.id = n.user_id
   where n.tipo = 'saltos_semana' and u.raw_app_meta_data->>'seeded' = 'true';
  if v <> 0 then raise exception 'resumo: semeado recebeu'; end if;
  select count(*) into v from public.notificacoes
   where tipo = 'saltos_semana' and jsonb_array_length(dados->'saltos') not between 1 and 3;
  if v <> 0 then raise exception 'resumo: lista fora de 1..3'; end if;
  select count(*) into v
    from public.notificacoes n, jsonb_array_elements(n.dados->'saltos') s
   where n.tipo = 'saltos_semana' and (s->>'agora')::int - (s->>'antes')::int < 5;
  if v <> 0 then raise exception 'resumo: salto abaixo de 5 pontos'; end if;
end $$;

-- O que sairia nesta semana (para conferir à mão contra o aviso do feed)
select left(n.user_id::text, 8) as pessoa, n.dados->>'total' as total,
       (select string_agg(s->>'titulo' || ' ' || (s->>'antes') || '→' || (s->>'agora'), ' | ')
          from jsonb_array_elements(n.dados->'saltos') s) as saltos
  from public.notificacoes n
 where n.tipo = 'saltos_semana'
 order by 1;

-- O maior salto do resumo é o mesmo do aviso do feed (050), para quem tem
-- save com mais de 7 dias.
do $$
declare r record; v_feed record; v_erros int := 0;
begin
  for r in select user_id, dados from public.notificacoes where tipo = 'saltos_semana' loop
    perform set_config('request.jwt.claims', json_build_object('sub', r.user_id, 'role', 'authenticated')::text, true);
    select * into v_feed from public.get_my_track_jump();
    if v_feed.isrc is distinct from (r.dados->'saltos'->0->>'isrc') then
      raise notice 'diferente do feed: % feed=% resumo=%', left(r.user_id::text, 8), v_feed.title, r.dados->'saltos'->0->>'titulo';
      v_erros := v_erros + 1;
    end if;
  end loop;
  raise notice 'resumo x feed: % diferença(s)', v_erros;
end $$;

rollback;
