-- psql -v ON_ERROR_STOP=1 -f src/jobs/cadencia.sql.test.sql
-- Exercita a migration 043 dentro de uma transação revertida.
--
-- A classificação com stake e com faixa salva não muda desde a 035 e foi
-- conferida contra ela na cópia do catálogo de 18/10/2026 (329.667 faixas,
-- zero diferenças). Aqui fica o que a 043 mexe: o fim do lote achado antes,
-- a faixa de PK no UPDATE e o cursor vazio.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

\ir ../../migrations/043_cadencia_pela_faixa_da_pk.sql
-- Segunda aplicação também deve ser segura.
\ir ../../migrations/043_cadencia_pela_faixa_da_pk.sql

-- Ids acima de qualquer id real: o teste pagina a partir de '99999999'.
--   01 nova (entrou hoje)                    quente, prioridade 1
--   02 antiga, mexeu há pouco e subindo      quente, prioridade 1
--   03 antiga, mexeu há pouco e caindo       morna,  prioridade 2
--   04 antiga, parada                        fria,   prioridade 3
--   05 desativada                            não é tocada
--   06 antiga, parada, já com a banda certa  não conta como reclassificada
--   07 antiga, nunca medida (prev_rank nulo) fria,   prioridade 3
insert into public.observed_tracks
  (deezer_track_id, title, artist_name, active, added_at, prev_rank, last_rank, last_change_at,
   cadence_band, cadence_days, cadence_priority)
values
  ('999999990001', 'Nova',    'Teste', true,  now(),                    null, 100, null,                    null,   null, null),
  ('999999990002', 'Sobe',    'Teste', true,  now() - interval '90 days', 100, 200, now() - interval '2 days', null,   null, null),
  ('999999990003', 'Cai',     'Teste', true,  now() - interval '90 days', 200, 100, now() - interval '2 days', 'fria', 9,    3),
  ('999999990004', 'Parada',  'Teste', true,  now() - interval '90 days', 100, 100, now() - interval '90 days', null,  null, null),
  ('999999990005', 'Fora',    'Teste', false, now(),                    null, 100, null,                    null,   null, null),
  ('999999990006', 'Certa',   'Teste', true,  now() - interval '90 days', 100, 100, now() - interval '90 days', 'fria', 14,  3),
  ('999999990007', 'Virgem',  'Teste', true,  now() - interval '90 days', null, null, null,                 null,   null, null);

do $$
declare
  r jsonb;
  v_reclass integer := 0;
  v_exam integer := 0;
  v_lotes integer := 0;
  v_cursor text := '99999999';
begin
  -- Lotes de 2 sobre 6 ativas: 2 + 2 + 2, e o terceiro ainda devolve cursor
  -- (examinou o lote cheio); o quarto vem vazio, zera o cursor e traz a
  -- distribuição.
  loop
    r := public.refresh_observatory_cadence(7, 14, 30, 30, 2, v_cursor);
    v_lotes := v_lotes + 1;
    v_exam := v_exam + (r->>'examinadas')::int;
    v_reclass := v_reclass + (r->>'reclassificadas')::int;
    v_cursor := r->>'proximo';
    exit when v_cursor is null or v_lotes > 10;
    if v_lotes = 1 and v_cursor <> '999999990002' then
      raise exception 'cursor do primeiro lote: esperado 999999990002, veio %', v_cursor;
    end if;
  end loop;
  if v_lotes <> 4 then raise exception 'lotes: esperado 4, veio %', v_lotes; end if;
  if v_exam <> 6 then raise exception 'examinadas: esperado 6 (sem repetir nem pular), veio %', v_exam; end if;
  if v_reclass <> 5 then raise exception 'reclassificadas: esperado 5 (a 06 já estava certa), veio %', v_reclass; end if;
  if r->'distribuicao' = '{}'::jsonb then raise exception 'o último lote não trouxe a distribuição'; end if;

  -- Segunda passada: nada muda.
  r := public.refresh_observatory_cadence(7, 14, 30, 30, 100, '99999999');
  if (r->>'reclassificadas')::int <> 0 or (r->>'examinadas')::int <> 6 or r->>'proximo' is not null then
    raise exception 'segunda passada: %', r;
  end if;

  -- p_depois nulo é "desde o começo", como na 035.
  r := public.refresh_observatory_cadence(7, 14, 30, 30, 1, null);
  if (r->>'examinadas')::int <> 1 or r->>'proximo' is null then
    raise exception 'cursor nulo: %', r;
  end if;
end $$;

-- O que cada faixa virou.
do $$
declare
  esperado constant jsonb := '{
    "999999990001": ["quente", 1, 1],
    "999999990002": ["quente", 1, 1],
    "999999990003": ["morna", 7, 2],
    "999999990004": ["fria", 14, 3],
    "999999990005": [null, null, null],
    "999999990006": ["fria", 14, 3],
    "999999990007": ["fria", 14, 3]
  }';
  f record;
begin
  for f in
    select deezer_track_id, jsonb_build_array(cadence_band, cadence_days, cadence_priority) as veio
    from public.observed_tracks
    where deezer_track_id > '99999999'
  loop
    if f.veio is distinct from esperado->f.deezer_track_id then
      raise exception 'faixa %: esperado %, veio %', f.deezer_track_id, esperado->f.deezer_track_id, f.veio;
    end if;
  end loop;
end $$;

-- O UPDATE da faixa de PK não pode varrer a tabela. O mesmo statement da
-- função, com os parâmetros no lugar, explicado sem executar.
do $$
declare
  linha text;
  plano text := '';
begin
  for linha in execute $q$
    explain
    update public.observed_tracks o set cadence_band = 'fria'
    from (select deezer_track_id from public.observed_tracks
          where active and deezer_track_id > '99999999' and deezer_track_id <= '999999990004') f
    where o.deezer_track_id = f.deezer_track_id
      and o.deezer_track_id > '99999999' and o.deezer_track_id <= '999999990004'
  $q$ loop
    plano := plano || linha || E'\n';
  end loop;
  if plano ~ 'Seq Scan on observed_tracks' then
    raise exception 'o UPDATE varre a tabela:%', E'\n' || plano;
  end if;
end $$;

\echo 'cadencia.sql.test.sql: ok'
rollback;
