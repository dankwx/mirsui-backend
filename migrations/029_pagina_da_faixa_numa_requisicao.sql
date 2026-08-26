-- 029_pagina_da_faixa_numa_requisicao.sql
-- A página de faixa passa a caber numa consulta só.
--
-- ------------------------------------------------------------
-- O PROBLEMA: o custo era o número de requisições, não o de bytes
-- ------------------------------------------------------------
-- Medido nos edge_logs em 25/08/2026, janela de 24h, já DEPOIS de a home virar
-- estática. O Supabase recebeu 121.415 requisições no dia; ~106 mil delas eram
-- da página de faixa, que renderiza ~19.700 vezes por dia e faz 5,4 requisições
-- REST em cada render:
--
--   observed_tracks?isrc=eq.X          252 bytes de corpo
--   rpc/get_track_curve                224 bytes
--   tracks (quem salvou, limit 8)       28 bytes
--   tracks HEAD (count exact)            0 bytes
--                                    -------
--                                      504 bytes de dado
--
-- E o cabeçalho de resposta do PostgREST tem 1.012 bytes — sempre, em toda
-- requisição, independente do que vier no corpo. Só o `set-cookie: __cf_bm` do
-- Cloudflare são ~330 deles.
--
-- Ou seja: a página trafegava ~640 bytes de dado e ~5.500 bytes de cabeçalho.
-- **89% do egress do projeto era protocolo, não conteúdo.** Otimizar `select`
-- não resolveria nada; o que precisa cair é a CONTAGEM de idas ao banco.
--
-- Daí esta função: as quatro consultas viram uma. ~5.750 bytes por render
-- passam a ~1.400.
--
-- ------------------------------------------------------------
-- POR QUE ELA CABE NUMA CONSULTA SÓ
-- ------------------------------------------------------------
-- As quatro são chaveadas pelo MESMO ISRC, e três delas já começam pela mesma
-- linha: a `canonica` — a gravação de maior rank entre os ids que o Deezer
-- mantém para o mesmo ISRC (single e faixa de álbum). Esse CTE é literalmente
-- o mesmo que a `get_track_curve` abre desde a migration 011.
--
-- A curva NÃO foi copiada para cá: esta função chama `get_track_curve(p_isrc)`.
-- Ela é a parte difícil (preenche buraco de medição, marca lacuna, e mudou
-- três vezes — migrations 020, 021, 022, 025). Duplicar aquilo aqui garantiria
-- que um dia as duas cópias divergiriam.
--
-- ------------------------------------------------------------
-- SEGURANÇA: INVOKER, de propósito
-- ------------------------------------------------------------
-- Sem `security definer`, igual à `get_track_curve`. As três tabelas lidas
-- (`observed_tracks`, `tracks`, `profiles`) têm política de SELECT com
-- qualificador `true` para anon e authenticated, então a função enxerga
-- exatamente as mesmas linhas que as quatro consultas enxergavam — nem uma a
-- mais. Se um dia alguma dessas políticas fechar, esta função fecha junto, que
-- é o comportamento certo.
--
-- ------------------------------------------------------------
-- O QUE NÃO ENTROU
-- ------------------------------------------------------------
-- `salvamentoDoUsuario` (se VOCÊ salvou esta faixa) continua em consulta
-- separada. Ela só roda para quem está logado — algumas dezenas de vezes por
-- dia contra as ~19.700 do robô — e é a única coisa da página que depende de
-- quem está olhando. Juntá-la aqui tornaria a resposta impossível de cachear
-- mais tarde, que é justamente o próximo passo (REVISITAR.md §3).

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
        'last_popularity',  c.last_popularity
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
    )
  );
$$;

comment on function public.get_track_page(text) is
  'A página da faixa numa requisição: linha do Observatório, curva, contagem de '
  'salvamentos e os 8 primeiros a salvar. Substitui 4 chamadas REST — ver o '
  'cabeçalho da migration 029 para o porquê (o custo era cabeçalho HTTP, não '
  'dado). Não inclui o salvamento do próprio usuário: esse depende de sessão.';

grant execute on function public.get_track_page(text) to anon, authenticated;

-- Conferir que a função devolve o mesmo que as quatro consultas devolviam:
--
--   select jsonb_pretty(public.get_track_page('GBDUW0000066'));
--
-- Esperado: `salvamentos` igual ao count da tabela, `quem_salvou` com o mesmo
-- tamanho e ordem, `curva` idêntica a get_track_curve() e `observada` com as
-- 11 colunas.
