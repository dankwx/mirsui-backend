-- 035 — A cadência volta a caber no tempo
--
-- Sintoma, medido nos logs das rodadas: `Observatório: recálculo de cadência
-- falhou` com 57014 (canceling statement due to statement timeout), todas as
-- noites desde 17/09/2026. O passo vinha crescendo junto com o catálogo —
-- 5,3s em 14/09 (26 mil faixas), 7,1s em 15/09, 8,8s em 16/09 (36 mil), e a
-- partir daí não coube mais. Em 20/09 o catálogo tinha 82 mil faixas e 45.978
-- delas estavam sem `cadence_band`.
--
-- Não era um bug: era uma conta que deixou de caber. Duas causas, nesta ordem
-- de tamanho.
--
-- 1. A PERGUNTA "ESTA FAIXA ESTÁ SALVA?" ERA FEITA UMA VEZ POR FAIXA
--
--    A 025 resolvia `salva` com uma subconsulta correlacionada:
--
--      exists (select 1 from tracks t
--              where (t.isrc is not null and t.isrc = o.isrc)
--                 or (lower(t.artist_name) = lower(o.artist_name)
--                and lower(t.track_title)  = lower(o.title)))
--
--    O `or` entre dois critérios diferentes impede qualquer índice de servir,
--    e o `lower()` dos dois lados impede o resto. Resultado: para CADA uma das
--    82 mil faixas do catálogo, uma varredura inteira de `tracks` — que tem 81
--    linhas. São milhões de comparações para consultar uma tabela que cabe
--    numa tela.
--
--    Aqui `tracks` e `stakes` são lidas UMA vez, viram três conjuntos
--    deduplicados, e o encontro passa a ser por junção. O planejador resolve
--    isso com hash join. Mesma resposta, exatamente: os conjuntos preservam o
--    `is not null` do isrc e o par (artista, título) em minúsculas.
--
--    O `distinct` dos três não é enfeite: sem ele, duas linhas de `tracks` com
--    o mesmo isrc multiplicariam a faixa observada no left join e a contagem
--    de reclassificadas mentiria.
--
-- 2. ERA UM STATEMENT SÓ, E STATEMENT TEM RELÓGIO
--
--    Agora a função trata um LOTE e devolve o cursor do próximo. Quem repete é
--    o job, de fora.
--
--    E é de fora mesmo: `statement_timeout` é armado para o statement de cima
--    — a chamada da função. Paginar POR DENTRO, num laço plpgsql, não moveria
--    o relógio um milímetro, porque o relógio é o da chamada inteira. É a
--    mesma lição que a migration 031 aprendeu com a fila, pelo mesmo motivo.
--
--    A paginação é pela chave primária porque é a única ordem que não repete
--    nem pula linha entre uma chamada e a seguinte. `cadence_priority` não
--    serviria: é exatamente a coluna que a função reescreve.
--
-- O que NÃO muda: a classificação. Mesmas bandas, mesmos limiares, mesma regra
-- de só gravar quem mudou. A faixa sem banda continua caindo no conservador
-- (`coalesce(cadence_priority, 0)` e `coalesce(cadence_days, 1)` na fila da
-- 031): medida todo dia, nunca esquecida.

-- A assinatura ganha dois parâmetros. `create or replace` com lista diferente
-- criaria uma SOBRECARGA e deixaria a antiga de pé — e aí uma chamada com
-- quatro argumentos viraria "function is not unique". Some primeiro.
drop function if exists public.refresh_observatory_cadence(integer, integer, integer, integer);

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
  v_reclassificadas integer;
  v_examinadas      integer;
  v_ultimo          text;
  v_distribuicao    jsonb;
begin
  with hoje as (select (now() at time zone 'UTC')::date as d),

  -- O lote, pela PK. `limit` sem `order by` seria uma fatia aleatória e a
  -- paginação perderia linhas em silêncio.
  lote as (
    select o.deezer_track_id, o.isrc, o.title, o.artist_name, o.added_at,
           o.prev_rank, o.last_rank, o.last_change_at
    from public.observed_tracks o
    where o.active
      and (p_depois is null or o.deezer_track_id > p_depois)
    order by o.deezer_track_id
    limit v_lote
  ),

  -- As tabelas do lado de lá, lidas uma vez e deduplicadas. São pequenas de
  -- propósito: `tracks` é o que os usuários salvaram, `stakes` o que eles
  -- ficharam. O custo aqui é de dezenas de linhas, não de dezenas de milhares.
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
      -- O join vivo, e não source_list: quem desfez o save volta a esfriar
      -- sozinho, sem precisar de escrita nenhuma.
      (si.isrc is not null or sn.artista is not null) as salva,
      (o.added_at at time zone 'UTC')::date
        > (select d from hoje) - p_janela_novidade as nova,
      -- `prev_rank is not null` é o que separa "mudou" de "entrou": toda faixa
      -- tem um primeiro ponto, e last_change_at sozinho contaria essa entrada
      -- como movimento — o catálogo inteiro nasceria morno em vez de frio.
      -- prev_rank só existe a partir da SEGUNDA gravação, que é uma mudança real.
      o.prev_rank is not null
        and (o.last_change_at at time zone 'UTC')::date
            > (select d from hoje) - p_janela_movimento as moveu,
      -- Rank do Deezer: maior é mais popular. Subindo = ganhando audiência.
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
      and (o.cadence_band     is distinct from f.banda
        or o.cadence_days     is distinct from f.dias
        or o.cadence_priority is distinct from f.prioridade)
    returning 1
  )
  select
    (select count(*) from gravadas)::integer,
    (select count(*) from lote)::integer,
    (select max(deezer_track_id) from lote)
  into v_reclassificadas, v_examinadas, v_ultimo;

  -- Lote incompleto = acabou o catálogo. Só aí a distribuição é calculada: ela
  -- é uma varredura do catálogo inteiro e não faria sentido repetir a cada lote.
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

  -- `coalesce(cadence_band, 'sem banda')` acima também é um conserto: se
  -- sobrar faixa sem banda, jsonb_object_agg com chave nula levantaria erro e
  -- derrubaria o passo inteiro em vez de mostrar o problema no log.
  return jsonb_build_object(
    'reclassificadas', v_reclassificadas,
    'examinadas',      v_examinadas,
    'proximo',         v_ultimo,
    'distribuicao',    coalesce(v_distribuicao, '{}'::jsonb)
  );
end $$;

comment on function public.refresh_observatory_cadence(integer, integer, integer, integer, integer, text) is
  'Recalcula a banda de cadência de UM LOTE de faixas ativas, paginado pela PK, e grava só as que mudaram de banda. Devolve {reclassificadas, examinadas, proximo, distribuicao}; repita enquanto `proximo` não for nulo. A distribuição só vem no último lote. Ver migration 035.';

revoke all on function public.refresh_observatory_cadence(integer, integer, integer, integer, integer, text)
  from public, anon, authenticated;
grant execute on function public.refresh_observatory_cadence(integer, integer, integer, integer, integer, text)
  to service_role;
