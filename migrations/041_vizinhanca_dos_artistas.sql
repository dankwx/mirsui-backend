-- 041_vizinhanca_dos_artistas.sql
-- "Parecidas" na página de faixa, sem perguntar nada a ninguém na visita.
--
-- ------------------------------------------------------------
-- DE ONDE VEM A SEMELHANÇA
-- ------------------------------------------------------------
-- A descoberta (ADR 001 e 002) já pergunta ao Deezer, toda noite, quem se
-- parece com quem: o rádio do artista e o `/artist/{id}/related`. Ela usava a
-- resposta só para escolher a próxima faixa do catálogo e guardava de onde ela
-- veio (`recommendation_parent_track_id`, `discovery_artists.parent_artist_id`).
-- Essa linhagem já é um grafo de semelhança. Medido na produção em 25/09/2026:
--
--   123.666 de 128.622 faixas ativas têm mãe; 15.348 artistas
--   1 salto de artista   86% das faixas com 6+ faixas de outros artistas
--   + participações      91%
--   2 saltos             97% com 20+
--
--   Djavan  -> Ed Motta, Lenine, Seu Jorge, Chico Buarque, Marisa Monte
--   Matuê   -> Teto, Orochi, WIU
--
-- O grafo é quase uma árvore: 9.799 artistas têm um vizinho só, o artista de
-- quem vieram. Por isso a descoberta passa a guardar TUDO que o Deezer
-- devolve (tabela `artist_similarity`): os 20 do `/related`, que hoje viram 3,
-- e os artistas do rádio, que hoje viram uma faixa. Custo: zero requisições.
--
-- ------------------------------------------------------------
-- A VIZINHANÇA
-- ------------------------------------------------------------
-- A rodada remonta tudo no fim, só com SQL, em duas fases.
--
-- `rebuild_artist_pairs()` soma as fontes por par de artistas, dos dois lados
-- (o `/related` do artista pequeno cita o grande e o do grande não cita o
-- pequeno, mas quem abre o grande é quem mais ganha em conhecer o pequeno — é
-- a tese do produto):
--
--   related        3,0 no primeiro da lista, caindo 0,1 por posição
--   fronteira      2,0  (o /related que pôs o artista na caminhada)
--   linhagem       2,0 + ln(faixas que um trouxe do outro)
--   rádio          1,5 + ln(noites em que apareceu no rádio)
--   participação   1,5 + ln(faixas gravadas juntos)
--
-- A participação liga o artista principal a cada convidado, e só em faixa com
-- até 6 nomes. Todos contra todos, 254 faixas de 8+ nomes (orquestra, coro,
-- solistas) davam 91 mil dos 125 mil pares de participação do catálogo.
--
-- `rebuild_artist_neighbors(lote, lotes)` guarda, para os artistas do lote
-- que têm página (faixa ativa com ISRC), os 12 vizinhos mais fortes que também
-- têm. Quem ficou com menos de 6 completa com o vizinho do vizinho, sempre
-- depois dos diretos.
--
-- POR QUE EM LOTES: o PostgREST corta a chamada em 8 s (o `statement_timeout`
-- do `authenticator`, que vale para a service role — foi o que derrubou a
-- cadência até a 035). Numa função só, o catálogo de 25/09 (129 mil faixas)
-- levava 4,0 s, e ele vai a 500 mil. Os pares num passo e a vizinhança em
-- lotes por `id % lotes` deixam cada chamada pequena e crescendo devagar.
--
-- ------------------------------------------------------------
-- A PÁGINA
-- ------------------------------------------------------------
-- `get_track_page` ganha `relacionadas`: até 6 faixas, uma por vizinho, a
-- mais ouvida de cada um (o índice da 038 responde isso direto). Continua uma
-- requisição só; a resposta cresce ~1 KB.
--
-- Aplicar com `psql -v ON_ERROR_STOP=1 --single-transaction -f`. As últimas
-- linhas já montam a vizinhança com o que existe. Pode ir antes do backend
-- novo: sem ele a vizinhança só não é remontada à noite.

