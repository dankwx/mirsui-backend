-- psql -v ON_ERROR_STOP=1 -f src/jobs/vizinhanca.sql.test.sql
-- Exercita a migration 041 dentro de uma transação revertida.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

\ir ../../migrations/041_vizinhanca_dos_artistas.sql
-- Segunda aplicação também deve ser segura.
\ir ../../migrations/041_vizinhanca_dos_artistas.sql

-- A remontagem do fim da migration deixou as tabelas temporárias dela nesta
-- transação, com dono admin; a service role não as derruba. Na rodada cada
-- chamada é uma transação e isso não acontece.
drop table if exists pg_temp.viz_com_pagina, pg_temp.viz_alvo,
                     pg_temp.viz_um, pg_temp.viz_ponte, pg_temp.viz_dois;

-- Catálogo de teste, artistas 99900010xx:
--   A 01  a semente: duas faixas
--   B 02  duas faixas que vieram de A (linhagem)
--   C 03  uma faixa que veio de A
--   D 04  gravou com A (participação)
--   E 05  primeiro do /related de A
--   F 06  apareceu no rádio de A
--   G 07  só se liga a B (/related de B): segundo salto de A
--   H 08  só se liga a X, que não tem faixa: segundo salto de A pela ponte
--   K 09  no /related de A, mas a faixa não tem ISRC (não tem página)
--   Z 10  no /related de A, mas bloqueado
--   X 11  sem faixa nenhuma; o /related de A cita X e o de X cita H
-- A faixa de H tem 8 nomes (A a G entre eles) e não pode virar participação.
insert into public.observed_tracks
  (deezer_track_id, deezer_artist_id, isrc, title, artist_name, cover_md5, active, last_rank,
   recommendation_parent_track_id, contributors)
values
  ('9990010101', '9990001001', 'ZZVIZ0000011', 'A Um',   'Artista A', 'a1', true, 900000, null, null),
  ('9990010102', '9990001001', 'ZZVIZ0000012', 'A Dois', 'Artista A', 'a2', true, 100000, null, null);
insert into public.observed_tracks
  (deezer_track_id, deezer_artist_id, isrc, title, artist_name, cover_md5, active, last_rank,
   recommendation_parent_track_id, contributors)
values
  ('9990010201', '9990001002', 'ZZVIZ0000021', 'B Um',   'Artista B', 'b1', true, 500000, '9990010101', null),
  ('9990010202', '9990001002', 'ZZVIZ0000022', 'B Dois', 'Artista B', 'b2', true, 800000, '9990010101', null),
  ('9990010301', '9990001003', 'ZZVIZ0000031', 'C Um',   'Artista C', 'c1', true, 300000, '9990010102', null),
  ('9990010401', '9990001004', 'ZZVIZ0000041', 'D Um',   'Artista D', 'd1', true, 300000, null,
    jsonb_build_array(jsonb_build_object('id', '9990001004', 'name', 'Artista D'),
                      jsonb_build_object('id', '9990001001', 'name', 'Artista A'))),
  ('9990010501', '9990001005', 'ZZVIZ0000051', 'E Um',   'Artista E', 'e1', true, 300000, null, null),
  ('9990010601', '9990001006', 'ZZVIZ0000061', 'F Um',   'Artista F', 'f1', true, 300000, null, null),
  ('9990010701', '9990001007', 'ZZVIZ0000071', 'G Um',   'Artista G', 'g1', true, 300000, null, null),
  ('9990010801', '9990001008', 'ZZVIZ0000081', 'H Um',   'Artista H', 'h1', true, 300000, null,
    (select jsonb_agg(jsonb_build_object('id', '99900010' || lpad(i::text, 2, '0'), 'name', 'n' || i))
       from generate_series(1, 8) i)),
  ('9990010901', '9990001009', null,           'K Um',   'Artista K', 'k1', true, 300000, null, null),
  ('9990011001', '9990001010', 'ZZVIZ0000101', 'Z Um',   'Artista Z', 'z1', true, 300000, null, null);
insert into public.blocked_artists (deezer_artist_id, artist_name, reason)
  values ('9990001010', 'Artista Z', 'teste');

