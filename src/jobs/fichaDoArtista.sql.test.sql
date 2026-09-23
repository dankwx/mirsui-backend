-- psql -v ON_ERROR_STOP=1 -f src/jobs/fichaDoArtista.sql.test.sql
-- Exercita a migration 040 dentro de uma transação revertida.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

\ir ../../migrations/040_ficha_do_artista.sql
-- Segunda aplicação também deve ser segura.
\ir ../../migrations/040_ficha_do_artista.sql

-- Catálogo de teste. A: principal, com uma faixa salva. B: principal, com um
-- convidado C que não tem faixa própria no catálogo.
set local role service_role;
select public.record_observations(jsonb_build_array(
  jsonb_build_object(
    'deezer_track_id', '9990000101', 'deezer_artist_id', '9990000001', 'deezer_album_id', '9990000201',
    'isrc', 'ZZART0000001', 'title', 'Faixa Um', 'artist_name', 'Artista A',
    'album_name', 'Álbum Um', 'source_list', 'chart:0', 'rank', 800000, 'popularity', 80,
    'release_date', '2021-03-04'),
  jsonb_build_object(
    'deezer_track_id', '9990000102', 'deezer_artist_id', '9990000001', 'deezer_album_id', '9990000202',
    'isrc', 'ZZART0000002', 'title', 'Faixa Dois', 'artist_name', 'Artista A',
    'album_name', 'Álbum Dois', 'source_list', 'acervo', 'rank', 100000, 'popularity', 10),
  jsonb_build_object(
    'deezer_track_id', '9990000103', 'deezer_artist_id', '9990000002', 'deezer_album_id', '9990000203',
    'isrc', 'ZZART0000003', 'title', 'Faixa Três', 'artist_name', 'Artista B',
    'album_name', 'Álbum Três', 'source_list', 'chart:0', 'rank', 500000, 'popularity', 50,
    'contributors', jsonb_build_array(
      jsonb_build_object('id', '9990000002', 'name', 'Artista B'),
      jsonb_build_object('id', '9990000003', 'name', 'Convidada C')))
));
reset role;

-- 1. A fila: A (faixa salva) antes de B, e C (só convidado) depois dos dois.
create temporary table fila1 on commit drop as
  select q.deezer_artist_id, row_number() over () as pos
  from public.artist_details_queue(1000000, 30) q;

do $$
declare a bigint; b bigint; c bigint; n integer;
begin
  select pos into a from fila1 where deezer_artist_id = '9990000001';
  select pos into b from fila1 where deezer_artist_id = '9990000002';
  select pos into c from fila1 where deezer_artist_id = '9990000003';
  if a is null or b is null or c is null then raise exception 'fila sem A, B ou C: % % %', a, b, c; end if;
  if not (a < b and b < c) then raise exception 'ordem da fila errada: A=% B=% C=%', a, b, c; end if;
  select public.artist_details_queue_size(30) into n;
  if n <> (select count(*) from fila1) then raise exception 'tamanho da fila (%) difere da fila', n; end if;
end $$;

-- 2. Sem ficha, a página é o recorte do catálogo, como na 038.
do $$
declare p jsonb;
begin
  p := public.get_artist_page('9990000001');
  if p->>'name' is distinct from 'Artista A' then raise exception 'nome sem ficha: %', p->>'name'; end if;
  if (p->>'ficha')::boolean then raise exception 'ficha sem ficha'; end if;
  if jsonb_array_length(p->'top') <> 2 then raise exception 'top sem ficha: %', p->'top'; end if;
  if jsonb_array_length(p->'albums') <> 2 then raise exception 'álbuns sem ficha: %', p->'albums'; end if;
  if p->'albums'->0->>'record_type' is not null then raise exception 'tipo inventado sem ficha'; end if;
  if p->>'nb_fan' is not null then raise exception 'fãs inventados sem ficha'; end if;
end $$;