-- ------------------------------------------------------------
-- 1. O que a descoberta viu
-- ------------------------------------------------------------
create table if not exists public.artist_similarity (
  deezer_artist_id  text        not null,
  similar_artist_id text        not null,
  -- 'related' = /artist/{id}/related; 'radio' = /artist/{id}/radio
  source            text        not null check (source in ('related', 'radio')),
  -- a posição na resposta do Deezer (0 = a primeira); a melhor já vista
  position          smallint,
  -- quantas respostas trouxeram o par (o rádio muda de uma noite para outra)
  seen              integer     not null default 1,
  first_seen_at     timestamptz not null default now(),
  last_seen_at      timestamptz not null default now(),
  primary key (deezer_artist_id, similar_artist_id, source),
  check (deezer_artist_id ~ '^[0-9]+$' and similar_artist_id ~ '^[0-9]+$'),
  check (deezer_artist_id <> similar_artist_id)
);

comment on table public.artist_similarity is
  'Quem o Deezer diz que se parece com quem, como a descoberta recebeu: os 20 do /related e os artistas do rádio. Matéria-prima de artist_pairs. Ver migration 041.';

-- Só a rodada lê e escreve. RLS sem política: anon e authenticated não veem
-- nada; a service role passa por cima.
alter table public.artist_similarity enable row level security;
revoke all on public.artist_similarity from anon, authenticated;

create or replace function public.record_artist_similarity(p_rows jsonb)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_linhas integer;
begin
  if jsonb_typeof(coalesce(p_rows, '[]'::jsonb)) <> 'array' then
    raise exception 'p_rows precisa ser um array JSON';
  end if;

  with entrada as (
    -- O mesmo par pode vir duas vezes no lote (duas sementes, um artista):
    -- `on conflict` não aceita a mesma chave duas vezes no mesmo comando.
    select r->>'deezer_artist_id'           as deezer_artist_id,
           r->>'similar_artist_id'          as similar_artist_id,
           r->>'source'                     as source,
           min((r->>'position')::smallint)  as position
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) as r
    where r->>'deezer_artist_id' ~ '^[0-9]+$'
      and r->>'similar_artist_id' ~ '^[0-9]+$'
      and r->>'deezer_artist_id' <> r->>'similar_artist_id'
      and r->>'source' in ('related', 'radio')
    group by 1, 2, 3
  )
  insert into public.artist_similarity as s
    (deezer_artist_id, similar_artist_id, source, position)
  select deezer_artist_id, similar_artist_id, source, position
  from entrada
  on conflict (deezer_artist_id, similar_artist_id, source) do update
  set seen         = s.seen + 1,
      position     = least(s.position, excluded.position),
      last_seen_at = now();

  get diagnostics v_linhas = row_count;
  return v_linhas;
end $$;

-- ------------------------------------------------------------
-- 2. Os pares somados
-- ------------------------------------------------------------
-- Ids em bigint: a comparação de texto com collation custava metade do tempo
-- nas junções e ordenações, e todo id de artista do Deezer é número.
create table if not exists public.artist_pairs (
  a     bigint not null,
  b     bigint not null,
  score real   not null,
  primary key (a, b)
);

comment on table public.artist_pairs is
  'Semelhança somada por par de artistas, nos dois sentidos. Intermediária: a rodada a remonta e dela tira artist_neighbors. Ver migration 041.';

alter table public.artist_pairs enable row level security;
revoke all on public.artist_pairs from anon, authenticated;

create or replace function public.rebuild_artist_pairs()
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_pares integer;
begin
  -- Só a rodada lê esta tabela, então o `truncate` (que trava leitura até o
  -- fim da transação) não atrapalha a página.
  truncate public.artist_pairs;

  insert into public.artist_pairs (a, b, score)
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

    union all
    -- o resto do que o Deezer respondeu
    select s.deezer_artist_id::bigint, s.similar_artist_id::bigint,
           case s.source
             when 'related' then 3.0 - 0.1 * least(coalesce(s.position, 10), 19)
             else 1.5 + ln(s.seen)
           end
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
  select x.a, x.b, sum(x.w)::real
  from (
    select a, b, w from arestas
    union all
    select b, a, w from arestas
  ) x
  where not exists (
    select 1 from public.blocked_artists k
    where k.deezer_artist_id = x.b::text
  )
  group by x.a, x.b;

  get diagnostics v_pares = row_count;
  return v_pares;
