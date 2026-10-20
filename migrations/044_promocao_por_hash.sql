-- 044 — A promoção ao acervo casa as faixas salvas por hash
--
-- Sintoma: `Observatório: recálculo de cadência falhou` com 57014 (statement
-- timeout) às 05:01 de 19 e 20/10/2026, já com a 043 no ar. Não era a
-- cadência: `promote_saved_observed_tracks()` roda antes dela, no mesmo try, e
-- estourava sozinha os 8 s do authenticator. A cadência nem chegava a ser
-- chamada (`cadenciaLotes: 0` no log). Em 20/10 eram 223.436 faixas ativas sem
-- banda, todas na prioridade 0, e a banda fria (41 mil) ia inteira para o fim
-- da fila — foi dela que saíram as 44.508 adiadas da noite.
--
-- A causa: o EXISTS da 025 junta o casamento por ISRC e o por artista+título
-- num OR, com lower() dos dois lados. Nenhum índice serve a isso, e o
-- planejador faz um nested loop: cada faixa do catálogo contra cada linha de
-- `tracks`. Com 356 mil faixas e 84 salvas, 21 a 37 s.
--
-- O conserto: cada metade do OR vira um `in (select ...)` sem correlação. A
-- subconsulta é lida uma vez, vira uma tabela hash (hashed SubPlan) e o
-- catálogo é varrido uma vez só. Na produção em 20/10: 0,2 a 0,4 s, contra 21 s
-- da forma antiga no mesmo minuto, e as mesmas 2 faixas.
--
-- Por que o resultado é o mesmo, inclusive com nulo: o ramo do ISRC continua
-- filtrando `t.isrc is not null`; faixa observada sem ISRC dá nulo no `in`, e o
-- where descarta o nulo como descartava o false. No ramo do nome, os quatro
-- campos são not null nas duas tabelas, e o par só casa com os dois iguais.
--
-- O que NÃO muda: a assinatura, o retorno, a mão única (só promove) e os grants.

create or replace function public.promote_saved_observed_tracks()
returns integer
language sql
as $$
  with promovidas as (
    update public.observed_tracks o
    set source_list = 'acervo'
    where o.source_list is distinct from 'acervo'
      and (
        o.isrc in (
          select t.isrc
          from public.tracks t
          where t.isrc is not null
        )
        or (lower(o.artist_name), lower(o.title)) in (
          select lower(t.artist_name), lower(t.track_title)
          from public.tracks t
        )
      )
    returning 1
  )
  select count(*)::integer from promovidas;
$$;

comment on function public.promote_saved_observed_tracks() is
  'Faixa salva por alguém passa a ser classificada como acervo, não importa por onde entrou. A origem fica em origin_list. Casa por ISRC ou por artista+título, cada um numa subconsulta hash. Ver migrations 025 e 044.';

-- create or replace preserva os grants da 025; repetidos para a migration
-- valer sozinha num banco novo.
revoke all on function public.promote_saved_observed_tracks() from public, anon, authenticated;
grant execute on function public.promote_saved_observed_tracks() to service_role;

-- Promove agora as que ficaram para trás enquanto a função estourava o tempo.
select public.promote_saved_observed_tracks();
