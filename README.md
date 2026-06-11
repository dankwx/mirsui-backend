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
| `FRONTEND_URL` | Não | Origem extra permitida no CORS e destino padrão do link de reset de senha |
| `PORT` | Não | Porta do servidor (padrão: `3000`) |

O servidor **não sobe** sem `SUPABASE_URL` e `SUPABASE_KEY` (validado em `src/lib/supabase.ts`).

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

Global: **100 requisições / 15 minutos** por IP. Limites mais restritos por rota:

| Rota | Limite |
|---|---|
| `POST /auth/signup` | 5 / hora |
| `POST /auth/login` | 5 / minuto |
| `POST /auth/reset-password` | 3 / hora |

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

#### `GET /feed?limit=5&offset=0`
Posts do feed (tracks reivindicadas, mais recentes primeiro) com dados do autor e contadores.

`limit`: 1–50 (padrão 5) · `offset`: ≥ 0 (padrão 0)

Resposta: `200 { posts: [...], total }` — cada post inclui os dados da track, `username`, `display_name`, `avatar_url`, `likes_count` e `comments_count`.

#### `GET /feed/recent-claims?limit=4`
Reivindicações recentes sem músicas duplicadas (únicas por `track_uri`). `limit`: 1–20 (padrão 4).

Resposta: `200 { claims: [...] }`

#### `POST /feed/user-likes` (auth opcional)
Body: `{ "track_ids": number[] }`

Retorna quais dessas tracks o usuário logado curtiu: `200 { liked_tracks: number[] }`. Sem token (ou token inválido), retorna lista vazia.

### Tracks — likes e comentários

| Método | Rota | Auth | Descrição |
|---|---|---|---|
| POST | `/tracks/:id/like` | 🔒 | Dá like. `200 { success: true }` |
| DELETE | `/tracks/:id/like` | 🔒 | Remove like. `200 { success: true, deleted }` · `404` se não havia like |
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

A API espera as tabelas `profiles`, `tracks`, `track_likes`, `track_comments`, além de:

- **Trigger de criação de profile** ao registrar usuário no Auth (usa `username`, `display_name` e `avatar_url` do `user_metadata`).
- **RPC `get_user_points(user_uuid uuid)`** para `GET /user/points`.
- A coluna `profiles.email` preenchida pelo trigger — usada na checagem de email duplicado no signup.

🔒 = exige header `Authorization: Bearer <access_token>` (access token da sessão Supabase). Sem token: `401 { "error": "Token não fornecido" }` · token inválido: `401 { "error": "Usuário não autenticado" }`.