end $$;

-- ------------------------------------------------------------
-- 3. A vizinhança que a página lê
-- ------------------------------------------------------------
create table if not exists public.artist_neighbors (
  deezer_artist_id   text     not null,
  -- 1 = o mais próximo
  position           smallint not null,
  neighbor_artist_id text     not null,
  score              real     not null,
  -- 1 = vizinho direto; 2 = vizinho de um vizinho, para completar
  hops               smallint not null,
  primary key (deezer_artist_id, position)
);

comment on table public.artist_neighbors is
  'Os 12 artistas mais próximos de cada artista do catálogo que tem página, remontados pela rodada a partir de artist_pairs. Ver migration 041.';

-- Leitura pública, como observed_tracks e artist_details: get_track_page é
-- security invoker e a página chama como anon.
alter table public.artist_neighbors enable row level security;
revoke insert, update, delete, truncate on public.artist_neighbors from anon, authenticated;
drop policy if exists "artist_neighbors_select_public" on public.artist_neighbors;
create policy "artist_neighbors_select_public"
  on public.artist_neighbors for select
  using (true);

create or replace function public.rebuild_artist_neighbors(
  p_lote  integer default 0,
  p_lotes integer default 1
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_artistas integer;
  v_diretos  integer;
  v_segundo  integer;
begin
  if p_lotes < 1 or p_lote < 0 or p_lote >= p_lotes then
    raise exception 'lote % de % não existe', p_lote, p_lotes;
  end if;

  -- O `drop` é para a segunda chamada na mesma transação (a migration, os
  -- testes). Pela rodada cada lote é uma transação e as tabelas somem sozinhas.
  drop table if exists pg_temp.viz_com_pagina, pg_temp.viz_alvo,
                       pg_temp.viz_um, pg_temp.viz_ponte, pg_temp.viz_dois;

  -- Quem pode aparecer como vizinho: tem faixa com página.
  create temporary table viz_com_pagina on commit drop as
    select distinct o.deezer_artist_id::bigint as id
    from public.observed_tracks o
    where o.active
      and o.isrc is not null
      and o.deezer_artist_id ~ '^[0-9]+$'
      and not exists (
        select 1 from public.blocked_artists b
        where b.deezer_artist_id = o.deezer_artist_id
      );
  alter table viz_com_pagina add primary key (id);

  -- Quem este lote remonta.
  create temporary table viz_alvo on commit drop as
    select id from viz_com_pagina where id % p_lotes = p_lote;
  alter table viz_alvo add primary key (id);

  -- Os 12 vizinhos diretos mais fortes, entre os que têm página.
  create temporary table viz_um on commit drop as
    select a, b, score
    from (
      select p.a, p.b, p.score,
             row_number() over (partition by p.a order by p.score desc, p.b) as n
      from public.artist_pairs p
      join viz_alvo t on t.id = p.a
      join viz_com_pagina v on v.id = p.b
    ) r
    where n <= 12;
  alter table viz_um add primary key (a, b);

  -- Segundo salto, só para quem ficou com menos de 6. A primeira perna são os
  -- 6 pares mais fortes, com ou sem página: o rádio de duas sementes pode
  -- citar o mesmo artista que não está no catálogo, e a ponte vale do mesmo
  -- jeito. A segunda perna são os 12 diretos da ponte que têm página.
  create temporary table viz_ponte on commit drop as
    with carentes as (
      select t.id as a
      from viz_alvo t
      left join viz_um u on u.a = t.id
      group by t.id
      having count(u.b) < 6
    )
    select a, m, score
    from (
      select p.a, p.b as m, p.score,
             row_number() over (partition by p.a order by p.score desc, p.b) as n
      from public.artist_pairs p
      join carentes c on c.a = p.a
    ) r
    where n <= 6;

  create temporary table viz_dois on commit drop as
    with segunda as (
      select a, b, score
      from (
        select p.a, p.b, p.score,
               row_number() over (partition by p.a order by p.score desc, p.b) as n
        from public.artist_pairs p
        join viz_com_pagina v on v.id = p.b
        where p.a in (select distinct m from viz_ponte)
      ) r
      where n <= 12
    )
    -- Vários caminhos até o mesmo artista somam; cada caminho vale o seu elo
    -- mais fraco.
    select pt.a, s.b, sum(least(pt.score, s.score))::real as score
    from viz_ponte pt
    join segunda s on s.a = pt.m
    where s.b <> pt.a
      and not exists (select 1 from viz_um x where x.a = pt.a and x.b = s.b)
    group by pt.a, s.b;

  -- Troca o lote inteiro, inclusive quem deixou de ter página ou vizinho.
  delete from public.artist_neighbors
  where deezer_artist_id::bigint % p_lotes = p_lote;

  insert into public.artist_neighbors
    (deezer_artist_id, position, neighbor_artist_id, score, hops)
  select a::text, n, b::text, score, hops
  from (
    select a, b, score, hops,
           row_number() over (partition by a order by hops, score desc, b) as n
    from (
      select a, b, score, 1::smallint as hops from viz_um
      union all
      select a, b, score, 2::smallint from viz_dois
    ) juntos
  ) r
  where n <= 12;

  select count(distinct deezer_artist_id),
         count(*) filter (where hops = 1),
         count(*) filter (where hops = 2)
    into v_artistas, v_diretos, v_segundo
  from public.artist_neighbors
  where deezer_artist_id::bigint % p_lotes = p_lote;

  return jsonb_build_object(
    'alvo',     (select count(*) from viz_alvo),
    'artistas', v_artistas,
    'diretos',  v_diretos,
    'segundo',  v_segundo
  );
end $$;

revoke all on function public.record_artist_similarity(jsonb) from public, anon, authenticated;
revoke all on function public.rebuild_artist_pairs() from public, anon, authenticated;
revoke all on function public.rebuild_artist_neighbors(integer, integer) from public, anon, authenticated;
grant execute on function public.record_artist_similarity(jsonb) to service_role;
grant execute on function public.rebuild_artist_pairs() to service_role;
grant execute on function public.rebuild_artist_neighbors(integer, integer) to service_role;

-- ------------------------------------------------------------
-- 4. A página
-- ------------------------------------------------------------
-- Igual à 037, com a chave `relacionadas` no fim.
create or replace function public.get_track_page(p_isrc text)
returns jsonb
language sql
stable
as $$
  with canonica as (
    select o.*
    from public.observed_tracks o
    where o.isrc = p_isrc
      and o.active
    order by o.last_rank desc nulls last, o.deezer_track_id
    limit 1
  ),
  -- A chave opaca do acervo. `tracks.track_uri` guarda `spotify:track:<id>`
  -- para tudo que foi salvo antes da migration 023, e `isrc:<ISRC>` para o que
  -- veio depois. As duas formas apontam para a mesma gravação e precisam contar
  -- junto — é a regra que o utils/trackClaims.ts monta no `.or()` do PostgREST,
  -- e que aqui vira uma expressão só.
  chave as (
    select coalesce(
             (select 'spotify:track:' || c.spotify_track_id
                from canonica c
               where c.spotify_track_id is not null),
             'isrc:' || p_isrc
           ) as uri
  ),
  salvas as (
    select t.user_id, t.position, t.claimedat
    from public.tracks t
    where t.isrc = p_isrc
       or t.track_uri = (select uri from chave)
  ),
  -- Os oito primeiros a chegar. `nulls last` porque linha antiga sem posição
  -- não pode passar na frente de quem tem o número.
  primeiros as (
    select s.user_id, s.position, s.claimedat
    from salvas s
    order by s.position asc nulls last
    limit 8
  ),
  -- Uma faixa por vizinho do artista principal, a mais ouvida dele: é a que
  -- tem mais chance de alguém reconhecer, e o índice
  -- (deezer_artist_id, last_rank desc) da 038 a devolve sem ordenar nada.
  -- Só faixa com ISRC, porque sem ele não há página para linkar.
  relacionadas as (
    select n.position, t.*
    from canonica c
    join public.artist_neighbors n on n.deezer_artist_id = c.deezer_artist_id
    cross join lateral (
      select o.deezer_track_id, o.deezer_artist_id, o.isrc, o.title,
             o.artist_name, o.album_name, o.cover_md5
      from public.observed_tracks o
      where o.deezer_artist_id = n.neighbor_artist_id
        and o.active
        and o.isrc is not null
        and o.isrc <> p_isrc
      order by o.last_rank desc nulls last, o.deezer_track_id
      limit 1
    ) t
    order by n.position
    limit 6
  )
  select jsonb_build_object(
    -- As mesmas colunas da interface `FaixaObservada`, em utils/trackIdentity.ts.
    -- Explícitas em vez
    -- de `to_jsonb(c)`: a tabela tem 20+ colunas de controle do Observatório
    -- (cadence_*, *_checked_at, recommendation_*) que a página não lê e que não
    -- têm por que viajar.
    'observada', (
      select jsonb_build_object(
        'deezer_track_id',  c.deezer_track_id,
        'deezer_artist_id', c.deezer_artist_id,
        'isrc',             c.isrc,
        'title',            c.title,
        'artist_name',      c.artist_name,
        'album_name',       c.album_name,
        'cover_md5',        c.cover_md5,
        'genre',            c.genre,
        'spotify_track_id', c.spotify_track_id,
        'last_rank',        c.last_rank,
        'last_popularity',  c.last_popularity,
        'duration_seconds', c.duration_seconds,
        'explicit_lyrics',  c.explicit_lyrics,
        'has_preview',      c.has_preview,
        'release_date',     c.release_date,
        'contributors',     c.contributors
      )
      from canonica c
    ),
    'curva', public.get_track_curve(p_isrc),
    'salvamentos', (select count(*) from salvas),
    'quem_salvou', coalesce(
      (
        select jsonb_agg(
                 jsonb_build_object(
                   'user_id',   p.user_id,
                   'position',  p.position,
                   'claimedat', p.claimedat,
                   -- `left join` e não `inner`: o embed do PostgREST em
                   -- trackClaims.ts é `profiles:user_id ( ... )` sem `!inner`,
                   -- então salvamento cujo perfil sumiu continua contando na
                   -- lista em vez de desaparecer dela.
                   'profiles',  case
                                  when pr.id is null then null
                                  else jsonb_build_object(
                                    'username',     pr.username,
                                    'avatar_url',   pr.avatar_url,
                                    'display_name', pr.display_name
                                  )
                                end
                 )
                 order by p.position asc nulls last
               )
        from primeiros p
        left join public.profiles pr on pr.id = p.user_id
      ),
      '[]'::jsonb
    ),
    'relacionadas', coalesce(
      (
        select jsonb_agg(
                 jsonb_build_object(
                   'deezer_track_id',  r.deezer_track_id,
                   'deezer_artist_id', r.deezer_artist_id,
                   'isrc',             r.isrc,
                   'title',            r.title,
                   'artist_name',      r.artist_name,
                   'album_name',       r.album_name,
                   'cover_md5',        r.cover_md5
                 )
                 order by r.position
               )
        from relacionadas r
      ),
      '[]'::jsonb
    )
  );
$$;

comment on function public.get_track_page(text) is
  'A página da faixa numa requisição: linha do Observatório, curva, contagem de '
  'salvamentos, os 8 primeiros a salvar e até 6 faixas de artistas vizinhos '
  '(041). Substitui 4 chamadas REST — ver o cabeçalho da migration 029 para o '
  'porquê (o custo era cabeçalho HTTP, não dado). Não inclui o salvamento do '
  'próprio usuário: esse depende de sessão.';

grant execute on function public.get_track_page(text) to anon, authenticated;

-- A primeira vizinhança, com o que a linhagem já tem. Pelo psql não há o
-- corte de 8 s, então vai num lote só.
select public.rebuild_artist_pairs();
select public.rebuild_artist_neighbors(0, 1);
