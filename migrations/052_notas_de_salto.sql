-- 052_notas_de_salto.sql
-- Os saltos de audiência viram notas escritas pelo dono, na curva da página de
-- faixa.
--
-- (A 049 continua reservada para a paginação por cursor da fila do banco.)
--
-- ------------------------------------------------------------
-- O QUE É
-- ------------------------------------------------------------
-- Quando uma faixa sobe forte de repente, a pergunta de quem olha a curva é
-- "por quê?". A rodada diária detecta o salto e o coloca numa fila do painel
-- (/admin/saltos). O dono pesquisa, escreve uma nota curta com a fonte e
-- publica. A partir daí a curva da página de faixa ganha um número no ponto do
-- salto e a nota aparece embaixo dela. Salto sem nota não aparece em lugar
-- nenhum: a página continua igual.
--
-- Por que não IA: testado em 21/11/2026 com os 12 maiores saltos desde 23/09.
-- Só 3 tinham causa publicada na web (2º turno da eleição, álbum novo da Fenne
-- Lily, 2ª temporada de Black Doves). Nos outros 9, uma nota gerada seria
-- inventada. E o Mirsui não tem orçamento para API paga em job recorrente.
--
-- ------------------------------------------------------------
-- O QUE CONTA COMO SALTO
-- ------------------------------------------------------------
-- Na escala 0-100 da página (popScore: rank do Deezer / 10.000), pelo menos
-- 25 pontos acima do rank que valia 10 dias antes. O histórico guarda só
-- mudança (021), então "10 dias antes" é o último ponto gravado até aquele dia.
-- Contado em 21/11 nos 58 dias de medição diária: +15 dava 45 saltos por dia,
-- +20 dava 14, +25 dá ~4 e +30 dá ~1. O corte é parâmetro de detectar_saltos.
--
-- Ficam de fora:
--   - rank anterior exatamente 100.000, o valor que o Deezer dá a todo
--     lançamento novo antes de ter audiência (9 dos 80 maiores saltos de
--     21/11 eram isso: um álbum inteiro de 13/11 "saltando" junto);
--   - rank anterior abaixo de 10.000, que é ruído de medição, não audiência;
--   - faixa sem ponto gravado 10 dias antes (entrou há pouco no catálogo).
--
-- Um salto continua sendo o MESMO salto por 14 dias. Se a faixa segue subindo
-- enquanto ainda está pendente, o item é atualizado para o pico em vez de
-- abrir outro. Se já foi publicado ou ignorado, a subida seguinte nesses 14
-- dias é ignorada. Três meses depois, um novo estouro abre um item novo, e a
-- faixa passa a ter duas notas.
--
-- Pendente há mais de 30 dias vira "expirado": já é notícia velha.
--
-- ------------------------------------------------------------
-- QUEM PODE O QUÊ
-- ------------------------------------------------------------
-- As duas tabelas ficam fechadas (RLS ligado, sem política). O público lê só
-- notas publicadas, por `notas_da_faixa`, que é `security definer` e entra na
-- `get_track_page`. Detectar e moderar é do backend: as funções do painel só
-- são executáveis pela service_role, e a rota /admin/saltos confere o e-mail
-- do dono antes de usá-la (src/routes/admin.ts).

-- ---------------------------------------------------------------------------
-- 1. Índice para ler o histórico por dia
-- ---------------------------------------------------------------------------
-- O único índice útil era (track_uri, dia). Sem um por data, achar "o que
-- mudou hoje" varre as 2,4 milhões de linhas, e a chamada do backend corre
-- sob o limite de 8 s do PostgREST.

create index if not exists track_popularity_history_recorded_at_idx
  on public.track_popularity_history (recorded_at);

-- ---------------------------------------------------------------------------
-- 2. As tabelas
-- ---------------------------------------------------------------------------

