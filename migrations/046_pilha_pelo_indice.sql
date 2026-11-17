-- 046_pilha_pelo_indice.sql
-- A Pilha volta a carregar: get_pile_tracks deixa de varrer o catálogo inteiro.
--
-- O QUE QUEBROU
-- A função (013, refeita na 014 e na 023) foi escrita quando o Observatório
-- tinha 3 mil faixas. Ela faz `distinct on (isrc) o.*` sobre TODAS as faixas
-- ativas e depois ordena tudo por md5 dentro de cada gênero, para no fim ficar
-- com 6 por gênero. Com 500 mil faixas são duas ordenações de meio milhão de
-- linhas largas por chamada, e o papel `anon` tem 3 s de statement timeout.
--
-- A página não mostrava o problema porque vivia de um resultado antigo no
-- cache do Next. Em 16/11/2026 um deploy apagou o cache e a /pilha passou a
-- responder "A pilha não carregou" — toda chamada dava 57014.
--
-- O CONSERTO
-- A amostra é a mesma de antes: dentro de cada gênero, as faixas de menor
-- md5(deezer_track_id) — pseudo-aleatório ESTÁVEL, que não sorteia de novo a
-- cada request. O que muda é o caminho até ela: um índice parcial já guarda as
-- faixas elegíveis nessa ordem, então a função lê os gêneros pulando pelo
-- índice (um passo por gênero) e pega as primeiras de cada um. O custo passa a
-- depender do número de gêneros, não do tamanho do catálogo.
--
-- A ÚNICA DIFERENÇA DE RESULTADO
-- Antes, a deduplicação por ISRC (o Deezer repete a gravação em single e
-- álbum) acontecia no catálogo inteiro, ficando o id de MAIOR last_rank. Agora
-- acontece entre as candidatas: pega-se o dobro do necessário por gênero (mais
-- uma folga), tira-se a repetição e fica-se com as p_por_genero primeiras. Uma
-- gravação repetida pode então entrar ou sair da amostra, ou aparecer pelo
-- outro id. Num catálogo sintético de 500 mil faixas com 2% de repetidas, 273
-- das 276 peças saíram idênticas — e a chamada foi de 3.027 ms para 14 ms.
--
-- COMO APLICAR
-- Fora de transação (psql -f, sem --single-transaction): `create index
-- concurrently` não roda dentro de uma, e é ele que evita travar as escritas
-- da rodada enquanto o índice é construído.

create index concurrently if not exists observed_tracks_pilha_idx
    on public.observed_tracks (coalesce(genre, 'outros'), md5(deezer_track_id))
    where active
      and cover_md5 is not null
      and last_rank is not null
      and isrc is not null;

create or replace function public.get_pile_tracks(p_por_genero integer default 6)
returns jsonb
language sql
stable
-- SECURITY DEFINER, e não é por permissão: é por plano. A tabela tem RLS
-- ligado, e para o papel `anon` o planejador não aproveita a ordem do índice
-- no `order by md5(...)`: lê todas as faixas de cada gênero e ordena (1.826 ms
-- medidos em produção, contra 12 ms como dono da tabela, mesma consulta). Como
-- dono, o RLS não entra e o índice é lido já na ordem.
--
-- Não abre nada: a política da tabela é `using (true)` para leitura pública, e
-- a função devolve as mesmas colunas que o `anon` já lê direto. O search_path
-- vazio é o cuidado de praxe — tudo aqui é qualificado com `public.`.
security definer
set search_path = ''
as $$
  with recursive generos as (
    -- Os gêneros, um por passo, pulando pelo índice. Um `select distinct`
    -- leria todas as entradas; isto lê uma por gênero.
    (
      select coalesce(o.genre, 'outros') as genero
      from public.observed_tracks o
      where o.active
        and o.cover_md5 is not null
        and o.last_rank is not null
        and o.isrc is not null
      order by coalesce(o.genre, 'outros')
      limit 1
    )
    union all
    select (
      select coalesce(o.genre, 'outros')
      from public.observed_tracks o
      where o.active
        and o.cover_md5 is not null
        and o.last_rank is not null
        and o.isrc is not null
        and coalesce(o.genre, 'outros') > g.genero
      order by coalesce(o.genre, 'outros')
      limit 1
    )
    from generos g
    where g.genero is not null
  ),
  candidatas as (
    select g.genero, c.*
    from generos g
    cross join lateral (
      select o.deezer_track_id, o.isrc, o.title, o.artist_name, o.cover_md5,
             o.last_rank, o.last_popularity,
             md5(o.deezer_track_id) as sorteio
      from public.observed_tracks o
      where o.active
        and o.cover_md5 is not null
        and o.last_rank is not null
        and o.isrc is not null
        and coalesce(o.genre, 'outros') = g.genero
      order by md5(o.deezer_track_id)
      -- O dobro e uma folga: sobra para a deduplicação por ISRC abaixo.
      limit p_por_genero * 2 + 4
    ) c
    where g.genero is not null
  ),
  unicas as (
    -- Uma linha por gravação, entre as candidatas.
    select distinct on (c.isrc) c.*
    from candidatas c
    order by c.isrc, c.sorteio
  ),
  amostra as (
    select u.*,
           row_number() over (partition by u.genero order by u.sorteio) as n
    from unicas u
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
        'isrc',      e.isrc,
        'title',     e.title,
        'artist',    e.artist_name,
        'md5',       e.cover_md5,
        'genre',     e.genero,
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
