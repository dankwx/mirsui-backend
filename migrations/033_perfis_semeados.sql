-- 033_perfis_semeados.sql
-- O chão para os perfis semeados: onde a marca fica, e quem pode datá-los.
--
-- O PROBLEMA
-- O Mirsui tem 15 contas e uma ativa. O site vai ganhar perfis semeados —
-- username real colhido do Last.fm e levemente alterado, foto do acervo em
-- `/home/ubuntu/imagens`, 1–3 fichas escolhidas por IA, bio curta — e a
-- pergunta que esta migration responde não é "como criar", é "como apagar
-- depois". Se um dia a limpeza for `DELETE ... where username in (...)` com
-- uma lista guardada num arquivo que alguém perdeu, ela não acontece.
--
-- A regra: TODO perfil semeado fica marcado no banco, e a limpeza é um só
-- comando. E a marca não pode morar em coluna pública de `profiles` — um
-- `select('*')` escrito daqui a seis meses não pode vazar "este perfil é
-- fake" para quem lê a página do usuário.
--
-- AS TRÊS MARCAS
--
--   1. `auth.users.raw_app_meta_data = {"seeded": true, "seed_batch": "..."}`.
--      `app_metadata` é a parte do usuário que só a service role escreve: o
--      próprio usuário não edita (ao contrário de `user_metadata`) e ela não
--      aparece em nada que o site sirva sobre um perfil. É A chave da limpeza:
--
--        delete from auth.users where raw_app_meta_data->>'seeded' = 'true';
--
--      `auth.users → profiles → tracks / followers / stakes / ...` é tudo
--      `on delete cascade`, então esse DELETE leva o resto junto.
--
--   2. E-mail `<username>@seed.mirsui.invalid`. Não é tranca, é etiqueta:
--      `.invalid` é TLD reservado (RFC 2606), nunca resolve, e a lista de
--      contas no `/admin` mostra de longe quem é semeado.
--
--   3. A tabela de controle abaixo, `seeded_profiles`: qual JPEG virou o
--      avatar de quem (para o painel trocar e para a limpeza apagar o arquivo
--      certo em `imagens/usadas/`), qual era o handle ORIGINAL antes da
--      alteração, e de que lote. RLS ligada e ZERO policies, como a 030 fez com
--      `discovery_artists`: ninguém lê fora do backend. A relação "este id é
--      semeado" é exatamente o que o item acima quer esconder.
--
-- Sem coluna nova em `profiles`, sem mudança em nenhuma RLS existente.
--
-- A DATA DE ENTRADA
-- Conta criada hoje entra com `created_at = now()`. Cinquenta perfis com a
-- mesma data de cadastro, na mesma tarde, é o tipo de coisa que o painel
-- `/admin` mostra em `novas_30d` e que qualquer pessoa curiosa nota. As datas
-- precisam ficar espalhadas no passado — nunca antes de jun/2024, o mês em que
-- o Mirsui abriu — e `auth.users` não é tabela que o supabase-js escreva.
--
-- `seed_backdate_user(uuid, timestamptz)` é a única porta para isso: uma
-- função `security definer` que faz UPDATE em `auth.users` e SÓ em linhas com
-- `raw_app_meta_data->>'seeded' = 'true'`. Chamada contra um usuário real
-- ela não faz nada e devolve 0. Isso é de propósito: a função existe para
-- datar fakes e não tem como virar ferramenta para datar gente.
--
-- Ela ajusta três colunas: `created_at` (a data de cadastro), `last_sign_in_at`
-- (uma conta que nunca entrou desde 2025 é uma conta abandonada; a semeada
-- deve parecer que entrou ao menos uma vez) e `email_confirmed_at` (confirmar
-- o e-mail antes de criar a conta não faz sentido). `confirmed_at` é coluna
-- gerada a partir das outras e segue sozinha.
--
-- O FECHO
-- Mesmo da 019: Postgres dá EXECUTE para PUBLIC em toda função nova, e uma
-- `security definer` que escreve em `auth.users` sem o revoke abaixo seria
-- chamável por `POST /rest/v1/rpc/seed_backdate_user` com a anon key do
-- bundle. O `where seeded` limita o estrago a perfis fake, mas limitar não é
-- fechar. Só `service_role` executa.

