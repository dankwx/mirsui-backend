-- 019_painel_do_dono.sql
-- Uma função que devolve o estado inteiro do Mirsui em um JSON só.
--
-- POR QUE UMA FUNÇÃO, E NÃO QUINZE QUERIES NO NODE
-- O painel precisa de coisas que o RLS esconde de propósito: `auth.users` (data
-- de cadastro, último acesso, e-mail confirmado) e as fichas de TODO mundo, já
-- que `stakes_select_own` só mostra as do próprio usuário. Fazer isso no Node
-- com a service role daria uns quinze roundtrips soltos, cada um bypassando o
-- RLS por conta própria, e a lista do que o painel enxerga ficaria espalhada
-- por um arquivo de rota de 300 linhas.
--
-- Aqui é uma superfície só. Quem pode ler o painel é quem pode executar esta
-- função, e isso está escrito embaixo, em duas linhas de grant.
--
-- O FECHO
-- Postgres dá EXECUTE para PUBLIC em toda função nova, então `security definer`
-- sem o revoke abaixo seria o contrário do que este arquivo quer: qualquer
-- pessoa logada (a anon key está no bundle JS) chamaria
-- `POST /rest/v1/rpc/admin_overview` e receberia a base de e-mails inteira.
-- O revoke é a parte que importa; o grant para `service_role` é só para o
-- backend, que já roda com a chave que ignora RLS de qualquer jeito.
--
-- A segunda tranca mora no Node (`src/lib/admins.ts`): a rota
-- `GET /admin/overview` confere o e-mail do token antes de chamar isto aqui.
-- Duas trancas porque a service role key não distingue um dono do outro.
--
-- SOBRE `claimedat`
-- `tracks.claimedat` é `timestamp without time zone` (dado antigo, de antes de
-- o resto do banco padronizar em timestamptz). Ele é gravado em UTC, mas sem o
-- fuso o JSON sai "2026-06-12T02:07:55" e o `new Date()` do navegador lê como
-- horário LOCAL — três horas de erro em toda conta "há quantos dias". Por isso
-- todo `claimedat` que sai daqui passa por `at time zone 'utc'`, que carimba o
-- fuso que o valor sempre teve.

create or replace function public.admin_overview()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
with
contas as (
  select
    count(*)::int                                                                   as total,
    count(*) filter (where u.email_confirmed_at is not null)::int                   as confirmadas,
    count(*) filter (where u.last_sign_in_at is null)::int                          as nunca_entraram,
    count(*) filter (where u.created_at > now() - interval '30 days')::int          as novas_30d,
    count(*) filter (where u.last_sign_in_at > now() - interval '30 days')::int     as ativas_30d,
    max(u.created_at)                                                               as ultima
  from auth.users u
),
achados as (
  select
    count(*)::int                                                                   as total,
    count(distinct t.track_uri)::int                                                as faixas,
    count(distinct t.user_id)::int                                                  as pessoas,
    count(*) filter (
      where t.claim_message is not null and btrim(t.claim_message) <> ''
    )::int                                                                          as com_recado,
    (min(t.claimedat) at time zone 'utc')                                           as primeiro,
    (max(t.claimedat) at time zone 'utc')                                           as ultimo
  from tracks t
),
fichas as (
  select
    count(*) filter (where s.status = 'ativa')::int                                 as ativas,
    count(*) filter (where s.status = 'coletada')::int                              as coletadas,
    count(*) filter (where s.status = 'removida')::int                              as removidas,
    count(distinct s.user_id)::int                                                  as pessoas,
    coalesce(sum(s.accumulated_points) filter (where s.status = 'ativa'), 0)::int    as pontos_na_mesa,
    (select count(*) from stake_snapshots)::int                                     as medicoes,
    (select max(recorded_at) from stake_snapshots)                                  as ultima_medicao,
    (select count(*) from stake_collections)::int                                   as coletas,
    (select coalesce(sum(points), 0) from stake_collections)::int                   as pontos_coletados
  from stakes s
),
observatorio as (
  select
    count(*)::int                                                                   as faixas,
    count(*) filter (where o.active)::int                                           as ativas,
    count(*) filter (where o.spotify_track_id is not null)::int                     as com_spotify,
    count(*) filter (where o.isrc is not null)::int                                 as com_isrc,
    count(*) filter (where o.last_checked_at > now() - interval '24 hours')::int    as medidas_24h,
    count(distinct o.genre)::int                                                    as generos,
    max(o.last_checked_at)                                                          as ultima_medicao,
    (select count(*) from track_popularity_history)::int                            as historico,
    (select count(*) from track_popularity_history
      where recorded_at > now() - interval '24 hours')::int                         as historico_24h
  from observed_tracks o
),
social as (
  select
    (select count(*) from followers)::int                                           as seguidas,
    (select count(*) from profile_comments)::int                                    as recados,
    (select count(*) from track_comments)::int                                      as comentarios,
    (select count(*) from favorites)::int                                           as favoritas,
    (select count(*) from youtube_cache)::int                                       as youtube_cache
),