create table if not exists public.notas_de_salto (
  id          bigint generated always as identity primary key,
  texto       text not null
              check (char_length(btrim(texto)) between 1 and 600),
  fonte_url   text
              check (fonte_url is null or fonte_url ~* '^https?://[^[:space:]]+$'),
  fonte_nome  text
              check (fonte_nome is null or char_length(fonte_nome) between 1 and 80),
  criada_em   timestamptz not null default now(),
  editada_em  timestamptz
);

comment on table public.notas_de_salto is
  'O porquê de um salto de audiência, escrito pelo dono no painel. Uma nota pode explicar vários saltos do mesmo dia (os funks da eleição). Ver migrations/052_notas_de_salto.sql';

create table if not exists public.saltos (
  id               bigint generated always as identity primary key,
  deezer_track_id  text not null
                   references public.observed_tracks (deezer_track_id) on delete cascade,
  -- dia (UTC) do ponto gravado no pico do salto
  dia              date not null,
  rank_antes       integer not null,
  rank_depois      integer not null,
  -- popScore(rank_depois) - popScore(rank_antes)
  pontos           integer not null,
  status           text not null default 'pendente'
                   check (status in ('pendente', 'publicado', 'ignorado', 'expirado')),
  nota_id          bigint references public.notas_de_salto (id),
  detectado_em     timestamptz not null default now(),
  decidido_em      timestamptz,
  constraint saltos_publicado_tem_nota
    check ((status = 'publicado') = (nota_id is not null))
);

comment on table public.saltos is
  'Saltos de audiência detectados pela rodada diária, na fila do painel do dono. Ver migrations/052_notas_de_salto.sql';

create index if not exists saltos_status_dia_idx
  on public.saltos (status, dia desc, pontos desc);
create index if not exists saltos_faixa_dia_idx
  on public.saltos (deezer_track_id, dia desc);
create index if not exists saltos_nota_idx
  on public.saltos (nota_id) where nota_id is not null;

alter table public.notas_de_salto enable row level security;
alter table public.saltos enable row level security;
revoke all on public.notas_de_salto from anon, authenticated;
revoke all on public.saltos from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Detecção — chamada no fim da rodada (src/jobs/catalogSnapshot.ts)
-- ---------------------------------------------------------------------------
-- Olha os pontos gravados entre p_desde e p_ate. A rodada passa os três
-- últimos dias, para que uma noite perdida não deixe salto para trás; rodar de
-- novo sobre os mesmos dias não duplica nada.

