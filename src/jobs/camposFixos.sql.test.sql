-- psql -v ON_ERROR_STOP=1 -f src/jobs/camposFixos.sql.test.sql
-- Exercita a migration 037 dentro de uma transação revertida.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

\ir ../../migrations/037_campos_fixos_da_faixa.sql
-- Segunda aplicação também deve ser segura.
\ir ../../migrations/037_campos_fixos_da_faixa.sql

create temporary table history_before on commit drop as
  select count(*) as n from public.track_popularity_history;
grant select on history_before to service_role;

set local role service_role;

-- 1. Faixa nova com a resposta completa de /track/{id}.
select public.record_observations(jsonb_build_array(jsonb_build_object(
  'deezer_track_id', '__fixos_1', 'deezer_artist_id', '1', 'deezer_album_id', '10',
  'isrc', 'ZZFIX0000001', 'title', 'Teste', 'artist_name', 'Artista',
  'source_list', 'chart:0', 'rank', 100000, 'popularity', 40,
  'duration_seconds', 215, 'explicit_lyrics', true, 'has_preview', true,
  'release_date', '2024-05-17',
  'contributors', jsonb_build_array(
    jsonb_build_object('id', '1', 'name', 'Artista'),
    jsonb_build_object('id', '2', 'name', 'Convidada'))
)));

do $$
declare o record;
begin
  select * into o from public.observed_tracks where deezer_track_id = '__fixos_1';
  if o.duration_seconds is distinct from 215 then raise exception 'duração não gravou'; end if;
  if o.explicit_lyrics is distinct from true then raise exception 'explícito não gravou'; end if;
  if o.has_preview is distinct from true then raise exception 'prévia não gravou'; end if;
  if o.release_date is distinct from date '2024-05-17' then raise exception 'data não gravou'; end if;
  if jsonb_array_length(o.contributors) <> 2 then raise exception 'participações não gravaram'; end if;
end $$;

-- 2. A medição por álbum no dia seguinte: sem data, sem participações, e a
-- prévia saiu do ar. O que o álbum não diz fica; o que ele diz vale.
select public.record_observations(jsonb_build_array(jsonb_build_object(
  'deezer_track_id', '__fixos_1', 'deezer_album_id', '10', 'title', 'Teste',
  'artist_name', 'Artista', 'source_list', 'chart:0', 'rank', 100500, 'popularity', 40,
  'duration_seconds', 215, 'explicit_lyrics', true, 'has_preview', false,
  'release_date', null, 'contributors', null
)));

do $$
declare o record;
begin
  select * into o from public.observed_tracks where deezer_track_id = '__fixos_1';
  if o.release_date is distinct from date '2024-05-17' then raise exception 'álbum apagou a data'; end if;
  if jsonb_array_length(o.contributors) <> 2 then raise exception 'álbum apagou as participações'; end if;
  if o.has_preview is distinct from false then raise exception 'prévia não atualizou'; end if;
  if o.last_rank is distinct from 100500 then raise exception 'rank não atualizou'; end if;
end $$;

-- 3. O backend antigo, que não manda chave nenhuma nova, não apaga nada.
select public.record_observations(jsonb_build_array(jsonb_build_object(
  'deezer_track_id', '__fixos_1', 'title', 'Teste', 'artist_name', 'Artista',
  'source_list', 'chart:0', 'rank', 100500, 'popularity', 40
)));

do $$
declare o record;
begin
  select * into o from public.observed_tracks where deezer_track_id = '__fixos_1';
  if o.duration_seconds is distinct from 215 or o.explicit_lyrics is distinct from true
     or o.has_preview is distinct from false or o.release_date is null
     or o.contributors is null
    then raise exception 'payload antigo apagou campo fixo'; end if;
end $$;

-- 4. Lixo do Deezer não derruba o lote: as três linhas entram, com os campos
-- inválidos em null.
select public.record_observations(jsonb_build_array(
  jsonb_build_object('deezer_track_id', '__fixos_2', 'title', 'T', 'artist_name', 'A',
    'source_list', 'chart:0', 'rank', 1, 'popularity', 1,
    'release_date', '0000-00-00', 'duration_seconds', 0, 'contributors', '[]'::jsonb),
  jsonb_build_object('deezer_track_id', '__fixos_3', 'title', 'T', 'artist_name', 'A',
    'source_list', 'chart:0', 'rank', 1, 'popularity', 1,
    'release_date', '2001-02-30', 'duration_seconds', 'abc', 'explicit_lyrics', 'sim'),
  jsonb_build_object('deezer_track_id', '__fixos_4', 'title', 'T', 'artist_name', 'A',
    'source_list', 'chart:0', 'rank', 1, 'popularity', 1,
    'release_date', 'ontem', 'has_preview', 1, 'contributors', 'x')
));