-- A faixa de meses começa no primeiro registro que existe, não numa janela
-- fixa: com 46 salvamentos em dois anos, uma janela de 12 meses mostraria
-- exclusivamente zeros e esconderia justamente onde houve movimento. O teto de
-- 36 meses existe só para a barra não virar um fio de cabelo em 2030.
janela as (
  select greatest(
    date_trunc('month', coalesce(
      least(
        (select min(created_at at time zone 'utc') from auth.users),
        (select min(claimedat) from tracks)
      ),
      now() at time zone 'utc'
    )),
    date_trunc('month', (now() at time zone 'utc')) - interval '35 months'
  ) as inicio
),
meses as (
  select coalesce(jsonb_agg(x order by x.mes), '[]'::jsonb) as lista
  from (
    select
      to_char(m.mes, 'YYYY-MM') as mes,
      (select count(*) from auth.users u
        where date_trunc('month', u.created_at at time zone 'utc') = m.mes)::int as contas,
      (select count(*) from tracks t
        where date_trunc('month', t.claimedat) = m.mes)::int                     as achados,
      (select count(*) from stakes s
        where date_trunc('month', s.staked_at at time zone 'utc') = m.mes)::int  as fichas
    from janela j,
         generate_series(
           j.inicio,
           date_trunc('month', (now() at time zone 'utc')),
           interval '1 month'
         ) as m(mes)
  ) x
),

-- Sai de `auth.users`, não de `profiles`: uma conta sem linha em profiles é
-- exatamente o tipo de coisa que um painel existe para mostrar, e um join na
-- outra direção a esconderia.
pessoas as (
  select coalesce(jsonb_agg(x order by x.entrou desc), '[]'::jsonb) as lista
  from (
    select
      u.id,
      p.username,
      p.display_name                                                             as nome,
      u.email,
      u.created_at                                                               as entrou,
      u.last_sign_in_at                                                          as ultimo_acesso,
      (u.email_confirmed_at is not null)                                         as confirmada,
      (select count(*) from tracks t  where t.user_id = u.id)::int               as achados,
      (select count(*) from stakes s  where s.user_id = u.id
        and s.status = 'ativa')::int                                             as fichas,
      (select count(*) from followers f where f.following_id = u.id)::int        as seguidores
    from auth.users u
    left join profiles p on p.id = u.id
  ) x
),
mesa as (
  select coalesce(jsonb_agg(x order by x.pontos desc), '[]'::jsonb) as lista
  from (
    select
      s.id,
      s.track_title                                                              as titulo,
      s.artist_name                                                              as artista,
      s.track_thumbnail                                                          as capa,
      p.username,
      s.multiplier::float8                                                       as multiplicador,
      s.baseline_popularity                                                      as base,
      s.last_popularity                                                          as atual,
      s.accumulated_points                                                       as pontos,
      s.staked_at                                                                as desde,
      s.last_checked_at                                                          as medida_em,
      (select count(*) from stake_snapshots ss where ss.stake_id = s.id)::int    as medicoes
    from stakes s
    left join profiles p on p.id = s.user_id
    where s.status = 'ativa'
  ) x
),