create or replace function public.detectar_saltos(
  p_desde       date    default (current_date - 2),
  p_ate         date    default current_date,
  p_min_pontos  integer default 25,
  p_janela      integer default 10
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_candidatos integer := 0;
  v_novos      integer := 0;
  v_crescidos  integer := 0;
  v_expirados  integer := 0;
  c            record;
  v_existente  record;
begin
  for c in
    with pontos as (
      -- Um salto de N pontos precisa de rank_depois >= N * 10.000 (menos o
      -- arredondamento). Corta a maioria das linhas antes do lateral.
      select substr(h.track_uri, 14) as deezer_track_id,
             h.track_uri,
             (h.recorded_at at time zone 'UTC')::date as dia,
             h.rank
      from public.track_popularity_history h
      where h.recorded_at >= (p_desde::timestamp at time zone 'UTC')
        and h.recorded_at <  ((p_ate + 1)::timestamp at time zone 'UTC')
        and h.track_uri like 'deezer:track:%'
        and h.rank >= p_min_pontos * 10000 - 5000
    ),
    com_base as (
      select p.*, b.rank as rank_antes
      from pontos p
      cross join lateral (
        select hb.rank
        from public.track_popularity_history hb
        where hb.track_uri = p.track_uri
          and (hb.recorded_at at time zone 'UTC')::date <= p.dia - p_janela
          and hb.rank is not null
        order by (hb.recorded_at at time zone 'UTC')::date desc
        limit 1
      ) b
    )
    select cb.deezer_track_id, cb.dia, cb.rank_antes, cb.rank,
           round(cb.rank / 10000.0)::integer - round(cb.rank_antes / 10000.0)::integer as pontos
    from com_base cb
    join public.observed_tracks o on o.deezer_track_id = cb.deezer_track_id
    where cb.rank_antes <> 100000
      and cb.rank_antes >= 10000
      and round(cb.rank / 10000.0)::integer - round(cb.rank_antes / 10000.0)::integer >= p_min_pontos
    order by cb.dia, pontos desc
  loop
    v_candidatos := v_candidatos + 1;

    select s.id, s.status, s.pontos
      into v_existente
      from public.saltos s
     where s.deezer_track_id = c.deezer_track_id
       and s.dia between c.dia - 14 and c.dia + 14
     order by s.dia desc
     limit 1;

    if not found then
      insert into public.saltos (deezer_track_id, dia, rank_antes, rank_depois, pontos)
      values (c.deezer_track_id, c.dia, c.rank_antes, c.rank, c.pontos);
      v_novos := v_novos + 1;
    elsif v_existente.status = 'pendente' and c.pontos > v_existente.pontos then
      update public.saltos
         set dia = c.dia,
             rank_antes = c.rank_antes,
             rank_depois = c.rank,
             pontos = c.pontos
       where id = v_existente.id;
      v_crescidos := v_crescidos + 1;
    end if;
  end loop;

  update public.saltos
     set status = 'expirado',
         decidido_em = now()
   where status = 'pendente'
     and dia < current_date - 30;
  get diagnostics v_expirados = row_count;

  return jsonb_build_object(
    'candidatos', v_candidatos,
    'novos',      v_novos,
    'crescidos',  v_crescidos,
    'expirados',  v_expirados
  );
end;
$$;

revoke all on function public.detectar_saltos(date, date, integer, integer) from public, anon, authenticated;
grant execute on function public.detectar_saltos(date, date, integer, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 4. O que a página de faixa lê
-- ---------------------------------------------------------------------------
-- Só notas publicadas, de qualquer edição com o mesmo ISRC (a curva mostra a
-- edição canônica, mas o salto pode ter sido detectado em outra). Uma nota que
-- explica dois saltos da mesma gravação aparece uma vez, no dia do maior.

create or replace function public.notas_da_faixa(p_isrc text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'dia',        x.dia,
        'pontos',     x.pontos,
        'texto',      n.texto,
        'fonte_url',  n.fonte_url,
        'fonte_nome', n.fonte_nome
      )
      order by x.dia
    ),
    '[]'::jsonb
  )
  from (
    select distinct on (s.nota_id) s.nota_id, s.dia, s.pontos
    from public.observed_tracks o
    join public.saltos s on s.deezer_track_id = o.deezer_track_id
    where o.isrc = p_isrc
      and s.status = 'publicado'
    order by s.nota_id, s.pontos desc, s.dia
  ) x
  join public.notas_de_salto n on n.id = x.nota_id;
$$;

revoke all on function public.notas_da_faixa(text) from public;
grant execute on function public.notas_da_faixa(text) to anon, authenticated, service_role;

-- get_track_page: igual à da 041, mais a chave `notas`.

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
    ),
    -- 052: o porquê dos saltos, escrito pelo dono. Vazio até a primeira nota.
    'notas', public.notas_da_faixa(p_isrc)
  );
$$;

