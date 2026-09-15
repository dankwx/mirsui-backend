-- 034_catalogo_por_dia.sql
-- O tamanho do catálogo do Observatório, dia a dia, para o gráfico do painel.
--
-- A PERGUNTA
-- "Quantas faixas tem no banco, e a descoberta de hoje de manhã entrou?" O
-- painel já mostra o total ("faixas medidas"), mas um número só não diz se ele
-- cresceu ~5 mil hoje ou se a rotina parou há três dias — e é a curva que
-- responde isso de relance.
--
-- POR QUE UMA FUNÇÃO NOVA, E NÃO UM CTE A MAIS EM admin_overview()
-- `create or replace` obriga a repetir a função inteira: seriam 250 linhas da
-- migration 019 copiadas para acrescentar uma. O diff não mostraria o que mudou
-- e qualquer correção futura na 019 teria que ser feita em dois lugares. A rota
-- `GET /admin/overview` chama as duas e cola o resultado no mesmo JSON, então
-- para o frontend continua sendo uma superfície só.
--
-- O DIA
-- `observed_tracks.added_at` é timestamptz, e o dia é o de São Paulo: a
-- descoberta roda de madrugada no horário de quem opera, e "as 5 mil de hoje"
-- têm que cair em hoje. A série é contínua desde a primeira faixa: dia sem
-- descoberta aparece com `novas = 0` e o `total` repetido, que é justamente a
-- forma de uma rotina parada — um buraco na régua esconderia isso.
--
-- Conta todas as linhas, ativas ou não: a pergunta é "quantas tem no banco",
-- e o painel já separa `ativas` em `observatorio`.
--
-- O FECHO
-- `observed_tracks` tem leitura pública (migration 009), então não há segredo
-- aqui — mas a função é do painel, e só o backend precisa dela. Mesmo trio de
-- revoke da 019: superfície fechada por padrão, aberta só para a service role.

create or replace function public.admin_catalogo_por_dia()
returns jsonb
language sql
stable
set search_path = public
as $$
with por_dia as (
  select
    (added_at at time zone 'America/Sao_Paulo')::date as dia,
    count(*)::int                                     as novas
  from observed_tracks
  group by 1
),
dias as (
  select d::date as dia
  from generate_series(
    (select min(dia) from por_dia),
    (now() at time zone 'America/Sao_Paulo')::date,
    interval '1 day'
  ) as d
),
serie as (
  select
    d.dia,
    coalesce(p.novas, 0)                                            as novas,
    sum(coalesce(p.novas, 0)) over (order by d.dia)::int            as total
  from dias d
  left join por_dia p on p.dia = d.dia
)
select coalesce(
  jsonb_agg(
    jsonb_build_object(
      'dia',   to_char(s.dia, 'YYYY-MM-DD'),
      'novas', s.novas,
      'total', s.total
    )
    order by s.dia
  ),
  '[]'::jsonb
)
from serie s;
$$;

revoke execute on function public.admin_catalogo_por_dia() from public;
revoke execute on function public.admin_catalogo_por_dia() from anon;
revoke execute on function public.admin_catalogo_por_dia() from authenticated;
grant  execute on function public.admin_catalogo_por_dia() to   service_role;

comment on function public.admin_catalogo_por_dia() is
  'Faixas em observed_tracks por dia (São Paulo), novas e acumulado, desde a primeira. Para o gráfico do painel do dono. Ver migrations/034_catalogo_por_dia.sql.';
