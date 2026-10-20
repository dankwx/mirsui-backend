-- psql -v ON_ERROR_STOP=1 -f src/jobs/promocao.sql.test.sql
-- Exercita a migration 044 dentro de uma transação revertida.
--
-- A forma nova tem de promover exatamente o que o EXISTS da 025 promovia. O
-- teste compara as duas de dois jeitos: em faixas montadas para os casos de
-- borda e no banco inteiro em que rodar. Na produção, em 20/10/2026, a
-- comparação no catálogo inteiro (356 mil faixas) deu as mesmas 2 faixas.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

\ir ../../migrations/044_promocao_por_hash.sql
-- Segunda aplicação também deve ser segura.
\ir ../../migrations/044_promocao_por_hash.sql

-- Faixas salvas de teste, no nome de um perfil que já existe.
insert into public.tracks
  (track_url, track_uri, track_title, artist_name, album_name, popularity, user_id, position, isrc)
select v.url, 'teste:044:' || v.url, v.titulo, v.artista, 'Teste 044', 0, p.id, 0, v.isrc
from (select id from public.profiles limit 1) p,
     (values
       ('https://teste/044/1', 'Pelo ISRC', 'Ninguém Igual',   'TESTE0440001'),
       ('https://teste/044/2', 'Pelo Nome', 'Banda Teste 044', null),
       ('https://teste/044/3', 'Outra',     'Outro Artista',   'TESTE0440003')
     ) v(url, titulo, artista, isrc);

-- Ids acima de qualquer id real.
--   01 ISRC igual, nome diferente                 promovida
--   02 sem ISRC, nome igual em maiúsculas         promovida
--   03 ISRC diferente, nome igual                 promovida
--   04 sem ISRC, só o artista igual               fica
--   05 ISRC igual, mas já é acervo                fica (não conta)
--   06 source_list nulo, ISRC igual               promovida
--   07 sem ISRC, artista e título trocados        fica
insert into public.observed_tracks (deezer_track_id, title, artist_name, isrc, source_list)
values
  ('999999440001', 'Diferente', 'Diferente',       'TESTE0440001', 'chart:1'),
  ('999999440002', 'PELO NOME', 'BANDA TESTE 044', null,           'radio:1'),
  ('999999440003', 'Pelo Nome', 'Banda Teste 044', 'TESTE0449999', 'chart:2'),
  ('999999440004', 'Outra',     'Banda Teste 044', null,           'chart:3'),
  ('999999440005', 'Diferente', 'Diferente',       'TESTE0440001', 'acervo'),
  ('999999440006', 'Qualquer',  'Qualquer',        'TESTE0440003', null),
  ('999999440007', 'Banda Teste 044', 'Pelo Nome', null,           'chart:4');

-- O que a forma da 025 promoveria, no banco inteiro, antes da chamada.
create temp table esperadas on commit drop as
select o.deezer_track_id
from public.observed_tracks o
where o.source_list is distinct from 'acervo'
  and exists (
    select 1
    from public.tracks t
    where (t.isrc is not null and t.isrc = o.isrc)
       or (lower(t.artist_name) = lower(o.artist_name)
       and lower(t.track_title)  = lower(o.title))
  );

do $$
declare
  v_promovidas integer;
  v_esperadas  integer;
  v_faltou     integer;
  v_plano      text := '';
  r            record;
begin
  -- O plano tem de usar as duas subconsultas hash, não o nested loop.
  for r in execute $q$
    explain update public.observed_tracks o
    set source_list = 'acervo'
    where o.source_list is distinct from 'acervo'
      and (
        o.isrc in (select t.isrc from public.tracks t where t.isrc is not null)
        or (lower(o.artist_name), lower(o.title)) in (
          select lower(t.artist_name), lower(t.track_title) from public.tracks t)
      )
  $q$ loop
    v_plano := v_plano || r."QUERY PLAN" || E'\n';
  end loop;
  if (length(v_plano) - length(replace(v_plano, 'hashed SubPlan', ''))) / length('hashed SubPlan') <> 2 then
    raise exception 'plano sem as duas subconsultas hash:%', E'\n' || v_plano;
  end if;

  select count(*) into v_esperadas from esperadas;
  v_promovidas := public.promote_saved_observed_tracks();

  if v_promovidas <> v_esperadas then
    raise exception 'promovidas: a 025 promoveria %, a 044 promoveu %', v_esperadas, v_promovidas;
  end if;

  select count(*) into v_faltou
  from esperadas e
  join public.observed_tracks o using (deezer_track_id)
  where o.source_list is distinct from 'acervo';
  if v_faltou <> 0 then
    raise exception '% faixas que a 025 promoveria ficaram de fora', v_faltou;
  end if;

  -- Os casos de borda, um por um.
  for r in
    select o.deezer_track_id, o.source_list,
           o.deezer_track_id in ('999999440001', '999999440002', '999999440003',
                                 '999999440005', '999999440006') as acervo_esperado
    from public.observed_tracks o
    where o.deezer_track_id like '99999944000_'
  loop
    if (r.source_list is not distinct from 'acervo') <> r.acervo_esperado then
      raise exception 'faixa %: source_list %', r.deezer_track_id, coalesce(r.source_list, 'nulo');
    end if;
  end loop;

  if (select count(*) from esperadas where deezer_track_id like '99999944000_') <> 4 then
    raise exception 'a forma da 025 não promoveria as 4 faixas de teste esperadas';
  end if;

  -- Segunda chamada: nada mais a promover.
  v_promovidas := public.promote_saved_observed_tracks();
  if v_promovidas <> 0 then
    raise exception 'segunda chamada promoveu % faixas', v_promovidas;
  end if;

  raise notice 'promocao ok: % promovidas no banco (4 de teste), plano com hashed SubPlan', v_esperadas;
end $$;

rollback;
