-- 031_fila_estavel_e_paginavel.sql
-- O corte de 1.000 linhas que ninguém via, e o que ele exige para sumir.
--
-- O QUE ACONTECEU
-- A 025 trocou a leitura da fila da etapa 3 por um RPC e tirou a paginação de
-- lerFila() junto, com o argumento de que o `limit p_limite` dentro da função
-- substituía o `.range()` de fora. Não substitui: db.rpc() vai por PostgREST, e
-- PostgREST corta TODA resposta em db-max-rows antes de ela chegar ao processo.
-- O `p_limite` do job era 12.000 e a resposta vinha com 1.000 linhas, todas as
-- noites, desde a 025.
--
-- Medido em produção em 26/08/2026, no mesmo RPC:
--
--   PostgREST, p_limite = 12000     1.000 linhas
--   PostgREST, p_limite = 40000     1.000 linhas
--   SQL direto, count(*)           10.726 linhas
--
-- A rodada de 26/08 durou 4min11s e mediu 997 faixas na etapa 3 — 4 blocos de
-- BLOCO=250, menos 3 que o Deezer não respondeu. As 4.909 do dia se decompõem
-- em 2.476 (chart) + 997 (etapa 3) + 372 (ISRC) + 1.064 (faixas NOVAS, que
-- nascem com last_checked_at e por isso pareciam medidas).
--
-- O QUE ESTA MIGRATION FAZ
-- Subir db-max-rows para 20.000 destrava hoje e volta a cortar quando o catálogo
-- passar disso — a ~1.100 faixas/dia, em poucas semanas. A correção de verdade é
-- o job voltar a paginar. Só que paginar por .range() exige ORDEM TOTAL: a
-- ordenação da 025 termina em last_checked_at, e medido agora, 10.725 das 10.726
-- linhas da fila estão em grupos de empate — o maior com 808. Duas páginas de um
-- mesmo empate podem repetir e pular linha, porque o Postgres não promete ordem
-- estável dentro do empate entre duas execuções.
--
-- Então: deezer_track_id (a PK) como último critério, e o índice da fila
-- estendido para cobrir a ordenação inteira — sem isso cada página vira um sort
-- da fila toda.
--
-- Nada mais muda: mesma assinatura, mesmo WHERE, mesma prioridade.

create or replace function public.observatory_measurement_queue(p_limite integer)
returns table (
  deezer_track_id  text,
  deezer_artist_id text,
  deezer_album_id  text,
  title            text,
  artist_name      text,
  source_list      text,
  cadence_band     text
)
language sql
stable
as $$
  select
    o.deezer_track_id,
    o.deezer_artist_id,
    o.deezer_album_id,
    o.title,
    o.artist_name,
    o.source_list,
    coalesce(o.cadence_band, 'quente')
  from public.observed_tracks o
  where o.active
    and (
      o.last_checked_at is null
      or (now() at time zone 'UTC')::date - (o.last_checked_at at time zone 'UTC')::date
         >= coalesce(o.cadence_days, 1)
    )
  order by coalesce(o.cadence_priority, 0), o.last_checked_at asc nulls first, o.deezer_track_id
  limit greatest(p_limite, 0);
$$;

comment on function public.observatory_measurement_queue(integer) is
  'Fila da etapa 3 do Observatório: só quem venceu a própria cadência, na ordem de prioridade, cortada no orçamento da noite. Ordem TOTAL (termina na PK) porque o job pagina por .range() — ver migration 031.';

revoke all on function public.observatory_measurement_queue(integer) from public, anon, authenticated;
grant execute on function public.observatory_measurement_queue(integer) to service_role;

-- O índice da 025 parava em last_checked_at, que é exatamente onde a ordenação
-- deixava de ser determinística. Estendido, ele cobre o order by inteiro e cada
-- página continua sendo uma varredura de índice.
drop index if exists public.observed_tracks_fila_idx;
create index if not exists observed_tracks_fila_idx
  on public.observed_tracks (cadence_priority, last_checked_at nulls first, deezer_track_id)
  where active;
