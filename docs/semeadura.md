# Semeadura de perfis — operação

Como criar, como cuidar e — o mais importante — como apagar. O porquê de cada
decisão está em `~/mirsui-web/docs/plano-semeadura-de-perfis.md`; a marca no
banco está explicada em `migrations/033_perfis_semeados.sql`.

## O que precisa existir antes

| coisa | onde | como conferir |
|---|---|---|
| migration 033 aplicada | `supabase-db` | `select proname from pg_proc where proname = 'seed_backdate_user'` devolve uma linha |
| `OPENROUTER_API_KEY` (e opcionalmente `OPENROUTER_MODEL`) | `.env` | `npm run seed:ia -- --n 2` responde com faixas e bio |
| `SUPABASE_PUBLIC_URL=https://db.mirsui.com` | `.env` | sem ela o `avatar_url` nasce com `127.0.0.1:54321` e a foto morre no navegador |
| pool de fotos | `$SEED_IMAGENS_DIR` (padrão `/home/ubuntu/imagens`), JPEGs na raiz | `ls /home/ubuntu/imagens/*.jpg \| wc -l` |
| handles do Last.fm | `seed/usernames.json` (gitignored) | `npm run seed:usernames -- --paginas 5` para colher mais |

## Criar

```bash
cd ~/mirsui-backend
npm run seed:perfis -- --n 20                    # lote = data de hoje
npm run seed:perfis -- --n 20 --lote 2026-09-12  # ou um nome de lote à mão
```

Por perfil, em sequência: handle não usado → username levemente alterado →
`auth.admin.createUser` (o trigger cria o `profiles`) → data de entrada sorteada
no passado (`seed_backdate_user`) → foto sorteada do pool e movida para
`usadas/` → IA escolhe 1–3 faixas e escreve (ou não) a bio → fichas em `tracks`
com `claimedat` depois da data de entrada → linha em `seeded_profiles`. Se
qualquer passo depois da conta falhar, a conta é apagada, a foto volta ao pool e
o script segue para o próximo. No fim do lote cada semeado passa a seguir 0–4
outros semeados.

Uma linha por perfil no terminal (`@username  foto=…  fichas=2  bio=sim`) e um
resumo. Handle já usado nunca é reaproveitado: rodar de novo cria outros.

## Cuidar

`https://www.mirsui.com/admin/perfis` (só o dono; qualquer outra conta recebe
404) lista os semeados — foto, `@username`, nome, JPEG, lote, nº de fichas,
data de entrada — e mostra quantas fotos ainda restam no pool.

- **Trocar foto**: sorteia outra do pool, sobe por cima do mesmo objeto no
  Storage, atualiza `avatar_url` (novo `?v=`) e `image_file`, e **apaga** o
  JPEG antigo de `usadas/` — ele já esteve no ar com esse perfil e não serviu.
  Pool vazio → 409 e o botão desabilita.
- **Apagar um perfil**: não tem botão; é uma chamada com o token do dono:

  ```bash
  curl -X DELETE https://api.mirsui.com/admin/seed/profiles/<uuid> \
    -H "Authorization: Bearer <access_token do dono>"
  ```

  Apaga o `auth.users` (o cascade leva `profiles`, `tracks`, `followers`,
  `stakes` e a linha de `seeded_profiles`), o objeto no Storage e o JPEG em
  `usadas/`.

As rotas de troca e de apagar só aceitam ids que estão em `seeded_profiles`:
mesmo com a service role, nunca alcançam um usuário real.

## Limpar tudo

Um comando no banco e um no disco. Nada mais precisa ser lembrado — a marca
mora em `auth.users.raw_app_meta_data`, que só a service role escreve.

```bash
# 1. banco: leva profiles, tracks, followers, stakes e seeded_profiles na cascata
sudo docker exec -i supabase-db psql -U supabase_admin -d postgres -c \
  "delete from auth.users where raw_app_meta_data->>'seeded' = 'true';"

# 2. storage: os objetos <uuid>/profile-picture ficam órfãos; apagar pelo Studio
#    (bucket user-profile-images) ou deixar — são ~100 KB cada e ninguém aponta para eles

# 3. disco: as fotos que estavam no ar
rm -rf /home/ubuntu/imagens/usadas
```

Para conferir antes de apagar: `select count(*) from auth.users where
raw_app_meta_data->>'seeded' = 'true'` deve bater com `select count(*) from
public.seeded_profiles`. E-mail `@seed.mirsui.invalid` é a mesma marca vista
pelo `/admin`.

Limpar um lote só: acrescente `and raw_app_meta_data->>'seed_batch' = '<lote>'`
ao `delete`, e apague de `usadas/` os arquivos listados por
`select image_file from seeded_profiles where batch = '<lote>'` **antes** do
delete (a cascata leva a lista junto).
