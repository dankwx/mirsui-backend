-- 006_salvar_de_verdade.sql
-- Tira o like do produto e faz o "salvar" do feed salvar de verdade.
--
-- CONTEXTO
-- O feed narrava um salvamento ("fulano salvou", "3ª a salvar") mas o botão do
-- lado gravava em `track_likes` — outra tabela, outra ação, mesmo rótulo. Três
-- efeitos visíveis na tela:
--
--   1. O próprio achado do usuário aparecia com botão "Salvar", porque ele
--      tinha salvo a faixa mas nunca dado like na própria linha.
--   2. `track_likes.track_id` aponta para uma linha de `tracks`, que é o achado
--      de UMA pessoa e não a música. A mesma faixa salva por três pessoas dava
--      três botões independentes.
--   3. "3ª a salvar" vinha de `position` (salvamentos) e "12 também têm" vinha
--      de likes. Dois números de universos diferentes, lado a lado.
--
-- A unidade certa é `track_uri`: é por ela que `position` é calculada em
-- tracks/claim, e é ela que identifica a música independente de quem salvou.
--
-- Aplicar ANTES de subir o código — o código novo chama get_track_save_counts,
-- que só existe depois deste arquivo.

-- ------------------------------------------------------------
-- 1. Índice para as contagens por faixa
-- ------------------------------------------------------------
-- Nenhum índice cobria `track_uri` (ver 005: o que existe é
-- unique_user_track_url, sobre track_URL). As três queries que precisam dele:
--
--   where track_uri = X                        -> contagem de salvamentos
--   where user_id = M and track_uri in (...)   -> "quais destas eu salvei"
--   tracks/claim: as duas acima, uma por salvamento
--
-- Um índice só resolve as duas formas: (track_uri, user_id) lidera com
-- track_uri para a contagem, e ainda permite index-only scan no par com
-- user_id. É o mesmo raciocínio que o 005 aplicou a unique_track_like.
create index if not exists idx_tracks_track_uri_user
  on public.tracks (track_uri, user_id)
  where track_uri is not null;

-- ------------------------------------------------------------
-- 2. Contadores do feed, agora sem like
-- ------------------------------------------------------------
-- Substitui get_track_interaction_counts. Mesma forma de chamada (um array de
-- ids, uma ida ao banco para a página inteira), mas `likes_count` vira
-- `savers_count` — quantas pessoas salvaram AQUELA MÚSICA, contando por
-- track_uri em vez de por linha.
--
-- security definer pelo mesmo motivo do 004: track_comments não tem policy de
-- select versionada, e a contagem é pública de qualquer forma.
--
-- Faixa sem track_uri (dado antigo) conta 1: a linha existe, então alguém
-- salvou. Sem o case, a subquery devolveria 0 e a tela diria que ninguém salvou
-- uma faixa que está ali justamente porque foi salva.
create or replace function public.get_track_save_counts(p_track_ids integer[])
returns table (
  track_id       integer,
  savers_count   bigint,
  comments_count bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select
    t.id as track_id,
    case
      when t.track_uri is null then 1::bigint
      else (
        select count(*)
        from public.tracks s
        where s.track_uri = t.track_uri
          and s.claimedat is not null
      )
    end as savers_count,
    (select count(*) from public.track_comments c where c.track_id = t.id) as comments_count
  from public.tracks t
  where t.id = any(coalesce(p_track_ids, '{}'::integer[]));
$$;

grant execute on function public.get_track_save_counts(integer[]) to anon, authenticated;

-- A antiga contava like; nada mais a consome depois deste deploy.
drop function if exists public.get_track_interaction_counts(integer[]);

-- ------------------------------------------------------------
-- 3. A tabela track_likes
-- ------------------------------------------------------------
-- Depois deste migration nenhum código do backend ou do front lê ou escreve em
-- track_likes. A tabela fica órfã, mas NÃO é derrubada aqui: drop de tabela com
-- dados não tem volta, e o custo de deixá-la parada é zero.
--
-- Para remover de vez, rode à mão quando tiver certeza (e de preferência depois
-- de um backup):
--
--   drop table if exists public.track_likes;
--
-- Os índices idx_track_likes_track_id e unique_track_like saem junto com ela.