grant execute on function public.get_track_page(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. O painel (/admin/saltos) — só service_role
-- ---------------------------------------------------------------------------

-- A fila de um status, com o que o dono precisa para pesquisar sem abrir a
-- página: a faixa, a curva do último mês (só os pontos de mudança, mais o que
-- valia no começo da janela) e as notas que a mesma gravação já tem.
create or replace function public.saltos_do_painel(
  p_status  text    default 'pendente',
  p_limite  integer default 200
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with escolhidos as (
    select s.*
    from public.saltos s
    where s.status = p_status
    order by
      case when p_status = 'pendente' then s.dia end desc,
      case when p_status = 'pendente' then s.pontos end desc,
      s.decidido_em desc nulls last,
      s.id desc
    limit greatest(1, least(p_limite, 500))
  )
  select jsonb_build_object(
    'contagem', (
      select jsonb_object_agg(st, coalesce(n, 0))
      from unnest(array['pendente', 'publicado', 'ignorado', 'expirado']) st
      left join (
        select status, count(*) as n from public.saltos group by status
      ) c on c.status = st
    ),
    'saltos', coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'id',          e.id,
            'dia',         e.dia,
            'rank_antes',  e.rank_antes,
            'rank_depois', e.rank_depois,
            'pontos',      e.pontos,
            'status',      e.status,
            'decidido_em', e.decidido_em,
            'faixa', jsonb_build_object(
              'deezer_track_id',  o.deezer_track_id,
              'deezer_artist_id', o.deezer_artist_id,
              'isrc',             o.isrc,
              'title',            o.title,
              'artist_name',      o.artist_name,
              'album_name',       o.album_name,
              'cover_md5',        o.cover_md5,
              'genre',            o.genre,
              'release_date',     o.release_date,
              'last_rank',        o.last_rank
            ),
            'nota', (
              select jsonb_build_object(
                'id', n.id, 'texto', n.texto,
                'fonte_url', n.fonte_url, 'fonte_nome', n.fonte_nome
              )
              from public.notas_de_salto n
              where n.id = e.nota_id
            ),
            'anteriores', coalesce(
              (
                select jsonb_agg(
                  jsonb_build_object('dia', s2.dia, 'pontos', s2.pontos, 'texto', n2.texto)
                  order by s2.dia
                )
                from public.saltos s2
                join public.notas_de_salto n2 on n2.id = s2.nota_id
                join public.observed_tracks o2 on o2.deezer_track_id = s2.deezer_track_id
                where s2.status = 'publicado'
                  and s2.id <> e.id
                  and (o2.deezer_track_id = o.deezer_track_id
                       or (o.isrc is not null and o2.isrc = o.isrc))
              ),
              '[]'::jsonb
            ),
            'serie', coalesce(
              (
                select jsonb_agg(jsonb_build_object('d', p.d, 'r', p.r) order by p.d)
                from (
                  (
                    select greatest(
                             (h.recorded_at at time zone 'UTC')::date,
                             e.dia - 30
                           ) as d,
                           h.rank as r
                    from public.track_popularity_history h
                    where h.track_uri = 'deezer:track:' || e.deezer_track_id
                      and h.rank is not null
                      and (h.recorded_at at time zone 'UTC')::date < e.dia - 30
                    order by (h.recorded_at at time zone 'UTC')::date desc
                    limit 1
                  )
                  union all
                  select (h.recorded_at at time zone 'UTC')::date, h.rank
                  from public.track_popularity_history h
                  where h.track_uri = 'deezer:track:' || e.deezer_track_id
                    and h.rank is not null
                    and (h.recorded_at at time zone 'UTC')::date >= e.dia - 30
                ) p
              ),
              '[]'::jsonb
            )
          )
          order by
            case when p_status = 'pendente' then e.dia end desc,
            case when p_status = 'pendente' then e.pontos end desc,
            e.decidido_em desc nulls last,
            e.id desc
        )
        from escolhidos e
        join public.observed_tracks o on o.deezer_track_id = e.deezer_track_id
      ),
      '[]'::jsonb
    )
  );
$$;

