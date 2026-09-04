-- 032_o_que_o_dump_nao_levou.sql
-- Recria o que a migração para a VPS deixou para trás sem avisar.
--
-- O PROBLEMA
-- O dump da fase 2 saiu com `--schema=public`, mais os *dados* de `auth.users`
-- e `auth.identities`. Isso levou tudo que mora em `public` — as 17 tabelas, as
-- 46 funções, as 36 policies — e deixou para trás duas coisas que moram fora
-- dele e que ninguém tinha em arquivo nenhum, porque as duas foram criadas pelo
-- painel do Supabase e nunca por migration:
--
--   1. o trigger `on_auth_user_created` em `auth.users`
--   2. as policies de `storage.objects`
--
-- Um trigger pertence ao schema da TABELA, não ao da função. `handle_new_user`
-- é `public.handle_new_user` e veio no dump; o gatilho que a chama estava em
-- `auth` e não veio. A função ficou órfã, e órfã ela não dispara.
--
-- COMO ISSO APARECEU
-- Um cadastro de teste na fase 3: `auth.users` foi para 16 e `profiles` ficou
-- em 15. A varredura depois disso mostrou que `handle_new_user` era a única das
-- seis funções de trigger em `public` com zero gatilhos ligados — as outras
-- cinco estavam todas conectadas.
--
-- O QUE ISSO CUSTARIA SE PASSASSE
-- Toda conta criada depois da virada de DNS nasceria sem linha em `profiles`.
-- Não é erro visível: o `signUp` responde 201, o e-mail de confirmação chega,
-- o usuário confirma — e aí cai num site que não acha o perfil dele. O
-- `019_painel_do_dono.sql` já tinha visto essa possibilidade de longe ("uma
-- conta sem linha em profiles é..."); aqui ela deixaria de ser hipótese.
--
-- E o Storage: `storage.objects` estava com RLS ligado e ZERO policies. Isso
-- falha fechado, não aberto — ninguém vaza nada — mas é o outro lado do
-- `016_storage_fechado.sql`, que precisa existir para o dia em que um bucket
-- privado for criado.

-- 1. O trigger que faltava ------------------------------------------------------
-- O nome segue a convenção do próprio Supabase. O original não é recuperável:
-- o projeto na nuvem está restrito por cota e o painel não abre.

drop trigger if exists on_auth_user_created on auth.users;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 2. A leitura do Storage, de volta ---------------------------------------------
-- Idêntica à do 016. Efeito prático hoje é zero — os dois buckets são públicos
-- e o `/object/public` nem passa por RLS — e o ponto é exatamente esse: ela
-- existe para que um bucket privado criado amanhã não nasça legível por todos.

drop policy if exists "storage_select_buckets_publicos" on storage.objects;

create policy "storage_select_buckets_publicos"
  on storage.objects for select
  using (bucket_id in ('user-profile-images', 'playlist-thumbnails'));

-- As três policies de escrita escopadas por dono que o 016 preservou
-- ("Users can upload/update/delete their playlist thumbnails") NÃO voltam.
-- O gerenciador de playlists saiu do frontend na limpeza do legado, e hoje não
-- existe uma única chamada de `.upload()` ou `storage.from()` no cliente: o
-- avatar sobe por POST /profiles/:id/avatar, com service role, que ignora RLS.
-- Recriar policy de escrita para um caminho que ninguém mais usa só aumenta a
-- superfície. Se as playlists voltarem, elas voltam com a policy junto.