-- 3. A ficha de A: uma faixa medida (rank velho na ficha), uma que o
-- catálogo não mede, e dois lançamentos. Mais uma linha com lixo, que não
-- pode derrubar o lote.
set local role service_role;
select public.record_artist_details(jsonb_build_array(
  jsonb_build_object(
    'deezer_artist_id', '9990000001', 'name', 'Artista A (Deezer)',
    'picture_md5', '0123456789abcdef0123456789abcdef', 'nb_fan', 1234, 'nb_album', 2,
    'albums_total', 2,
    'top', jsonb_build_array(
      jsonb_build_object('deezer_track_id', '9990000101', 'title', 'Faixa Um', 'deezer_artist_id', '9990000001',
        'artist_name', 'Artista A', 'deezer_album_id', '9990000201', 'album_name', 'Álbum Um',
        'cover_md5', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'duration_seconds', 201, 'explicit_lyrics', false,
        'rank', 810000, 'contributors', jsonb_build_array(jsonb_build_object('id', '9990000001', 'name', 'Artista A'))),
      jsonb_build_object('deezer_track_id', '9990000199', 'title', 'Hit Fora do Catálogo', 'deezer_artist_id', '9990000001',
        'artist_name', 'Artista A', 'deezer_album_id', '9990000299', 'album_name', 'Álbum Hit',
        'cover_md5', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'duration_seconds', 180, 'explicit_lyrics', true,
        'rank', 700000, 'contributors', jsonb_build_array(
          jsonb_build_object('id', '9990000001', 'name', 'Artista A'),
          jsonb_build_object('id', '9990000004', 'name', 'Convidado D')))),
    'albums', jsonb_build_array(
      jsonb_build_object('deezer_album_id', '9990000299', 'album_name', 'Álbum Hit',
        'cover_md5', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'record_type', 'single', 'release_date', '2024-01-02'),
      jsonb_build_object('deezer_album_id', '9990000201', 'album_name', 'Álbum Um',
        'cover_md5', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'record_type', 'album', 'release_date', '0000-00-00'))
  ),
  jsonb_build_object('deezer_artist_id', 'não-é-id', 'name', 'lixo'),
  jsonb_build_object('deezer_artist_id', '9990000005', 'name', 'Lixo nos números',
    'picture_md5', 'x', 'nb_fan', 'muitos', 'nb_album', -1, 'top', 'não é lista', 'albums', 7)
));
reset role;

do $$
declare d record;
begin
  select * into d from public.artist_details where deezer_artist_id = '9990000005';
  if d is null then raise exception 'linha com números inválidos não gravou'; end if;
  if d.picture_md5 is not null or d.nb_fan is not null or d.nb_album is not null then
    raise exception 'lixo passou: % % %', d.picture_md5, d.nb_fan, d.nb_album;
  end if;
  if d.top <> '[]'::jsonb or d.albums <> '[]'::jsonb then raise exception 'lista inválida virou lista'; end if;
  if exists (select 1 from public.artist_details where deezer_artist_id = 'não-é-id') then
    raise exception 'id inválido gravou';
  end if;
end $$;

-- 4. Com ficha: foto, fãs e tipo; a faixa medida usa a medição do dia
-- (rank 800.000, audiência 80, ISRC, data), a de fora usa a ficha, e a
-- faixa salva que o top não traz continua na lista.
set local role anon;
do $$
declare p jsonb; t jsonb;
begin
  p := public.get_artist_page('9990000001');
  if not (p->>'ficha')::boolean then raise exception 'ficha não apareceu'; end if;
  if p->>'name' is distinct from 'Artista A (Deezer)' then raise exception 'nome: %', p->>'name'; end if;
  if p->>'picture_md5' is distinct from '0123456789abcdef0123456789abcdef' then raise exception 'foto'; end if;
  if (p->>'nb_fan')::integer <> 1234 then raise exception 'fãs'; end if;
  if jsonb_array_length(p->'top') <> 3 then raise exception 'top com ficha: %', p->'top'; end if;

  t := p->'top'->0;
  if t->>'deezer_track_id' <> '9990000101' then raise exception 'primeira: %', t; end if;
  if t->>'isrc' is distinct from 'ZZART0000001' then raise exception 'isrc da medida: %', t; end if;
  if (t->>'last_popularity')::integer <> 80 then raise exception 'audiência da medida: %', t; end if;
  if t->>'release_date' is distinct from '2021-03-04' then raise exception 'data da medida: %', t; end if;
  if (t->>'duration_seconds')::integer <> 201 then raise exception 'duração da ficha: %', t; end if;
  if not (t->>'medida')::boolean then raise exception 'medida'; end if;

  t := p->'top'->1;
  if t->>'deezer_track_id' <> '9990000199' then raise exception 'segunda: %', t; end if;
  if t->>'isrc' is not null then raise exception 'isrc inventado: %', t; end if;
  if (t->>'last_popularity')::integer <> 70 then raise exception 'audiência pela ficha: %', t; end if;
  if (t->>'medida')::boolean then raise exception 'não medida marcada como medida'; end if;
  if jsonb_array_length(t->'contributors') <> 2 then raise exception 'participações: %', t; end if;

  t := p->'top'->2;
  if t->>'deezer_track_id' <> '9990000102' then raise exception 'salva sumiu: %', p->'top'; end if;

  if jsonb_array_length(p->'albums') <> 2 then raise exception 'álbuns com ficha: %', p->'albums'; end if;
  if p->'albums'->0->>'record_type' <> 'single' then raise exception 'tipo: %', p->'albums'; end if;
  if p->'albums'->0->>'release_date' <> '2024-01-02' then raise exception 'data do álbum: %', p->'albums'; end if;
  if p->'albums'->1->>'release_date' is not null then raise exception 'data 0000-00-00 passou'; end if;

  -- Artista desconhecido: null, e o site cai no Deezer.
  if public.get_artist_page('9990009999') is not null then raise exception 'desconhecido não é null'; end if;
