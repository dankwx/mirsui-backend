-- 048_pares_de_artistas_em_lotes.sql
-- Os pares de artistas (041) voltam a ser somados: a soma passa a ir em lotes.
--
-- ------------------------------------------------------------
-- O QUE QUEBROU
-- ------------------------------------------------------------
-- `rebuild_artist_pairs()` montava todos os pares num único comando, e o
-- PostgREST corta cada chamada em 8 s (o `statement_timeout` do
-- `authenticator`, que vale para a service role). Em 21/11/2026 passou com
-- 810.692 pares; em 22/11, depois das primeiras noites de 30 mil faixas novas,
-- deu 57014 ("falha ao somar os pares de artistas"). A transação voltava
-- inteira e as "Parecidas" ficavam com a vizinhança da noite anterior; artista
-- novo ficava sem.
--
-- Medido numa cópia das tabelas de 22/11 (561 mil faixas, 401 mil linhas de
-- artist_similarity, 893 mil pares), no mesmo Postgres 15.8 da produção:
--
--   a função antiga, inteira          7,8–8,1 s
--     as quatro fontes                ~1,3 s   (a linhagem é ~1,0 s)
--     somar 1,19 milhão de arestas    ~1,7 s   (com work_mem de 4 MB, em disco)
--     gravar 893 mil pares no índice  ~4,8 s   (em ordem de hash, fora de ordem)
--
-- O que pesa é somar e gravar tudo de uma vez, e isso cresce com o catálogo.
--
-- ------------------------------------------------------------
-- O CONSERTO
-- ------------------------------------------------------------
-- Duas fases, a mesma ideia de `rebuild_artist_neighbors`:
--
--   1. `stage_artist_pairs(parte)`: junta as arestas das quatro fontes, já nos
--      dois sentidos e sem os artistas bloqueados, numa tabela de passagem sem
--      índice (`artist_pair_edges`). Duas chamadas: a parte 0 esvazia a tabela
--      e grava linhagem + fronteira; a parte 1 grava semelhança + participação.
--   2. `rebuild_artist_pairs(lote, lotes)`: soma as arestas dos artistas
--      `a % lotes = lote` e troca só esses pares. Grava em ordem de (a, b),
--      que é a do índice.
--
-- O resultado é o mesmo da 041, par a par: as mesmas fontes, os mesmos pesos,
-- a mesma soma. Só muda onde a soma é cortada. Na cópia de 22/11 os 893.390
-- pares saíram idênticos (mesmo score, inclusive).
--
-- Tempos na mesma cópia, cada um uma chamada do PostgREST:
--
--   fase 1, parte 0 (linhagem + fronteira)        ~1,3 s
--   fase 1, parte 1 (semelhança + participação)   ~1,3 s
--   fase 2, cada um dos 8 lotes                   0,9–1,3 s
--
-- Tudo cresce linear com o catálogo e com artist_similarity; a parte que
-- chega primeiro aos 8 s é a linhagem, perto de ~3 milhões de faixas.
--
-- Um lote que falha deixa os pares de ontem daquele pedaço: o resto troca
-- normalmente e a vizinhança roda em cima disso. Se a fase 1 falhar, a rodada
-- não chega na fase 2 (a tabela de passagem guardaria a noite anterior).
--
-- Só a rodada lê `artist_pairs` e `artist_pair_edges`: entre um lote e outro a
-- tabela mistura pares de hoje e de ontem, e ninguém vê isso.
--
-- A função antiga, sem argumentos, sai. O backend velho que a chamar recebe
-- "função não existe" em vez de 57014: dá no mesmo (falha e a vizinhança fica
-- a de ontem) até o reinício com o código novo.
--
-- ------------------------------------------------------------
-- COMO APLICAR
-- ------------------------------------------------------------
-- `psql -v ON_ERROR_STOP=1 --single-transaction -f`, fora da rodada (antes das
-- 05:00 ou depois de "rodada concluída"), e depois reiniciar o backend. Não
-- remonta nada sozinha: quem remonta é a rodada, ou
-- `npx tsx src/scripts/runVizinhanca.ts`.

-- ------------------------------------------------------------
-- 1. A tabela de passagem
-- ------------------------------------------------------------
-- Unlogged: é refeita inteira toda noite antes de ser lida, então não precisa
-- de WAL nem de sobreviver a uma queda (o Postgres a esvazia na recuperação, e
-- a fase 1 roda sempre antes da fase 2).
create unlogged table if not exists public.artist_pair_edges (
  a bigint not null,
  b bigint not null,
  w double precision not null
);

comment on table public.artist_pair_edges is
  'Arestas de semelhança das quatro fontes, nos dois sentidos, antes da soma. Passagem entre stage_artist_pairs e rebuild_artist_pairs. Ver migration 048.';

alter table public.artist_pair_edges enable row level security;
revoke all on public.artist_pair_edges from public, anon, authenticated;
grant all on public.artist_pair_edges to service_role;

