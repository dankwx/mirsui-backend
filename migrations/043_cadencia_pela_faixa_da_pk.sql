-- 043 — Cada lote da cadência lê só o próprio lote
--
-- Sintoma: `Observatório: recálculo de cadência falhou` com 57014 (statement
-- timeout) em todas as rodadas desde pelo menos 02/10/2026, já no primeiro
-- lote. Em 18/10 o catálogo tinha 329 mil faixas ativas e 200.476 delas sem
-- `cadence_band`. O pg_stat_statements mostrava os últimos lotes que ainda
-- passaram entre 2,4 s e 7,0 s, contra 375 ms de média na época da 035.
--
-- A causa: o UPDATE da 035 junta o lote com `observed_tracks` por hash join, e
-- o lado do hash é um seq scan da TABELA INTEIRA. O planejador escolhe isso
-- porque 20 mil buscas pelo índice custam mais, no modelo dele, que uma
-- varredura. Então o custo de um lote não depende do tamanho do lote, e sim do
-- catálogo: 82 mil faixas em 20/09, 329 mil em 18/10, rumo a 500 mil. E o
-- número de lotes cresce junto. Num Postgres descartável com a cópia de 18/10,
-- quente e sem concorrência, cada lote levava 1,5 s; na produção, com
-- shared_buffers de 128 MB, 62 mil tuplas mortas e o site lendo ao mesmo
-- tempo, passou dos 8 s.
--
-- O conserto: o fim do lote é achado antes, só pelo índice da PK, e o UPDATE
-- recebe a mesma faixa de PK (`> p_depois` e `<= v_ultimo`). Com o intervalo
-- explícito o lado do hash vira um index scan de 20 mil linhas.
--
-- O `coalesce(p_depois, '')` no lugar do `p_depois is null or ...` da 035 é de
-- propósito: depois de cinco chamadas na mesma conexão o plpgsql pode passar a
-- um plano genérico, e com o `or` o limite de baixo deixa de servir ao índice.
-- Todo id do Deezer é uma string não vazia, então `> ''` é "desde o começo".
--
-- O que NÃO muda: a assinatura (create or replace, sem janela de quebra para a
-- rodada que está chamando), a classificação, a paginação e o retorno.

create or replace function public.refresh_observatory_cadence(
  p_cadencia_morna   integer default 7,
  p_cadencia_fria    integer default 14,
  p_janela_movimento integer default 30,
  p_janela_novidade  integer default 30,
  p_lote             integer default 20000,
  p_depois           text    default null
)
returns jsonb
language plpgsql
as $$
declare
  v_lote            integer := greatest(coalesce(p_lote, 20000), 1);
  v_depois          text    := coalesce(p_depois, '');
  v_reclassificadas integer := 0;
  v_examinadas      integer;
  v_ultimo          text;
  v_distribuicao    jsonb;
begin
  -- O fim do lote, antes de tudo, só pelo índice da PK.
  select count(*), max(l.deezer_track_id)
  into v_examinadas, v_ultimo
  from (
    select o.deezer_track_id
    from public.observed_tracks o
    where o.active and o.deezer_track_id > v_depois
    order by o.deezer_track_id
    limit v_lote
  ) l;

  if v_examinadas > 0 then
    with hoje as (select (now() at time zone 'UTC')::date as d),
    lote as (
      select o.deezer_track_id, o.isrc, o.title, o.artist_name, o.added_at,
             o.prev_rank, o.last_rank, o.last_change_at
      from public.observed_tracks o
      where o.active
        and o.deezer_track_id > v_depois
        and o.deezer_track_id <= v_ultimo
    ),
    stakes_ativas as (
      select distinct s.deezer_track_id
      from public.stakes s
      where s.status = 'ativa' and s.deezer_track_id is not null
    ),
    salvas_isrc as (
      select distinct t.isrc
      from public.tracks t
      where t.isrc is not null
    ),
    salvas_nome as (
      select distinct lower(t.artist_name) as artista, lower(t.track_title) as titulo
      from public.tracks t
      where t.artist_name is not null and t.track_title is not null
    ),
    sinal as (
      select
        o.deezer_track_id,
        st.deezer_track_id is not null as tem_stake,
        (si.isrc is not null or sn.artista is not null) as salva,
        (o.added_at at time zone 'UTC')::date
          > (select d from hoje) - p_janela_novidade as nova,
        o.prev_rank is not null
          and (o.last_change_at at time zone 'UTC')::date
              > (select d from hoje) - p_janela_movimento as moveu,
        o.prev_rank is not null and o.last_rank > o.prev_rank as subindo
      from lote o
      left join stakes_ativas st on st.deezer_track_id = o.deezer_track_id
      left join salvas_isrc   si on o.isrc is not null and si.isrc = o.isrc
      left join salvas_nome   sn on sn.artista = lower(o.artist_name)
                                and sn.titulo  = lower(o.title)
    ),
    classificada as (
      select
        deezer_track_id,
        case
          when tem_stake or salva          then 0
          when nova or (moveu and subindo) then 1
          when moveu                       then 2
          else                                  3
        end as prioridade
      from sinal
    ),
    final as (
      select
        deezer_track_id,
        prioridade,
        case prioridade when 0 then 'quente' when 1 then 'quente'
                        when 2 then 'morna'  else 'fria' end as banda,
        case prioridade when 0 then 1 when 1 then 1
                        when 2 then p_cadencia_morna else p_cadencia_fria end as dias
      from classificada
    ),
    gravadas as (
      update public.observed_tracks o
      set cadence_band     = f.banda,
          cadence_days     = f.dias,
          cadence_priority = f.prioridade
      from final f
      where o.deezer_track_id = f.deezer_track_id
        -- a mesma faixa do lote, repetida aqui para o planejador usar o
        -- índice em vez de varrer a tabela (ver o cabeçalho)
        and o.deezer_track_id > v_depois
        and o.deezer_track_id <= v_ultimo
        and (o.cadence_band     is distinct from f.banda
          or o.cadence_days     is distinct from f.dias
          or o.cadence_priority is distinct from f.prioridade)
      returning 1
    )
    select count(*)::integer into v_reclassificadas from gravadas;
  end if;

  -- Último lote: zera o cursor e devolve a distribuição, como na 035.
  if v_examinadas < v_lote then
    v_ultimo := null;
    select jsonb_object_agg(coalesce(cadence_band, 'sem banda'), n)
    into v_distribuicao
    from (
      select cadence_band, count(*) as n
      from public.observed_tracks
      where active
      group by cadence_band
    ) d;
  end if;

  return jsonb_build_object(
    'reclassificadas', v_reclassificadas,
    'examinadas',      v_examinadas,
    'proximo',         v_ultimo,
    'distribuicao',    coalesce(v_distribuicao, '{}'::jsonb)
  );
end $$;

comment on function public.refresh_observatory_cadence(integer, integer, integer, integer, integer, text) is
  'Recalcula a banda de cadência de UM LOTE de faixas ativas, paginado pela PK, e grava só as que mudaram de banda. Devolve {reclassificadas, examinadas, proximo, distribuicao}; repita enquanto `proximo` não for nulo. A distribuição só vem no último lote. O UPDATE lê só a faixa de PK do lote. Ver migrations 035 e 043.';

-- create or replace preserva os grants da 035; repetidos para a migration
-- valer sozinha num banco novo.
revoke all on function public.refresh_observatory_cadence(integer, integer, integer, integer, integer, text)
  from public, anon, authenticated;
grant execute on function public.refresh_observatory_cadence(integer, integer, integer, integer, integer, text)
  to service_role;
