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
| `SUPABASE_KEY` | Sim | Chave do Supabase. **Obs:** `POST /auth/logout` usa `auth.admin.signOut()`, que exige a service role key — com a anon key o logout no servidor falha silenciosamente (o cliente ainda recebe sucesso) |
| `SUPABASE_SERVICE_ROLE_KEY` | Sim em produção | Chave privada usada exclusivamente pelos jobs do Observatório e dos Stakes; nunca vai para o frontend |
| `FRONTEND_URL` | Não | Origem extra permitida no CORS e destino padrão do link de reset de senha |
| `PORT` | Não | Porta do servidor (padrão: `3000`) |
| `OBS_DESCOBERTA_ATIVA` | Não | Liga a descoberta diária por rádio do Deezer (padrão: `true`) |
| `OBS_DESCOBERTA_META_INICIAL` | Não | Meta da expansão inicial do catálogo (padrão: `6604`) |
| `OBS_LIMITE_DESCOBERTA` | Não | Novas faixas por dia depois da meta inicial (padrão: `250`) |
| `OBS_MAX_CATALOGO` | Não | Teto rígido de faixas ativas no Observatório (padrão: `10000`) |

O servidor **não sobe** sem `SUPABASE_URL` e `SUPABASE_KEY` (validado em `src/lib/supabase.ts`).

### Jobs diários

- **05:00 — Observatório:** atualiza charts, mede o catálogo, completa ISRC e
  Spotify e, por último, descobre faixas semelhantes pelo rádio de artista do
  Deezer. A primeira expansão tenta chegar a 6.604 faixas; depois cresce no
  máximo 250 por dia, até 10 mil.
- **09:00 — Stakes:** mede os stakes ativos e credita a evolução diária.

A descoberta é idempotente por semente, não marca falhas transitórias como
concluídas e grava faixa, histórico e linhagem na mesma transação. A decisão,
os motivos e o procedimento de desligamento estão em
[`docs/decisions/001-descoberta-controlada-de-faixas.md`](docs/decisions/001-descoberta-controlada-de-faixas.md).

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

`saved_by_me` responde "o usuário do token já salvou esta música?", também por `track_uri`. Com token ausente ou inválido vem `false` em todos os posts — então o cliente precisa mandar o header também nas páginas seguintes do `offset`, senão as faixas já salvas voltam a aparecer como não salvas.

#### `GET /feed/recent-claims?limit=4`
Achados recentes sem músicas duplicadas (únicos por `track_uri`). `limit`: 1–20 (padrão 4).

Resposta: `200 { claims: [...] }`

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
  "trackUri": "spotify:track:...",   // obrigatório
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