end $$;

-- 5. anon lê a tabela, mas não escreve nem mexe na fila.
select count(*) from public.artist_details where deezer_artist_id = '9990000001';
do $$
begin
  begin
    insert into public.artist_details (deezer_artist_id) values ('9990000077');
    raise exception 'anon inseriu';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.record_artist_details('[]'::jsonb);
    raise exception 'anon gravou ficha';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.artist_details_queue(10, 30);
    raise exception 'anon leu a fila';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- 6. Com ficha, A sai da fila; com a ficha vencida, volta. Artista bloqueado
-- não entra.
insert into public.blocked_artists (deezer_artist_id, artist_name, reason)
  values ('9990000002', 'Artista B', 'teste');
do $$
begin
  if exists (select 1 from public.artist_details_queue(1000000, 30) where deezer_artist_id = '9990000001') then
    raise exception 'A continua na fila com ficha nova';
  end if;
  if exists (select 1 from public.artist_details_queue(1000000, 30) where deezer_artist_id = '9990000002') then
    raise exception 'artista bloqueado na fila';
  end if;
  update public.artist_details set checked_at = now() - interval '31 days' where deezer_artist_id = '9990000001';
  if not exists (select 1 from public.artist_details_queue(1000000, 30) where deezer_artist_id = '9990000001') then
    raise exception 'ficha vencida não voltou à fila';
  end if;
end $$;

-- 7. Convidado sem faixa própria: a ficha basta para a página.
set local role service_role;
select public.record_artist_details(jsonb_build_array(jsonb_build_object(
  'deezer_artist_id', '9990000003', 'name', 'Convidada C', 'nb_fan', 5, 'albums_total', 0,
  'top', jsonb_build_array(jsonb_build_object('deezer_track_id', '9990000103', 'title', 'Faixa Três',
    'deezer_artist_id', '9990000002', 'artist_name', 'Artista B', 'rank', 490000)),
  'albums', '[]'::jsonb
)));

-- 8. Artista que saiu do Deezer: a ficha antiga fica guardada, a página volta
-- ao recorte do catálogo.
select public.record_artist_details(jsonb_build_array(jsonb_build_object(
  'deezer_artist_id', '9990000001', 'missing', true
)));
reset role;

do $$
declare p jsonb; d record;
begin
  p := public.get_artist_page('9990000003');
  if p->>'name' is distinct from 'Convidada C' then raise exception 'convidada sem página: %', p; end if;
  if p->'top'->0->>'isrc' is distinct from 'ZZART0000003' then raise exception 'isrc da convidada: %', p; end if;

  select * into d from public.artist_details where deezer_artist_id = '9990000001';
  if not d.missing or d.nb_fan is distinct from 1234 or jsonb_array_length(d.top) <> 2 then
    raise exception 'missing apagou a ficha antiga';
  end if;
  p := public.get_artist_page('9990000001');
  if (p->>'ficha')::boolean or p->>'name' is distinct from 'Artista A' then
    raise exception 'página usou ficha de artista que saiu: %', p;
  end if;
end $$;

\echo 'fichaDoArtista.sql.test: ok'
rollback;