-- 1. O que a descoberta viu. O par A->E vem duas vezes no mesmo lote (não
-- pode derrubar o `on conflict`) e de novo noutro lote (conta como vista).
set local role service_role;
select public.record_artist_similarity(jsonb_build_array(
  jsonb_build_object('deezer_artist_id', '9990001001', 'similar_artist_id', '9990001005', 'source', 'related', 'position', 3),
  jsonb_build_object('deezer_artist_id', '9990001001', 'similar_artist_id', '9990001005', 'source', 'related', 'position', 5),
  jsonb_build_object('deezer_artist_id', '9990001001', 'similar_artist_id', '9990001009', 'source', 'related', 'position', 2),
  jsonb_build_object('deezer_artist_id', '9990001001', 'similar_artist_id', '9990001010', 'source', 'related', 'position', 1),
  jsonb_build_object('deezer_artist_id', '9990001001', 'similar_artist_id', '9990001011', 'source', 'related', 'position', 3),
  jsonb_build_object('deezer_artist_id', '9990001001', 'similar_artist_id', '9990001006', 'source', 'radio',   'position', 7),
  jsonb_build_object('deezer_artist_id', '9990001002', 'similar_artist_id', '9990001007', 'source', 'related', 'position', 0),
  jsonb_build_object('deezer_artist_id', '9990001011', 'similar_artist_id', '9990001008', 'source', 'related', 'position', 0),
  -- lixo: id que não é número, par consigo mesmo, fonte desconhecida
  jsonb_build_object('deezer_artist_id', 'abc',        'similar_artist_id', '9990001005', 'source', 'related', 'position', 0),
  jsonb_build_object('deezer_artist_id', '9990001001', 'similar_artist_id', '9990001001', 'source', 'related', 'position', 0),
  jsonb_build_object('deezer_artist_id', '9990001001', 'similar_artist_id', '9990001005', 'source', 'chart',   'position', 0)
));
select public.record_artist_similarity(jsonb_build_array(
  jsonb_build_object('deezer_artist_id', '9990001001', 'similar_artist_id', '9990001005', 'source', 'related', 'position', 0)
));
reset role;

do $$
declare s record; n integer;
begin
  select * into s from public.artist_similarity
  where deezer_artist_id = '9990001001' and similar_artist_id = '9990001005' and source = 'related';
  if s.seen <> 2 then raise exception 'vista duas vezes, contou %', s.seen; end if;
  if s.position <> 0 then raise exception 'posição devia ser a melhor (0): %', s.position; end if;
  select count(*) into n from public.artist_similarity
  where deezer_artist_id in ('abc', '9990001001') and similar_artist_id in ('9990001005', '9990001001')
    and (deezer_artist_id = 'abc' or similar_artist_id = '9990001001' or source <> 'related');
  if n <> 0 then raise exception 'lixo gravou: % linhas', n; end if;
end $$;

-- 2. Os pares e a vizinhança, pelo caminho da rodada: pares, depois lotes.
set local role service_role;
select public.rebuild_artist_pairs();
select public.rebuild_artist_neighbors(l, 3) from generate_series(0, 2) l;
reset role;

do $$
declare p record; v text;
begin
  -- Linhagem dos dois lados, com o peso das duas faixas.
  select * into p from public.artist_pairs where a = 9990001001 and b = 9990001002;
  if p is null then raise exception 'linhagem A->B não virou par'; end if;
  if abs(p.score - (2.0 + ln(2))) > 0.001 then raise exception 'peso A->B: %', p.score; end if;
  if not exists (select 1 from public.artist_pairs where a = 9990001002 and b = 9990001001) then
    raise exception 'par B->A (o outro lado) não existe';
  end if;
  -- Participação: principal com convidado; faixa de 8 nomes não conta.
  if not exists (select 1 from public.artist_pairs where a = 9990001001 and b = 9990001004) then
    raise exception 'participação A-D não virou par';
  end if;
  if exists (select 1 from public.artist_pairs where a = 9990001008 and b in (9990001001, 9990001002)) then
    raise exception 'faixa de 8 nomes virou participação';
  end if;
  if exists (select 1 from public.artist_pairs where a = 9990001002 and b = 9990001003) then
    raise exception 'convidado com convidado virou par';
  end if;
  -- Bloqueado não é vizinho de ninguém.
  if exists (select 1 from public.artist_pairs where b = 9990001010) then
    raise exception 'artista bloqueado virou par';
  end if;

  -- A: cinco diretos com página, na ordem do peso, e o segundo salto depois.
  select string_agg(neighbor_artist_id || ':' || hops, ' ' order by position) into v
  from public.artist_neighbors where deezer_artist_id = '9990001001';
  if v is distinct from '9990001005:1 9990001002:1 9990001003:1 9990001004:1 9990001006:1 9990001008:2 9990001007:2' then
    raise exception 'vizinhança de A: %', v;
  end if;
  -- Sem página (K) e bloqueado (Z) não têm linha própria nem aparecem.
  if exists (select 1 from public.artist_neighbors
             where deezer_artist_id in ('9990001009', '9990001010', '9990001011')
                or neighbor_artist_id in ('9990001009', '9990001010', '9990001011')) then
    raise exception 'K, Z ou X na vizinhança';
  end if;
  -- G, que só se liga a B, tem B como vizinho direto.
  if not exists (select 1 from public.artist_neighbors
                 where deezer_artist_id = '9990001007' and neighbor_artist_id = '9990001002' and hops = 1) then
    raise exception 'G sem B';
  end if;