-- 1. A tabela de controle -------------------------------------------------------

create table public.seeded_profiles (
  profile_id      uuid primary key references public.profiles(id) on delete cascade,
  image_file      text not null,          -- nome do JPEG em imagens/usadas/
  source          text not null,          -- 'lastfm'
  source_username text not null,          -- handle original, antes da alteração
  batch           text not null,
  created_at      timestamptz not null default now()
);

alter table public.seeded_profiles enable row level security;

-- Como na 030: RLS sem policy já fecha, o revoke é para que uma policy escrita
-- por reflexo não reabra sem que alguém decida reabrir também o grant.
revoke all on public.seeded_profiles from anon, authenticated;

comment on table public.seeded_profiles is
  'Perfis semeados: qual JPEG é o avatar de quem, o handle original e o lote. RLS ligada e sem policy: só service_role lê. A limpeza é pelo auth.users (raw_app_meta_data->>''seeded''), esta tabela vai no cascade. Ver migration 033.';

comment on column public.seeded_profiles.image_file is
  'Nome do arquivo em $SEED_IMAGENS_DIR/usadas/. Cada JPEG é usado por um perfil só: o script move o arquivo do pool para usadas/ ao usar.';

comment on column public.seeded_profiles.source_username is
  'O handle como foi colhido na fonte, antes da mutação leve que virou o username.';

-- 2. Datar no passado ------------------------------------------------------------

create or replace function public.seed_backdate_user(p_user_id uuid, p_created_at timestamptz)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  n integer;
begin
  -- Nunca antes de o Mirsui existir, nunca no futuro.
  if p_created_at < '2024-06-01'::timestamptz or p_created_at > now() then
    raise exception 'seed_backdate_user: data fora do intervalo permitido (%)', p_created_at;
  end if;

  update auth.users
     set created_at         = p_created_at,
         email_confirmed_at = p_created_at,
         last_sign_in_at    = p_created_at,
         updated_at         = p_created_at
   where id = p_user_id
     and raw_app_meta_data->>'seeded' = 'true';

  get diagnostics n = row_count;
  return n;
end;
$$;

revoke execute on function public.seed_backdate_user(uuid, timestamptz) from public;
revoke execute on function public.seed_backdate_user(uuid, timestamptz) from anon;
revoke execute on function public.seed_backdate_user(uuid, timestamptz) from authenticated;
grant  execute on function public.seed_backdate_user(uuid, timestamptz) to   service_role;

comment on function public.seed_backdate_user(uuid, timestamptz) is
  'Espalha a data de cadastro de um perfil SEMEADO no passado (created_at, email_confirmed_at, last_sign_in_at). Só toca linhas com raw_app_meta_data->>''seeded'' = ''true''; devolve quantas linhas mudaram (0 = não era semeado). Só service_role executa. Ver migration 033.';

-- Conferir o estado final:
--
--   select relrowsecurity from pg_class
--    where oid = 'public.seeded_profiles'::regclass;                -- t
--
--   select count(*) from pg_policies
--    where schemaname = 'public' and tablename = 'seeded_profiles';  -- 0
--
--   select grantee from information_schema.role_table_grants
--    where table_schema = 'public' and table_name = 'seeded_profiles'
--      and grantee in ('anon', 'authenticated');                    -- 0 linhas
--
--   select grantee from information_schema.routine_privileges
--    where routine_schema = 'public' and routine_name = 'seed_backdate_user'; -- supabase_admin, service_role
--
-- E a função contra um usuário real:
--
--   select public.seed_backdate_user('<uuid de conta real>', now() - interval '1 day');  -- 0
--
-- A LIMPEZA (quando chegar o dia)
--
--   delete from auth.users where raw_app_meta_data->>'seeded' = 'true';
--   -- e, na VPS: rm -rf $SEED_IMAGENS_DIR/usadas