-- ------------------------------------------------------------
-- 2. Fase 1: juntar as arestas
-- ------------------------------------------------------------
-- As fontes e os pesos são os da 041, sem mudar nada:
--
--   related        3,0 no primeiro da lista, caindo 0,1 por posição
--   fronteira      2,0
--   linhagem       2,0 + ln(faixas que um trouxe do outro)
--   rádio          1,5 + ln(noites em que apareceu no rádio)
--   participação   1,5 + ln(faixas gravadas juntos)
--
-- O bloqueio vale para o lado `b`, como na 041: o artista bloqueado não vira
-- vizinho de ninguém.
--
-- A parte 0 esvazia a tabela, então a ordem é 0 e depois 1. Se a parte 1
-- falhar, a tabela fica pela metade: a rodada para ali e não chega na fase 2.
create or replace function public.stage_artist_pairs(p_parte integer)
returns integer
language plpgsql
security invoker
set search_path = ''
-- A linhagem agrupa o catálogo inteiro: com os 4 MB padrão o agrupamento vai
-- para o disco.
set work_mem = '64MB'
as $$
declare
  v_arestas integer;
begin
  if p_parte = 0 then
    truncate public.artist_pair_edges;

    insert into public.artist_pair_edges (a, b, w)
    with arestas as (
      -- linhagem: a faixa-mãe levou à filha pelo rádio ou pelo /related
      select p.deezer_artist_id::bigint as a,
             o.deezer_artist_id::bigint as b,
             2.0 + ln(count(*)) as w
      from public.observed_tracks o
      join public.observed_tracks p
        on p.deezer_track_id = o.recommendation_parent_track_id
      where o.deezer_artist_id ~ '^[0-9]+$'
        and p.deezer_artist_id ~ '^[0-9]+$'
        and o.deezer_artist_id <> p.deezer_artist_id
      group by 1, 2

      union all
      -- fronteira da caminhada por álbum
      select d.parent_artist_id::bigint, d.deezer_artist_id::bigint, 2.0
      from public.discovery_artists d
      where d.parent_artist_id ~ '^[0-9]+$'
        and d.deezer_artist_id ~ '^[0-9]+$'
        and d.parent_artist_id <> d.deezer_artist_id
    )
    select x.a, x.b, x.w
    from (
      select a, b, w from arestas
      union all
      select b, a, w from arestas
    ) x
    where not exists (
      select 1 from public.blocked_artists k
      where k.deezer_artist_id = x.b::text
    );

  elsif p_parte = 1 then
    insert into public.artist_pair_edges (a, b, w)
    with arestas as (
      -- o resto do que o Deezer respondeu
      select s.deezer_artist_id::bigint as a,
             s.similar_artist_id::bigint as b,
             case s.source
               when 'related' then 3.0 - 0.1 * least(coalesce(s.position, 10), 19)
               else 1.5 + ln(s.seen)
             end as w
      from public.artist_similarity s

      union all
      -- participações: o principal com cada convidado
      select o.deezer_artist_id::bigint, (c->>'id')::bigint,
             1.5 + ln(count(*))
      from public.observed_tracks o
      cross join lateral jsonb_array_elements(o.contributors) c
      where o.active
        and o.deezer_artist_id ~ '^[0-9]+$'
        and jsonb_typeof(o.contributors) = 'array'
        and jsonb_array_length(o.contributors) between 2 and 6
        and c->>'id' ~ '^[0-9]+$'
        and c->>'id' <> o.deezer_artist_id
      group by 1, 2
    )
    select x.a, x.b, x.w
    from (
      select a, b, w from arestas
      union all
      select b, a, w from arestas
    ) x
    where not exists (
      select 1 from public.blocked_artists k
      where k.deezer_artist_id = x.b::text
    );

  else
    raise exception 'parte % não existe (0 ou 1)', p_parte;
  end if;

  get diagnostics v_arestas = row_count;
  return v_arestas;
end $$;

-- ------------------------------------------------------------
-- 3. Fase 2: somar e trocar, um lote de artistas por vez
-- ------------------------------------------------------------
drop function if exists public.rebuild_artist_pairs();

create or replace function public.rebuild_artist_pairs(
  p_lote  integer,
  p_lotes integer
)
returns integer
language plpgsql
security invoker
set search_path = ''
set work_mem = '64MB'
as $$
declare
  v_pares integer;
begin
  if p_lotes < 1 or p_lote < 0 or p_lote >= p_lotes then
    raise exception 'lote % de % não existe', p_lote, p_lotes;
  end if;

  -- Troca o lote inteiro, inclusive o par que deixou de existir (artista
  -- bloqueado, faixa que saiu).
  delete from public.artist_pairs
  where a % p_lotes = p_lote;

  insert into public.artist_pairs (a, b, score)
  select e.a, e.b, sum(e.w)::real
  from public.artist_pair_edges e
  where e.a % p_lotes = p_lote
  group by e.a, e.b
  order by e.a, e.b;

  get diagnostics v_pares = row_count;
  return v_pares;
end $$;

revoke all on function public.stage_artist_pairs(integer) from public, anon, authenticated;
revoke all on function public.rebuild_artist_pairs(integer, integer) from public, anon, authenticated;
grant execute on function public.stage_artist_pairs(integer) to service_role;
grant execute on function public.rebuild_artist_pairs(integer, integer) to service_role;

-- A 041 trocava os pares com `truncate`; a fase 2 apaga e insere por lote.
grant select, insert, delete on public.artist_pairs to service_role;

-- O PostgREST relê o esquema para enxergar as assinaturas novas.
notify pgrst, 'reload schema';