end $$;

-- 3. O lote troca tudo que é dele, inclusive quem deixou de existir, e não
-- mexe nos outros lotes.
insert into public.artist_neighbors (deezer_artist_id, position, neighbor_artist_id, score, hops)
values ('9990001996', 1, '9990001001', 1, 1),  -- 9990001996 % 3 = 1
       ('9990001998', 1, '9990001001', 1, 1);  -- 9990001998 % 3 = 0
set local role service_role;
select public.rebuild_artist_neighbors(1, 3);
reset role;
do $$
begin
  if exists (select 1 from public.artist_neighbors where deezer_artist_id = '9990001996') then
    raise exception 'linha velha do lote sobreviveu';
  end if;
  if not exists (select 1 from public.artist_neighbors where deezer_artist_id = '9990001998') then
    raise exception 'o lote apagou linha de outro lote';
  end if;
  begin
    perform public.rebuild_artist_neighbors(3, 3);
    raise exception 'lote fora do intervalo passou';
  exception when raise_exception then
    if sqlerrm not like 'lote 3 de 3%' then raise; end if;
  end;
end $$;
delete from public.artist_neighbors where deezer_artist_id = '9990001998';

-- 4. A página: uma faixa por vizinho, a mais ouvida (B Dois, não B Um), até
-- seis, na ordem da vizinhança. Como anon, que é quem o site usa.
set local role anon;
do $$
declare p jsonb; r jsonb; v text;
begin
  p := public.get_track_page('ZZVIZ0000011');
  r := p->'relacionadas';
  if jsonb_typeof(r) <> 'array' then raise exception 'relacionadas não é lista: %', r; end if;
  select string_agg(x->>'isrc', ' ' order by o) into v
  from jsonb_array_elements(r) with ordinality as t(x, o);
  if v is distinct from 'ZZVIZ0000051 ZZVIZ0000022 ZZVIZ0000031 ZZVIZ0000041 ZZVIZ0000061 ZZVIZ0000081' then
    raise exception 'relacionadas de A Um: %', v;
  end if;
  if r->1->>'title' <> 'B Dois' or r->1->>'artist_name' <> 'Artista B' or r->1->>'cover_md5' <> 'b2' then
    raise exception 'campos da relacionada: %', r->1;
  end if;
  -- As chaves de antes continuam lá.
  if not (p ? 'observada' and p ? 'curva' and p ? 'salvamentos' and p ? 'quem_salvou') then
    raise exception 'a página perdeu chaves: %', (select array_agg(k) from jsonb_object_keys(p) k);
  end if;
  -- Faixa sem vizinhança: lista vazia, não null.
  if public.get_track_page('ZZVIZ0000101')->'relacionadas' <> '[]'::jsonb then
    raise exception 'sem vizinhança devia ser []';
  end if;
  -- anon lê a vizinhança, mas não o resto nem as funções da rodada.
  perform 1 from public.artist_neighbors limit 1;
  begin
    perform 1 from public.artist_similarity limit 1;
    raise exception 'anon leu artist_similarity';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from public.artist_pairs limit 1;
    raise exception 'anon leu artist_pairs';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.rebuild_artist_neighbors(0, 1);
    raise exception 'anon remontou a vizinhança';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.record_artist_similarity('[]'::jsonb);
    raise exception 'anon gravou semelhança';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

\echo 'vizinhanca.sql.test.sql: ok'
rollback;
