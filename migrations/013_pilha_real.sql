-- 013_pilha_real.sql
-- A Pilha passa a sair do Observatório.
--
-- ANTES
-- utils/pileService.ts no frontend devolvia 74 faixas fixas no código, e os dois
-- números de cada card ("salvos" e "há quantos dias foi o primeiro") saíam de um
-- hash do nome da faixa. Era honesto enquanto a página ficou fechada — o próprio
-- arquivo dizia "HOJE É MOCK" no topo —, mas impedia abrir a Pilha ao público:
-- seria publicar número inventado.
--
-- AGORA
-- As faixas, as capas, os gêneros e o nível de audiência vêm de observed_tracks,
-- medido todo dia (ver 009). O que NÃO tem como ser real ainda foi retirado da
-- tela em vez de ser inventado:
--
--   "salvos"          saiu. Casar uma faixa do Deezer com um salvamento do site
--                     exigiria ir de id do Spotify até ISRC, o que só a API do
--                     Spotify faz — não dá em SQL. Casar por artista+título em
--                     texto produziria contagem errada, que é pior que nenhuma.
--   "a primeira"      saiu. Todas as faixas entraram no mesmo dia, então o
--                     número seria idêntico em todos os cards.
--
-- Sobra um número por faixa, e ele é real: a audiência 0-100.
--
-- O CALOR É RELATIVO, DE PROPÓSITO
-- topo/meio/subsolo vem de ntile(3) sobre as faixas escolhidas, não de um corte
-- fixo de rank. Duas razões: (a) um limiar chumbado envelhece conforme o
-- catálogo cresce; (b) a pilha fica visualmente equilibrada, com um terço de
-- cada tamanho de capa, em vez de virar um mosaico só de peças grandes — hoje
-- 2/3 do catálogo medido está acima de 615 mil de rank, porque chart é chart.
--
-- Nota sobre "na subida": o rótulo do meio era esse e virou "no meio". Nível não
-- é tendência — dizer que uma faixa está subindo exige duas medições, e hoje só
-- existe uma. Quando o histórico encher, dá para trocar por movimento de verdade.

create or replace function public.get_pile_tracks(p_por_genero integer default 6)
returns jsonb
language sql
stable
as $$
  with canonicas as (
    -- Uma linha por gravação. O Deezer mantém a mesma faixa sob mais de um id
    -- (single e álbum); sem isto a mesma capa apareceria duas vezes na pilha.
    select distinct on (o.isrc) o.*
    from public.observed_tracks o
    where o.active
      and o.cover_md5 is not null
      and o.last_rank is not null
      and o.isrc is not null
    order by o.isrc, o.last_rank desc
  ),
  amostra as (
    select c.*,
           row_number() over (
             partition by coalesce(c.genre, 'outros')
             -- Pseudo-aleatório ESTÁVEL: espalha dentro do gênero sem sortear de
             -- novo a cada request, então a página segue cacheável.
             order by md5(c.deezer_track_id)
           ) as n
    from canonicas c
  ),
  escolhidas as (
    -- O WHERE roda antes da window function, então o ntile enxerga só as
    -- faixas que sobraram — os terços são do que vai para a tela.
    select a.*, ntile(3) over (order by a.last_rank) as terco
    from amostra a
    where a.n <= p_por_genero
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id',        e.deezer_track_id,
        'title',     e.title,
        'artist',    e.artist_name,
        'md5',       e.cover_md5,
        'genre',     coalesce(e.genre, 'outros'),
        'heat',      case e.terco when 3 then 'topo' when 2 then 'meio' else 'subsolo' end,
        'audiencia', coalesce(e.last_popularity, 0)
      )
      order by e.last_rank desc
    ),
    '[]'::jsonb
  )
  from escolhidas e;
$$;

grant execute on function public.get_pile_tracks(integer) to anon, authenticated;
