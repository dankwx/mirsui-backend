# Mirsui Backend

API REST do Mirsui, construída com [Fastify](https://fastify.dev/) + [Supabase](https://supabase.com/) (Auth e Postgres), executada com [tsx](https://tsx.is/) (TypeScript sem build).

## Como rodar

```bash
# 1. Instalar dependências
npm install

# 2. Configurar variáveis de ambiente
cp .env.example .env
# preencha SUPABASE_URL e SUPABASE_KEY

# 3. Subir em desenvolvimento (hot reload)
npm run dev

# Produção
npm start

# Checagem de tipos
npm run typecheck
```

O servidor sobe em `http://0.0.0.0:3000` (configurável via `PORT`).

### Variáveis de ambiente

| Variável | Obrigatória | Descrição |
|---|---|---|
| `SUPABASE_URL` | Sim | URL do projeto Supabase |
| `SUPABASE_PUBLIC_URL` | Não | Host do Supabase que o navegador alcança (`https://db.mirsui.com`). Na VPS `SUPABASE_URL` é loopback, e sem esta as URLs de avatar nasceriam com `127.0.0.1` |
| `SUPABASE_KEY` | Sim | Chave do Supabase. **Obs:** `POST /auth/logout` usa `auth.admin.signOut()`, que exige a service role key — com a anon key o logout no servidor falha silenciosamente (o cliente ainda recebe sucesso) |
| `SUPABASE_SERVICE_ROLE_KEY` | Sim em produção | Chave privada usada exclusivamente pelos jobs do Observatório e dos Stakes; nunca vai para o frontend |
| `FRONTEND_URL` | Não | Origem extra permitida no CORS e destino padrão do link de reset de senha |
| `PORT` | Não | Porta do servidor (padrão: `3000`) |
| `OBS_DESCOBERTA_ATIVA` | Não | Liga a descoberta diária (padrão: `true`) |
| `OBS_DESCOBERTA_META_INICIAL` | Não | Meta da expansão inicial do catálogo (padrão: `6604`) |
| `OBS_LIMITE_DESCOBERTA` | Não | Novas faixas por dia depois da meta inicial (padrão: `250`) |
| `OBS_MAX_CATALOGO` | Não | Teto rígido de faixas ativas no Observatório (padrão: `10000`). Vale só para a descoberta — faixa que entra por chart não passa por ele. **Não anda sozinho: subir este sem subir `OBS_ORCAMENTO_MEDICAO` faz a fila de medição parar de drenar** — ver a revisão de 26/08 na [análise de escala](docs/analise-escala-apis-e-banco.md) |
| `OBS_ORCAMENTO_MEDICAO` | Não | Teto de requisições da etapa 3, a medição do catálogo (padrão: `12000`). **É o mecanismo, não um freio de emergência**: quando a fila vencida passa dele, o resto fica para amanhã e volta como `adiadas` no log. Um `adiadas` teimosamente alto significa orçamento pequeno demais para o tamanho do catálogo. **Confira `filaLida` ao lado dele**: se vier menor que `min(filaVencida, orcamento)`, o orçamento não é o que está cortando — ver a migration 031 |
| `OBS_CADENCIA_MORNA` / `OBS_CADENCIA_FRIA` | Não | De quantos em quantos dias a faixa morna e a fria são medidas (padrão: `7` e `14`). A fria manda na conta: é ~70% da massa num catálogo maduro |
| `OBS_LOTE_CADENCIA` | Não | Quantas faixas o recálculo de cadência trata por chamada (padrão: `20000`). O job repete a chamada até acabar o catálogo — **o laço é de fora de propósito**, porque `statement_timeout` é armado para a chamada e paginar por dentro não moveria o relógio. Medido em 20/09/2026 com 82 mil faixas: ~300 ms por lote, contra 19,4 s do catálogo inteiro num statement só, que é como o passo morria de timeout desde 17/09. Ver a **migration 035** |
| `OBS_JANELA_MOVIMENTO` / `OBS_JANELA_NOVIDADE` | Não | Em dias, o que mantém uma faixa quente: ter mudado de rank, ou ter entrado no catálogo (padrão: `30` para as duas). Faixa nova nasce quente por 30 dias — é por isso que um catálogo jovem é 100% quente |
| `OBS_LIMITE_CHART` | Não | Faixas pedidas por chart de gênero (padrão: `300`, que é o teto do endpoint). Baixar reduz a rodada e o crescimento do catálogo |
| `OBS_DESCOBERTA_SPLIT_ALBUM` | Não | Fração do orçamento da descoberta que vai para a caminhada por álbum (padrão: `0.7`). `0` volta ao comportamento só-rádio do ADR 001 |
| `OBS_DESCOBERTA_MAX_FAS` | Não | Teto de fãs para um artista entrar na fronteira da caminhada (padrão: `50000`). É o dial de obscuridade |
| `OBS_DESCOBERTA_RELACIONADOS` | Não | Artistas que cada semente contribui à fronteira (padrão: `3`) |
| `OBS_DESCOBERTA_FRONTEIRA_MIN` | Não | Abaixo disto a fronteira é reabastecida com sementes do catálogo (padrão: `50`) |
| `OBS_DESCOBERTA_ALBUNS_POR_ARTISTA` | Não | Álbuns colhidos por artista por noite (padrão: `6`) |
| `SEED_IMAGENS_DIR` | Não | Pasta com os JPEGs para os perfis semeados (padrão: `/home/ubuntu/imagens`). Foto usada é movida para `usadas/` dentro dela — nunca repete |
| `OPENROUTER_API_KEY` | Só para `seed:perfis`/`seed:ia` | Chave do OpenRouter que escolhe as faixas e escreve a bio dos perfis semeados |
| `OPENROUTER_MODEL` | Não | Modelo no OpenRouter (padrão: `tencent/hy4-preview` — ~US$ 0,0004 por perfil com o raciocínio desligado) |

O servidor **não sobe** sem `SUPABASE_URL` e `SUPABASE_KEY` (validado em `src/lib/supabase.ts`).

`SPOTIFY_CLIENT_ID` e `SPOTIFY_CLIENT_SECRET` são **opcionais** desde 15/08/2026.
A fonte de metadado e de métrica é o Deezer, que não pede chave. O que o Spotify
ainda faz é dizer qual é o id dele para uma gravação que já identificamos por
ISRC, para o botão "ouvir no Spotify" cair na faixa exata em vez de cair numa
busca — enriquecimento, não requisito. Ver
[`docs/plano-independencia-do-spotify.md`](docs/plano-independencia-do-spotify.md).

### Jobs diários

- **05:00 — Observatório:** atualiza charts, mede o catálogo, completa o ISRC
  (que é o endereço das páginas do site) e, por último, descobre faixas
  semelhantes pelo rádio de artista do Deezer. A primeira expansão tenta chegar
  a 6.604 faixas; depois cresce no máximo 250 por dia, até 10 mil.

  **Esses são os padrões do código, e a produção não está neles.** Medido em
  26/08/2026: **15.635 faixas ativas, crescendo ~1.100/dia** — as envs foram
  subidas sem que nenhum commit registrasse.

  A medição tinha parado de acompanhar — 4.909 numa rodada, 6.285 faixas com
  mais de 3 dias sem medição — e a causa **não era o orçamento**. `db.rpc()` vai
  por PostgREST, PostgREST corta toda resposta em `db-max-rows`, e a fila da
  etapa 3 chegava ao processo com 1.000 linhas enquanto o orçamento dizia
  12.000. Prendia a etapa em 1.000 faixas por noite desde a migration 025, sem
  erro nenhum. Corrigido pela **migration 031** (ordem total na fila) mais a
  volta da paginação no job. Antes de mexer em qualquer `OBS_*`, ler as revisões
  de 26/08 em [`docs/analise-escala-apis-e-banco.md`](docs/analise-escala-apis-e-banco.md).

  A etapa que resolvia ISRC → id do Spotify **saiu da rodada**: eram 2.027
  buscas por noite, era a parte que mais falhava e escalava com o tamanho do
  catálogo. Virou resolução preguiçosa em `POST /tracks/resolve-spotify` — quem
  abre a página de uma faixa resolve aquela faixa, uma vez, para sempre.
- **09:00 — Stakes:** mede os stakes ativos e credita a evolução diária.

#### Onde está o log da rodada

`pm2 logs mirsui-backend` — e o processo tem que estar em **fork mode**, não
cluster. Em cluster o pm2 captura log interceptando `process.stdout.write` do
worker; o worker é o `npm`, e o `tsx` é um neto que escreve direto no fd 1, que
herdou do daemon. Resultado, medido em 12/09/2026: `mirsui-backend-out-0.log`
com 27 linhas de `> tsx src/server.ts` e nada mais, e três meses de log do
Observatório enterrados em `~/.pm2/pm2.log`. Se `pm2 describe mirsui-backend`
disser `cluster_mode`, recrie: `pm2 delete mirsui-backend && pm2 start npm
--name mirsui-backend -- start && pm2 save`.

O que ler numa rodada, do fim para o começo:

- `Observatório: rodada concluída` — o objeto inteiro, com `deezer: {ok, http,
  quotaEsgotada, rede, amostra}`. **`descobertaFalhasApi ≈ 1.000 com
  descobertaNovas: 0` é o Deezer, não o código** — foi assim em 7 das 16 noites
  entre 27/08 e 11/09, e `deezer.amostra` diz o que ele devolveu e a que hora.
- `Observatório: Deezer não respondeu parte da fila de medição` (warn) — a
  etapa 3 teve `naoRespondidas > 0`. Subir `OBS_ORCAMENTO_MEDICAO` não resolve
  isso; só `foraDoOrcamento > 0` pede orçamento.
- `deezer.bloqueios` / `esperaBloqueioMs` — quantas vezes uma requisição
  deste processo esperou e repetiu, por qualquer motivo: onda de **HTTP 403**
  do Deezer, gateway cheio (`busy`) ou espera de 120 s na fila vencida
  (`queue_timeout`). **Não é só o Deezer**: na rodada de 15/09/2026 foram 197
  bloqueios com o gateway registrando zero ondas — era a fila, e a rádio passou
  a pedir em blocos por isso. Quem diz se o Deezer bloqueou é `blockedWaves`
  no log do `mirsui-deezer-gateway`. Medido em 13/09/2026, a 8 req/s: 403
  depois de ~5.000 requisições em 10 min, em ondas de 5–10 min, 9.052
  requisições perdidas; a 3 req/s não houve onda nenhuma desde então. O 403
  freia a fila e repete (`dz()` em `src/lib/deezerCatalog.ts`); a rodada fica
  mais longa, não mais curta. `http.403 > 0` ainda assim significa bloqueio de
  mais de ~27 min contínuos.
- `Observatório: o Deezer falhou em requisições desta rodada` (warn) — o mesmo
  resumo, no nível certo para um `grep '"level":40'`.

A descoberta é idempotente por semente, não marca falhas transitórias como
concluídas e grava faixa, histórico e linhagem na mesma transação. A decisão,
os motivos e o procedimento de desligamento estão em
[`docs/decisions/001-descoberta-controlada-de-faixas.md`](docs/decisions/001-descoberta-controlada-de-faixas.md).

### Semeadura de perfis

Perfis semeados para povoar o site — username real do Last.fm levemente
alterado, foto do acervo, 1–3 fichas por IA, bio curta — todos marcados no banco
(`auth.users.raw_app_meta_data->>'seeded'`, e-mail `@seed.mirsui.invalid`, tabela
`seeded_profiles`) para que a limpeza seja um `DELETE` só. Plano completo em
`~/mirsui-web/docs/plano-semeadura-de-perfis.md`; migration em
`migrations/033_perfis_semeados.sql`.

```bash
npm run seed:usernames -- --paginas 5   # colhe handles no Last.fm → seed/usernames.json (gitignored)
npm run seed:ia -- --n 5                # ensaio da IA, sem banco: brief, faixas, bio e tokens por chamada
npm run seed:perfis -- --n 20           # cria 20 perfis (conta, data no passado, foto, fichas, bio, follows)
```

Depois de criados, o painel `/admin/perfis` do site lista os semeados e troca a
foto de quem saiu estranho. Como usar, como apagar um e **como limpar tudo**
está em [`docs/semeadura.md`](docs/semeadura.md).

A IA (`src/seed/openrouter.ts`) recebe um brief sorteado por perfil — dois
gêneros, década, idioma, e um ou dois traços que mudam de eixo (signo, MBTI,
idade, cidade, ocupação, mania…) — mais a lista das últimas 60 faixas do lote
como "não repita". A bio, quando existe (~60%), sai de um estilo e de um assunto
sorteados (frase de filme, gíria de internet, só emoji, status de MSN…) e é
proibida de citar qualquer coisa do brief. As faixas são resolvidas no Deezer
com um casamento frouxo de artista/título; o que não casa é pulado.

O Last.fm devolve `406 Rate Limited` a partir de ~10 requisições por minuto: o
script anda a 5–9 s por requisição e, num 406, espera 3 min e tenta a mesma
página de novo. Rodar de novo soma ao arquivo; nada é perdido.

## Estrutura do projeto

```
src/
├── server.ts          # Entry point: cria o app e dá listen
├── app.ts             # Monta o app: CORS, rate limit, error handler global, registro das rotas
├── lib/
│   └── supabase.ts    # Cliente Supabase compartilhado + tipo Profile
├── plugins/
│   └── auth.ts        # Autenticação por Bearer token (requireAuth / getOptionalUser)
└── routes/
    ├── health.ts      # GET / e GET /health
    ├── auth.ts        # Signup, login, logout, refresh, verify, me, reset de senha
    ├── profiles.ts    # Leitura e atualização de profiles
    ├── feed.ts        # Feed de posts, claims recentes, likes do usuário
    ├── tracks.ts      # Likes e comentários de tracks
    ├── claims.ts      # Reivindicação de músicas
    └── user.ts        # Pontos do usuário
```

### Convenções

- **Autenticação**: rotas protegidas usam o preHandler `requireAuth` (`src/plugins/auth.ts`), que valida o header `Authorization: Bearer <access_token>` no Supabase e popula `request.user`. Rotas com auth opcional usam `getOptionalUser`.
- **Erros**: não há try/catch por rota. Erros inesperados caem no `setErrorHandler` em `src/app.ts` e viram `500 { "error": "Erro interno do servidor" }`. Erros esperados (validação, não encontrado, etc.) são respondidos na própria rota.
- **Respostas de erro** sempre têm o formato `{ "error": "mensagem" }`.

### Rate limiting

Global: **100 requisições / 15 minutos por usuário**. Limites mais restritos por rota:

| Rota | Limite | Chave |
|---|---|---|
| (global) | 100 / 15 min | `user:<sub do JWT>`, ou o IP se anônimo |
| `POST /auth/signup` | 5 / hora | email do corpo |
| `POST /auth/login` | 5 / minuto | email do corpo |
| `POST /auth/reset-password` | 3 / hora | email do corpo |

**Não é por IP, de propósito.** O frontend Next chama este backend sempre do
servidor (server components e route handlers), nunca do browser. Então
`request.ip` é sempre o mesmo endereço e um limite por IP colocaria a base
inteira num balde só — os 100/15min valeriam pro app todo, ~6,7 req/min. As
chaves ficam em `src/lib/rateLimitKeys.ts`:

- `identityKey` (global): lê o `sub` do JWT do Supabase **sem verificar a
  assinatura**, porque a verificação de verdade é o `requireAuth` e aqui o valor
  só separa baldes. Usa o `sub` em vez do hash do token cru porque o access
  token rotaciona a cada ~1h e senão o balde zeraria a cada refresh. Cai no IP
  quando não há token.
- `emailKey` (rotas de auth): essas rotas não têm header `Authorization`, então
  a chave é o email do corpo, normalizado e hasheado. Exige
  `hook: 'preValidation'` na config da rota, porque o hook padrão do plugin é
  `onRequest`, que roda antes do parsing e não vê `request.body`.

**Limitação conhecida:** leitura anônima (rotas com `getOptionalUser` — feed,
tracks e profiles públicos) continua num balde compartilhado, porque sem token
não há identidade pra chavear. Fechar isso exige o frontend repassar o IP real
do visitante num header e o Fastify subir com `trustProxy`. `POST /auth/refresh`
também cai no IP: só tem `refresh_token` no corpo, e o limite global roda em
`onRequest`, antes do parsing.

### CORS

Origens permitidas: `http://localhost:3000`, `http://localhost:3001`, `https://mirsui.com`, `https://www.mirsui.com` e o valor de `FRONTEND_URL`.

---

## Referência da API

### Health

| Método | Rota | Descrição |
|---|---|---|
| GET | `/` | Health check com mensagem |
| GET | `/health` | Health check simples |

### Autenticação (`/auth`)

#### `POST /auth/signup`
Cria uma conta. O profile é criado automaticamente via trigger no Supabase, com display name aleatório e avatar padrão.

Body: `{ "email": string, "password": string, "username": string }`

Validações: senha ≥ 6 caracteres; username ≥ 3 caracteres, apenas `[a-zA-Z0-9_]`; username e email não podem já existir.

Respostas: `201 { message, user, session }` · `400` validação ou duplicado.

#### `POST /auth/login`
Body: `{ "email": string, "password": string }`

Respostas: `200 { message, user, session }` · `401` credenciais inválidas.

#### `POST /auth/logout`
Header `Authorization: Bearer <token>` (opcional). Sempre responde `200 { message }`.

#### `POST /auth/refresh`
Body: `{ "refresh_token": string }`

Respostas: `200 { message, session, user }` · `401` token inválido/expirado.

#### `GET /auth/verify`
Valida o access token (usado pelo middleware do frontend). Header `Authorization: Bearer <token>`.

Respostas: `200 { authenticated: true, userId, email }` · `401 { authenticated: false, error }`.

#### `GET /auth/me` 🔒
Retorna o usuário logado e seu profile: `200 { user, profile }` (`profile` pode ser `null`).

#### `POST /auth/reset-password`
Body: `{ "email": string, "redirectUrl"?: string }` (padrão: `FRONTEND_URL/reset-password`)

Sempre responde `200` com mensagem genérica, para não revelar se o email existe.

### Profiles (`/profiles`)

| Método | Rota | Auth | Descrição |
|---|---|---|---|
| GET | `/profiles` | — | Lista todos, ordenados por `rating` desc. `200 { profiles, count }` |
| GET | `/profiles/:id` | — | Por ID. `200 { profile }` · `404` |
| GET | `/profiles/username/:username` | — | Por username. `200 { profile }` · `404` |
| PATCH | `/profiles/:id` | 🔒 dono | Atualiza o próprio profile. `200 { profile }` · `403` se não for o dono |

No PATCH, apenas estes campos são aceitos (os demais são ignorados): `username`, `description`, `display_name`, `avatar_url`. Campos como `points` e `rating` **não** são editáveis pela API.

### Feed (`/feed`)

#### `GET /feed?limit=5&offset=0` (auth opcional)
Posts do feed (tracks salvas, mais recentes primeiro) com dados do autor e contadores.

`limit`: 1–50 (padrão 5) · `offset`: ≥ 0 (padrão 0)

Resposta: `200 { posts: [...], total }` — cada post inclui os dados da track, `username`, `display_name`, `avatar_url`, `savers_count`, `comments_count` e `saved_by_me`.

`savers_count` conta quantas pessoas salvaram **a música** (agrupando por `track_uri`), não quantas salvaram aquela linha: cada pessoa que salva a mesma faixa cria uma linha própria em `tracks`. É o mesmo universo de `position`, então "3ª a salvar · 12 já salvaram" fecha.

`saved_by_me` responde "o usuário do token já salvou esta música?". Com token ausente ou inválido vem `false` em todos os posts — então o cliente precisa mandar o header também nas páginas seguintes do `offset`, senão as faixas já salvas voltam a aparecer como não salvas.

Desde a migration 023 as duas perguntas casam por **gravação**, e não por string: `isrc` quando a linha tem, `track_uri` quando não. Sem isso, a mesma faixa salva por um caminho antigo (uri do Spotify) e por um novo (`isrc:<ISRC>`) viraria dois contadores paralelos e duas "primeiras pessoas a salvar".

#### `GET /feed/recent-claims?limit=4`
Achados recentes sem músicas duplicadas (únicos por `track_uri`). `limit`: 1–20 (padrão 4).

Resposta: `200 { claims: [...] }`

### Tracks — ficha e busca

| Método | Rota | Auth | Descrição |
|---|---|---|---|
| GET | `/tracks/search?q=&limit=` | — | Busca faixas no **Deezer**. `200 { tracks }` — cada item traz `id` (o ISRC, que é o endereço da página), `isrc`, `deezerTrackId`, `uri`, capa, `preview` de 30 s e `popularity` 0–100 |
| GET | `/tracks/isrc/:isrc` | opcional | Ficha completa da gravação numa chamada: faixa, gênero, fãs do artista, prévia, total de salvamentos, quem salvou e — com token — o claim do próprio usuário |
| GET | `/tracks/spotify/:id` | opcional | A rota antiga. Traduz o id do Spotify para ISRC **consultando o banco local** e devolve a mesma ficha. `404` se a ponte não conhecer o id |
| POST | `/tracks/resolve-spotify` | — | Body `{ "isrc": "..." }`. Descobre o id do Spotify daquela gravação e grava. `200 { spotifyTrackId }` — `null` significa "não sei agora", nunca um erro |

`/tracks/resolve-spotify` é a camada 2 do "ouvir no Spotify" (§5 do plano de
independência). É público porque a página de faixa é aberta, mas **nada vindo do
cliente é gravado**: o corpo traz só o ISRC e quem descobre o id é o servidor.
Se o navegador pudesse mandar o `spotify_track_id`, qualquer um apontaria o
botão de qualquer faixa para qualquer outra — a mesma lição da migration 017 com
o cache do YouTube.

O campo `spotify_url` da ficha vem sempre preenchido: com o id exato quando ele
existe, e com `open.spotify.com/search/<artista título>` quando não. `spotify_exact`
diz qual dos dois é.

### Tracks — comentários

| Método | Rota | Auth | Descrição |
|---|---|---|---|
| GET | `/tracks/:id/comments` | — | Lista comentários (mais recentes primeiro). `200 { comments }` |
| POST | `/tracks/:id/comments` | 🔒 | Cria comentário. Body: `{ "comment": string }`. `200 { comment }` |
| DELETE | `/comments/:commentId` | 🔒 autor | Deleta o próprio comentário. `200 { success: true }` · `403` se não for o autor · `404` |

IDs não numéricos respondem `400`.

### Claims

#### `POST /tracks/claim` 🔒
Reivindica uma música. Body:

```json
{
  "trackUri": "spotify:track:... | isrc:...",  // obrigatório (chave opaca)
  "isrc": "USUM72409273",             // recomendado: identifica a GRAVAÇÃO
  "trackName": "...",                 // obrigatório
  "artistName": "...",                // obrigatório
  "albumName": "...",
  "spotifyUrl": "...",
  "trackThumbnail": "...",
  "popularity": 42,
  "claimMessage": "opcional"
}
```

A `position` é a ordem de chegada do claim daquela música (1º, 2º, ...). O `discover_rating` é calculado como `100 - popularity + 100 / position`.

O `isrc` não substitui o `trackUri` — ele acompanha. `track_uri` continua sendo
a chave opaca do acervo (as linhas antigas guardam `spotify:track:<id>` e nada
foi migrado), e `isrc` é o que faz a contagem, a deduplicação e o "você já
salvou" enxergarem a mesma GRAVAÇÃO mesmo quando ela foi salva por caminhos
diferentes. Ver `migrations/023_isrc_canonico.sql`.

Respostas: `201 { success, message, position, youtubeUrl, data }` · `409` se o usuário já reivindicou essa música (inclui `position` e `youtubeUrl` do claim existente).

> ⚠️ A posição é calculada por contagem (count + 1) sem lock — dois claims simultâneos da mesma música podem receber a mesma posição. Para garantir unicidade, mover esse cálculo para uma function/trigger no Postgres.

#### `GET /tracks/claim/status?trackUri=...` 🔒
Verifica se o usuário logado já reivindicou a música: `200 { claimed, position, youtubeUrl }`.

### Usuário

#### `GET /user/points` 🔒
Pontos do usuário logado (via RPC `get_user_points` no Supabase): `200 { points, userId }`.

---

## Dependências do banco (Supabase)

A API espera as tabelas `profiles`, `tracks`, `track_comments`, `favorites`, além de:

- **Trigger de criação de profile** ao registrar usuário no Auth (usa `username`, `display_name` e `avatar_url` do `user_metadata`).
- **RPC `get_user_points(user_uuid uuid)`** para `GET /user/points`.
- **RPC `get_track_save_counts(p_track_ids integer[])`** para os contadores do feed e do perfil (ver `migrations/006_salvar_de_verdade.sql`).
- **RPC `get_trending_tracks(p_limit integer)`** para as faixas em alta da landing.
- A coluna `profiles.email` preenchida pelo trigger — usada na checagem de email duplicado no signup.

🔒 = exige header `Authorization: Bearer <access_token>` (access token da sessão Supabase). Sem token: `401 { "error": "Token não fornecido" }` · token inválido: `401 { "error": "Usuário não autenticado" }`.