-- Publica uma nota para um ou mais saltos (os funks da eleição: uma nota só).
-- Devolve os ISRCs tocados, para o site saber que páginas mudaram.
create or replace function public.publicar_nota_de_salto(
  p_saltos      bigint[],
  p_texto       text,
  p_fonte_url   text default null,
  p_fonte_nome  text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_nota bigint;
  v_n    integer;
begin
  if coalesce(array_length(p_saltos, 1), 0) = 0 then
    raise exception 'Nenhum salto escolhido.';
  end if;

  insert into public.notas_de_salto (texto, fonte_url, fonte_nome)
  values (btrim(p_texto), nullif(btrim(p_fonte_url), ''), nullif(btrim(p_fonte_nome), ''))
  returning id into v_nota;

  update public.saltos
     set status = 'publicado', nota_id = v_nota, decidido_em = now()
   where id = any (p_saltos)
     and status <> 'publicado';
  get diagnostics v_n = row_count;

  if v_n = 0 then
    raise exception 'Esses saltos não existem ou já têm nota.';
  end if;

  return jsonb_build_object(
    'nota_id', v_nota,
    'saltos',  v_n,
    'isrcs', (
      select coalesce(jsonb_agg(distinct o.isrc), '[]'::jsonb)
      from public.saltos s
      join public.observed_tracks o on o.deezer_track_id = s.deezer_track_id
      where s.nota_id = v_nota and o.isrc is not null
    )
  );
end;
$$;

create or replace function public.editar_nota_de_salto(
  p_nota        bigint,
  p_texto       text,
  p_fonte_url   text default null,
  p_fonte_nome  text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.notas_de_salto
     set texto = btrim(p_texto),
         fonte_url = nullif(btrim(p_fonte_url), ''),
         fonte_nome = nullif(btrim(p_fonte_nome), ''),
         editada_em = now()
   where id = p_nota;
  if not found then
    raise exception 'Essa nota não existe.';
  end if;
  return jsonb_build_object('nota_id', p_nota);
end;
$$;

-- Tira a nota do ar: os saltos dela voltam para a fila e a nota é apagada.
create or replace function public.tirar_nota_de_salto(p_nota bigint)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n integer;
begin
  update public.saltos
     set status = 'pendente', nota_id = null, decidido_em = null
   where nota_id = p_nota;
  get diagnostics v_n = row_count;

  delete from public.notas_de_salto where id = p_nota;
  if not found then
    raise exception 'Essa nota não existe.';
  end if;
  return jsonb_build_object('nota_id', p_nota, 'saltos', v_n);
end;
$$;

-- Ignorar e desfazer. Salto publicado só sai pela tirar_nota_de_salto.
create or replace function public.marcar_saltos(p_saltos bigint[], p_status text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n integer;
begin
  if p_status not in ('ignorado', 'pendente') then
    raise exception 'Status inválido: %', p_status;
  end if;

  update public.saltos
     set status = p_status,
         decidido_em = case when p_status = 'pendente' then null else now() end
   where id = any (p_saltos)
     and status <> 'publicado';
  get diagnostics v_n = row_count;
  return jsonb_build_object('saltos', v_n);
end;
$$;

revoke all on function public.saltos_do_painel(text, integer) from public, anon, authenticated;
revoke all on function public.publicar_nota_de_salto(bigint[], text, text, text) from public, anon, authenticated;
revoke all on function public.editar_nota_de_salto(bigint, text, text, text) from public, anon, authenticated;
revoke all on function public.tirar_nota_de_salto(bigint) from public, anon, authenticated;
revoke all on function public.marcar_saltos(bigint[], text) from public, anon, authenticated;
grant execute on function public.saltos_do_painel(text, integer) to service_role;
grant execute on function public.publicar_nota_de_salto(bigint[], text, text, text) to service_role;
grant execute on function public.editar_nota_de_salto(bigint, text, text, text) to service_role;
grant execute on function public.tirar_nota_de_salto(bigint) to service_role;
grant execute on function public.marcar_saltos(bigint[], text) to service_role;

-- ---------------------------------------------------------------------------
-- 6. Primeira carga
-- ---------------------------------------------------------------------------
-- Os últimos 30 dias, para o painel não abrir vazio. Rodado à mão ao aplicar
-- (sem o limite de 8 s do PostgREST):
--
--   select public.detectar_saltos(current_date - 30, current_date);
