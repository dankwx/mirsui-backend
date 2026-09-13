-- psql -v ON_ERROR_STOP=1 -f src/jobs/catalogAlbum.sql.test.sql
-- Exercita a migration real e os RPCs dentro de uma transação revertida.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

insert into public.observed_tracks
  (deezer_track_id, title, artist_name, source_list, origin_list, deezer_album_id)
values
  ('__album_test_recover', 'Teste', 'Teste', 'acervo', 'album:12345', null),
  ('__album_test_existing', 'Teste', 'Teste', 'album:12345', 'album:12345', '54321'),
  ('__album_test_invalid', 'Teste', 'Teste', 'album:123bad', 'album:123bad', null),
  ('__album_test_old', 'Teste', 'Teste', 'album:23456', null, null),
  ('__album_test_origin', 'Teste', 'Teste', 'album:34567', 'radio:8', null);

create temporary table album_before on commit drop as
  select deezer_track_id, to_jsonb(o) - 'deezer_album_id' as unchanged
  from public.observed_tracks o;
create temporary table history_before on commit drop as
  select count(*) as n from public.track_popularity_history;

\ir ../../migrations/20260913160700_preservar_album_e_recuperar_associacoes.sql
-- Segunda aplicação também deve ser segura.
\ir ../../migrations/20260913160700_preservar_album_e_recuperar_associacoes.sql

do $$
begin
  if (select deezer_album_id from public.observed_tracks where deezer_track_id='__album_test_recover') is distinct from '12345'
    then raise exception 'Não recuperou a origem de álbum'; end if;
  if (select deezer_album_id from public.observed_tracks where deezer_track_id='__album_test_existing') is distinct from '54321'
    then raise exception 'Sobrescreveu associação existente'; end if;
  if (select deezer_album_id from public.observed_tracks where deezer_track_id='__album_test_old') is distinct from '23456'
    then raise exception 'Não recuperou source_list legado'; end if;
  if exists(select 1 from public.observed_tracks where deezer_track_id in ('__album_test_invalid','__album_test_origin') and deezer_album_id is not null)
    then raise exception 'Recuperou origem inválida ou contraditória'; end if;
  if exists(select 1 from public.observed_tracks o join album_before b using(deezer_track_id)
    where (to_jsonb(o) - 'deezer_album_id') is distinct from b.unchanged)
    then raise exception 'Recuperação modificou dados além do álbum'; end if;
  if (select count(*) from public.track_popularity_history) <> (select n from history_before)
    then raise exception 'Recuperação alterou histórico'; end if;
  if has_function_privilege('anon', 'public.record_observations(jsonb)', 'execute')
    or has_function_privilege('authenticated', 'public.record_observations(jsonb)', 'execute')
    or not has_function_privilege('service_role', 'public.record_observations(jsonb)', 'execute')
    then raise exception 'Privilégios do RPC incorretos'; end if;
end $$;

set local role service_role;
select public.record_observations('[
 {"deezer_track_id":"__album_test_rpc","deezer_artist_id":"7","deezer_album_id":"12345","title":"Teste","artist_name":"Teste","source_list":"acervo","rank":100,"popularity":1}
]'::jsonb);
do $$ begin
  if (select deezer_album_id from public.observed_tracks where deezer_track_id='__album_test_rpc') is distinct from '12345'
    then raise exception 'INSERT do RPC perdeu álbum'; end if;
end $$;

-- Metadados ausentes ou vazios não apagam a associação válida.
select public.record_observations('[{"deezer_track_id":"__album_test_rpc","title":"Teste","artist_name":"Teste","rank":100,"popularity":1}]');
select public.record_observations('[{"deezer_track_id":"__album_test_rpc","deezer_album_id":"","title":"Teste","artist_name":"Teste","rank":100,"popularity":1}]');
do $$ begin
  if (select deezer_album_id from public.observed_tracks where deezer_track_id='__album_test_rpc') is distinct from '12345'
    then raise exception 'Resposta parcial apagou álbum'; end if;
end $$;

-- A consulta individual pode corrigir uma associação de álbum antiga.
select public.record_observations('[{"deezer_track_id":"__album_test_rpc","deezer_album_id":"67890","title":"Teste","artist_name":"Teste","source_list":"chart:0","rank":100,"popularity":1}]');
do $$ begin
  if (select deezer_album_id from public.observed_tracks where deezer_track_id='__album_test_rpc') is distinct from '67890'
    then raise exception 'UPDATE não corrigiu álbum antigo'; end if;
  if (select source_list from public.observed_tracks where deezer_track_id='__album_test_rpc') is distinct from 'acervo'
    then raise exception 'UPDATE alterou procedência'; end if;
  if (select count(*) from public.track_popularity_history where track_uri='deezer:track:__album_test_rpc') <> 1
    then raise exception 'Mesmo rank produziu histórico duplicado'; end if;
end $$;
reset role;
rollback;
\echo 'PASS: persistência, recuperação idempotente, histórico e permissões; alterações revertidas'