do $$
begin
  if (select count(*) from public.observed_tracks
       where deezer_track_id in ('__fixos_2', '__fixos_3', '__fixos_4')) <> 3
    then raise exception 'lote com lixo não entrou inteiro'; end if;
  if exists (select 1 from public.observed_tracks
              where deezer_track_id in ('__fixos_2', '__fixos_3', '__fixos_4')
                and (release_date is not null or duration_seconds is not null
                     or explicit_lyrics is not null or has_preview is not null
                     or contributors is not null))
    then raise exception 'valor inválido foi gravado'; end if;
end $$;

-- 5. Histórico continua por delta e com um ponto por faixa por dia (009): o
-- ponto da faixa nova e as 3 do lote de lixo. A mudança de rank no MESMO dia
-- não grava segundo ponto, e a chamada sem mudança também não.
do $$
begin
  if (select count(*) from public.track_popularity_history) - (select n from history_before) <> 4
    then raise exception 'histórico por delta mudou de comportamento'; end if;
end $$;

-- 6. A ficha dos álbuns (etapa 4b). Três faixas do álbum 20 sem gênero, uma
-- delas salva; o álbum 21 só com uma faixa; a do álbum 22 já tem tudo.
reset role;
insert into public.observed_tracks
  (deezer_track_id, deezer_album_id, title, artist_name, source_list, genre, release_date)
values
  ('__ficha_a', '__alb20', 'T', 'A', 'radio:1', null, null),
  ('__ficha_b', '__alb20', 'T', 'A', 'album:20', null, date '2011-01-01'),
  ('__ficha_c', '__alb20', 'T', 'A', 'acervo', 'Rock', null),
  ('__ficha_d', '__alb21', 'T', 'A', 'radio:1', null, null),
  ('__ficha_e', '__alb22', 'T', 'A', 'chart:0', 'Pop', date '2020-01-01');
set local role service_role;

do $$
declare fila text[];
begin
  select array_agg(deezer_album_id) into fila
  from public.album_details_queue(100000) where deezer_album_id like '\_\_alb%';
  if fila is distinct from array['__alb20', '__alb21']
    then raise exception 'fila da ficha errada: %', fila; end if;
  if (select count(*) from public.album_details_queue(1)) <> 1
    then raise exception 'fila não respeitou o limite'; end if;
end $$;

-- O álbum 20 respondeu com gênero e data; o 21 existe mas sem gênero.
do $$
begin
  if public.record_album_details(jsonb_build_array(
       jsonb_build_object('deezer_album_id', '__alb20', 'genre', 'Electro', 'release_date', '2010-06-01'),
       jsonb_build_object('deezer_album_id', '__alb21', 'genre', null, 'release_date', '0000-00-00')
     )) <> 4
    then raise exception 'ficha não marcou as quatro faixas'; end if;
end $$;

do $$
begin
  if (select genre from public.observed_tracks where deezer_track_id = '__ficha_a') is distinct from 'Electro'
    then raise exception 'ficha não deu gênero'; end if;
  if (select release_date from public.observed_tracks where deezer_track_id = '__ficha_a') is distinct from date '2010-06-01'
    then raise exception 'ficha não deu data'; end if;
  if (select release_date from public.observed_tracks where deezer_track_id = '__ficha_b') is distinct from date '2011-01-01'
    then raise exception 'ficha sobrescreveu a data da faixa'; end if;
  if (select genre from public.observed_tracks where deezer_track_id = '__ficha_c') is distinct from 'Rock'
    then raise exception 'ficha sobrescreveu o gênero do chart'; end if;
  if exists (select 1 from public.album_details_queue(100000) where deezer_album_id like '\_\_alb%')
    then raise exception 'álbum consultado continuou na fila'; end if;
end $$;

-- 7. A página lê os campos novos, como anônima.
reset role;
set local role anon;
do $$
declare p jsonb;
begin
  p := public.get_track_page('ZZFIX0000001');
  if p->'observada'->>'duration_seconds' is distinct from '215' then raise exception 'página sem duração'; end if;
  if p->'observada'->>'release_date' is distinct from '2024-05-17' then raise exception 'página sem data'; end if;
  if p->'observada'->>'has_preview' is distinct from 'false' then raise exception 'página sem prévia'; end if;
  if jsonb_array_length(p->'observada'->'contributors') <> 2 then raise exception 'página sem participações'; end if;
end $$;

-- 8. Permissões: anon lê a página e não grava medição nem ficha.
do $$
begin
  begin
    perform public.record_observations('[]'::jsonb);
    raise exception 'anon conseguiu chamar record_observations';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.record_album_details('[]'::jsonb);
    raise exception 'anon conseguiu chamar record_album_details';
  exception when insufficient_privilege then null;
  end;
end $$;

reset role;
rollback;
\echo 'camposFixos.sql.test.sql: ok'