-- Por `track_uri`, nunca por linha: cada pessoa que salva a mesma música cria
-- uma linha própria em `tracks`. Ver 006_salvar_de_verdade.sql.
mais_salvas as (
  select coalesce(jsonb_agg(x order by x.salvamentos desc, x.ultimo desc), '[]'::jsonb) as lista
  from (
    select
      t.track_uri                                                                as uri,
      min(t.track_title)                                                         as titulo,
      min(t.artist_name)                                                         as artista,
      min(t.track_thumbnail)                                                     as capa,
      count(*)::int                                                              as salvamentos,
      (max(t.claimedat) at time zone 'utc')                                      as ultimo
    from tracks t
    where t.track_uri is not null
    group by t.track_uri
    order by count(*) desc, max(t.claimedat) desc
    limit 6
  ) x
),

-- Tudo o que aconteceu, de todas as tabelas, numa lista só. É a pergunta que o
-- painel responde melhor que o Studio: "o que foi a última coisa que alguém
-- fez aqui?" exige olhar seis tabelas e comparar seis timestamps na mão.
registros as (
  select coalesce(jsonb_agg(x order by x.quando desc), '[]'::jsonb) as lista
  from (
    select
      y.tipo, y.quando, y.quem, y.titulo, y.artista, y.detalhe
    from (
      select
        'conta'::text                                        as tipo,
        u.created_at                                         as quando,
        coalesce(p.username, split_part(u.email, '@', 1))    as quem,
        null::text                                           as titulo,
        null::text                                           as artista,
        null::text                                           as detalhe
      from auth.users u
      left join profiles p on p.id = u.id

      union all
      select
        'achado',
        (t.claimedat at time zone 'utc'),
        p.username,
        t.track_title,
        t.artist_name,
        nullif(btrim(coalesce(t.claim_message, '')), '')
      from tracks t
      left join profiles p on p.id = t.user_id

      union all
      select
        'ficha',
        s.staked_at,
        p.username,
        s.track_title,
        s.artist_name,
        -- Só o número, cru. A vírgula decimal e o "x" no fim são decisão de
        -- tela, e a tela já formata o mesmo multiplicador em "A mesa": se a
        -- string sair pronta daqui, os dois lugares divergem na primeira vez
        -- que um deles mudar de ideia.
        trim(to_char(s.multiplier, 'FM990.00'))
      from stakes s
      left join profiles p on p.id = s.user_id

      union all
      select
        'recado',
        c.created_at,
        a.username,
        null,
        null,
        left(c.content, 90)
      from profile_comments c
      left join profiles a on a.id = c.author_id

      union all
      select
        'comentario',
        c.created_at,
        a.username,
        t.track_title,
        t.artist_name,
        left(c.comment_text, 90)
      from track_comments c
      left join profiles a on a.id = c.user_id
      left join tracks t   on t.id = c.track_id

      union all
      select
        'seguiu',
        f.created_at,
        a.username,
        null,
        null,
        b.username
      from followers f
      left join profiles a on a.id = f.follower_id
      left join profiles b on b.id = f.following_id
    ) y
    order by y.quando desc
    limit 24
  ) x
)

select jsonb_build_object(
  'gerado_em',    now(),
  'contas',       to_jsonb(c),
  'achados',      to_jsonb(a),
  'fichas',       to_jsonb(f),
  'observatorio', to_jsonb(o),
  'social',       to_jsonb(so),
  'meses',        m.lista,
  'pessoas',      pe.lista,
  'mesa',         me.lista,
  'maisSalvas',   ms.lista,
  'registros',    re.lista
)
from contas c, achados a, fichas f, observatorio o, social so,
     meses m, pessoas pe, mesa me, mais_salvas ms, registros re;
$$;

-- A parte que fecha a porta. Sem isto, `security definer` entrega auth.users
-- para qualquer sessão autenticada.
revoke execute on function public.admin_overview() from public;
revoke execute on function public.admin_overview() from anon;
revoke execute on function public.admin_overview() from authenticated;
grant  execute on function public.admin_overview() to   service_role;

comment on function public.admin_overview() is
  'Estado geral do Mirsui para o painel do dono. Ignora RLS de propósito: só a service role executa, e o backend confere o e-mail antes de chamar. Ver migrations/019_painel_do_dono.sql.';
