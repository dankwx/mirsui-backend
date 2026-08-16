# Plano — independência do Spotify

- **Data:** 15 de agosto de 2026
- **Status:** **aplicado em 15/08/2026.** As seis fases entraram; os números da
  execução estão em [«O que a execução encontrou»](#o-que-a-execução-encontrou),
  no fim do documento. O corpo do plano fica como estava escrito — é o
  raciocínio de antes, e vale mais intacto que corrigido depois do fato
- **Escopo:** página de faixa, página de artista, busca, prévia de áudio, job do
  Observatório (etapa 5), clientes Spotify e Deezer nos dois repositórios
- **Pergunta que originou:** "as páginas de música dependem do Spotify? dá pra
  tirar essa dependência de vez, deixando só o 'ouvir no Spotify'?"
- **Cobre:** o **item 9** da ordem de execução de
  [`analise-escala-apis-e-banco.md`](analise-escala-apis-e-banco.md) §9 — "ISRC
  como identificador canônico (em vez de spotify_id)", que lá está sem prazo e
  marcado como esforço alto. A partir daqui ele tem plano, fases e teste de
  aceitação. Aquele documento ficou **intacto no dia da execução**; em 16/08/2026
  recebeu só a marcação de status — itens 9 e 5 como feitos na tabela §9, e um
  ponteiro para cá em §7. O raciocínio dele continua como estava escrito

Este documento continua a seção 7 de
[`analise-escala-apis-e-banco.md`](analise-escala-apis-e-banco.md), que já tinha
identificado a dependência como risco estrutural e listado "ISRC como
identificador canônico" como item 9 (esforço alto, sem prazo). O que mudou é que
o risco deixou de ser futuro: **as páginas de faixa estão fora do ar agora**.

Todo número aqui vem de medição feita em 15/08/2026 contra o banco de produção
(`tqprioqqitimssshcrcr`), contra a API do Spotify com a credencial real do
projeto e contra a API pública do Deezer. Os comandos estão no anexo.

---

## Resumo executivo

A resposta curta é **sim, corta**. E não como plano de longo prazo: o Deezer
cobre hoje, com uma requisição sem chave, **todos** os campos que a página de
faixa lê do Spotify — e mais dois que o Spotify já não entrega.

O que a troca compra, em uma linha cada:

| | de | para |
|---|---|---|
| Faixas com página no site | 1.388 (21,4%) | **6.490 (100%)** |
| Requisições por página de faixa | 2 (Spotify) + 1–2 (Deezer) | **1 (Deezer)** |
| Credenciais no caminho de render | 1 (Spotify) | **0** |
| Prévia de áudio | YouTube (cota de 100 buscas/dia) | **Deezer, no mesmo objeto** |
| Página cai se a fonte limitar | sim, para branco | não (dado local + Deezer) |

E o "ouvir no Spotify" **continua funcionando sem API do Spotify**. Essa é a
parte que parece impossível e não é — está na seção 5.

---

## 1. O estado medido

### 1.1 A credencial está de castigo agora

```
GET /v1/tracks/2plbrEY59IikOBgBGLjaoe   ->  429 Too many requests
Retry-After: 12205                      ->  3 h 24 min
```

Não é a janela deslizante de 30 s que a documentação do Spotify descreve. É um
bloqueio de horas, e **já estava valendo antes da primeira requisição do teste** —
a sondagem começou levando 429.

### 1.2 A produção está renderizando página vazia

Quatro faixas que têm `spotify_track_id` gravado, buscadas na produção durante o
castigo:

```
mirsui.com/track/2plbrEY59IikOBgBGLjaoe  ->  <title>Faixa - Mirsui</title> + "Faixa Desconhecida"
mirsui.com/track/3oTuTpF1F3A7rEC6RKsMRz  ->  idem
mirsui.com/track/53iuhJlwXhSER5J2IYYv1W  ->  idem
mirsui.com/track/3qhlB30KknSejmIvZZLjOD  ->  idem
```

4 de 4. Sem capa, sem artista, sem ficha técnica, sem curva do Observatório, sem
prévia. Também sem `<title>` útil — o que significa que crawler e preview de
link recebem a página quebrada.

Na mesma hora, `mirsui.com/pilha` renderizou **504 capas** normalmente. A
diferença é a fonte: a Pilha lê `observed_tracks` (dado local, coletado do
Deezer); a página de faixa chama o Spotify em request-time.

A causa é uma linha só, em `app/(dashboard)/track/[id]/page.tsx:132`:

```ts
trackInfo = await fetchSpotifyTrackInfo(trackId)
```

Quando isso devolve `null`, não existe plano B. Todo o resto da página é
derivado de `trackInfo` — inclusive o ISRC, que é o que busca a curva. Um 429 do
Spotify apaga até o dado que é nosso.

### 1.3 Endpoints do Spotify, um a um

Sondagem com a credencial do projeto:

| Endpoint | Resposta | Usado hoje em |
|---|---|---|
| `/tracks/{id}` | `429` | página de faixa (crítico) |
| `/artists/{id}` | `429` | página de faixa e de artista |
| `/search` | `429` | busca do site, ponte de ISRC |
| `/artists/{id}/albums` | `429` | página de artista |
| `/artists/{id}/related-artists` | `429` | — (já abandonado no ADR 001) |
| `/artists/{id}/top-tracks` | **`403`** | `ArtistTopTracks` |
| `/audio-features/{id}` | **`403`** | — |
| `/tracks?ids=` (lote de 50) | **`403`** | — |
| `/recommendations` | **`404`** | — (removido pelo Spotify) |

Os `403` e o `404` atravessaram a janela de castigo — não são consequência do
429. Batem com o que o [ADR 001](decisions/001-descoberta-controlada-de-faixas.md)
registrou em abril e com a migration 009 (a saída do `popularity`).

> **Ressalva honesta:** o `403` em `/tracks?ids=` foi observado uma vez, durante
> o castigo, e é a única sondagem que eu não repetiria sem reconfirmar fora da
> janela. Se ele for real, a consequência é séria — significa que nem batelar 50
> faixas numa requisição é possível, e o custo do Spotify é irredutivelmente de
> 1 requisição por faixa. Reconfirmar antes de citar este número em qualquer
> outro lugar.

### 1.4 Cobertura do catálogo

| Métrica | Valor | % das ativas |
|---|---|---|
| Faixas ativas no Observatório | 6.490 | 100% |
| Com ISRC | 3.425 | 52,8% |
| ISRCs distintos | 3.416 | — |
| ISRCs duplicados (mesma gravação, 2 ids Deezer) | 9 | 0,26% |
| **Com `spotify_track_id` → têm página hoje** | **1.388** | **21,4%** |
| Na fila de ISRC (nunca consultadas) | 3.065 | 47,2% |
| Na fila do Spotify | 2.027 | 31,2% |
| **Consultadas e o Deezer não tinha ISRC** | **0** | **0%** |
| Consultadas e o Spotify não achou | 10 | — |

Duas linhas dessa tabela decidem o documento inteiro:

- **`0`** — o Deezer devolveu ISRC para **todas** as 3.425 faixas consultadas.
  Zero falhas.
- **`1.388`** — o Spotify resolveu 1.388.

O funil não é do catálogo nem do Deezer. É inteiramente do Spotify, e ele está
na frente de dado que já é nosso: **5.102 faixas que medimos todo dia não têm
página**, e a única razão é que uma API de terceiro não confirmou que elas
existem no mercado brasileiro dela.

---

## 2. Por que fallback não resolve

Foi a primeira coisa que sugeri e você reagiu certo: fallback conserta o sintoma
e mantém a doença. Com Deezer só como plano B:

- a página deixa de ir a branco no 429 — **bom**;
- mas as 5.102 continuam sem página, porque o endereço continua sendo o id do
  Spotify e elas não têm um — **o problema original intacto**;
- e o caminho feliz continua gastando 2 requisições Spotify por página, ou seja,
  continua alimentando o castigo que gerou o 429.

Fallback é um degrau da escada (fase 0 abaixo), não o destino.

---

## 3. A decisão: Deezer é a fonte, Spotify é uma saída

### 3.1 Uma requisição, sem chave, sem token

```
GET https://api.deezer.com/track/isrc:USUM72409273
```

Sem OAuth, sem client_credentials, sem renovação de token, sem `market=`.
Testado com 4 ISRCs reais do banco (Taylor Swift, Lola Young, Bruno Mars, Djo):
**4 de 4 completos**.

### 3.2 Campo a campo

| A página lê | Spotify hoje | Deezer | Onde |
|---|---|---|---|
| Título | ✅ | ✅ | `title` |
| Artista(s) | ✅ | ✅ | `artist`, `contributors[]` |
| Álbum | ✅ | ✅ | `album.title` |
| Capa | ✅ | ✅ | `album.cover_xl` — e o `md5` já está no nosso banco |
| Data de lançamento | ✅ | ✅ | `release_date` |
| Duração | ✅ | ✅ | `duration` (segundos) |
| Explícito | ✅ | ✅ | `explicit_lyrics` |
| ISRC | ✅ | ✅ | `isrc` |
| Gênero | ❌ vazio p/ BR/indie, **já cai no Deezer hoje** | ✅ | `/album/{id}` → `genres` |
| Seguidores do artista | +1 requisição | ✅ | `/artist/{id}` → `nb_fan` |
| Popularidade 0–100 | ✅ | ✅ | `rank` → `popScore()`, que já existe |
| **Prévia de 30 s** | ❌ **cortada pelo Spotify** | ✅ | `preview` |

Duas observações que valem o documento:

**O gênero já é do Deezer.** `utils/deezerService.ts` existe justamente porque o
`genres` do Spotify vem vazio para artista BR e indie. Ou seja: no campo que
mais importa para um produto brasileiro, o Spotify já perdeu e ninguém reparou.

**A prévia é um ganho, não um empate.** Medição:

```
preview -> https://cdnt-preview.dzcdn.net/api/1/1/4/5/9/0/...mp3?hdnea=exp=...
HEAD    -> 200  audio/mpeg  479.827 bytes
```

Hoje `TrackPreviewBar` usa YouTube, que custa cota da YouTube Data API (10.000
unidades/dia ÷ 100 por busca = **100 buscas por dia**) e exigiu uma tabela de
cache inteira (`youtube_cache`, migrations 002 e 017) só para não estourar. O
Deezer entrega o MP3 no mesmo objeto da faixa, de graça.

> A URL da prévia é assinada e tem `exp` curto (horas). Não pode ser gravada no
> banco como URL — resolve-se no request e pronto. Isso é compatível com o
> desenho proposto, onde a página já faz a chamada do Deezer de qualquer jeito.

### 3.3 O resto do site também está coberto

| Página | Spotify hoje | Deezer (testado) |
|---|---|---|
| Artista — dados | `/artists/{id}` | `/artist/{id}` → `nb_fan: 94.698`, `nb_album: 41`, foto |
| Artista — discografia | `/artists/{id}/albums` | `/artist/{id}/albums` → **n = 41** |
| Artista — top tracks | `/artists/{id}/top-tracks` **403** | `/artist/{id}/top?limit=99` → **n = 69, com rank** |
| Busca — faixas | `/search?type=track` | `/search?q=` → n = 5, com `rank` |
| Busca — artistas | `/search?type=artist` | `/search/artist?q=` → n = 3, com `nb_fan` |

A página de artista é o caso mais gritante: o endpoint de top tracks responde
**403** hoje. Aquela seção do site já está quebrada, e o Deezer devolve o
equivalente com rank incluso.

---

## 4. O identificador canônico passa a ser o ISRC

### 4.1 Por que ISRC e não `deezer_track_id`

Trocar id do Spotify por id do Deezer só mudaria de dono o mesmo problema. O
ISRC não é de plataforma nenhuma — é o código da **gravação**, emitido pela
indústria. Se um dia a fonte de medição mudar (o próprio
`analise-escala-apis-e-banco.md` §10 levanta MusicBrainz e Last.fm), as URLs do
site não mudam junto.

E o ISRC já é, de fato, a identidade interna: `get_track_curve` casa por ele,
`resolveTrack` dos Stakes tenta ele primeiro, `fetchDeezerGenresByISRC` usa ele.
Falta só promovê-lo a endereço.

### 4.2 A rota aceita três formatos, e eles não colidem

`/track/[id]` pode distinguir os três por regex, sem tabela de-para e sem
ambiguidade:

| Formato | Regex | Exemplo | O que fazer |
|---|---|---|---|
| ISRC (canônico) | `^[A-Z]{2}[A-Z0-9]{3}\d{7}$` | `USUM72409273` | resolver direto |
| Spotify (legado) | `^[A-Za-z0-9]{22}$` | `2plbrEY59IikOBgBGLjaoe` | achar ISRC no banco → `301` |
| Deezer (escape) | `^\d+$` | `2947516331` | resolver e `301` para o ISRC |

12 vs 22 caracteres vs só dígitos: nenhum id de um formato é válido em outro.

Testado contra os 3.425 ISRCs do banco, e não por dedução:

```
total_isrc                3425
casam_regex               3425   <- 100%
fora_do_padrao               0
tamanho_diferente_de_12      0
colide_com_spotify           0   <- nenhum ISRC tem 22 chars base62
colide_com_deezer            0   <- nenhum ISRC é só dígitos
```

**Isso significa que as URLs antigas nunca quebram.** As 1.388 que já têm
`spotify_track_id` gravado redirecionam por consulta local ao banco — sem chamar
o Spotify.

### 4.3 O ganho de cobertura, em duas etapas

| Momento | Faixas com página | % |
|---|---|---|
| Hoje | 1.388 | 21,4% |
| Assim que a rota aceitar ISRC | **3.425** | **52,8%** |
| Depois de drenar a fila de ISRC | **~6.490** | **~100%** |

A fila de ISRC são **3.065 requisições ao Deezer**. A 8 req/s
(`INTERVALO_MS = 125` em `deezerCatalog.ts`), isso é **6 minutos e 23 segundos**,
uma vez. Não é um projeto: é uma rodada do job.

A projeção de ~100% se apoia em 3.425 consultas com **zero** falhas de ISRC. Se
a taxa cair pela metade na cauda do catálogo — o que seria uma degradação
enorme — ainda são ~5.000 faixas com página, contra 1.388 hoje.

### 4.4 Os 9 ISRCs duplicados

O Deezer mantém mais de um id para a mesma gravação (single e faixa de álbum,
catálogos regionais). São 9 casos em 3.416 (0,26%).

**Isso já está resolvido.** `get_track_curve` (migration 011) desempata por
`last_rank desc`, e a razão está escrita lá: o id de maior rank é o que as
pessoas tocam. A rota por ISRC herda o critério — não é problema novo, é
problema conhecido com solução em produção.

---

## 5. O "ouvir no Spotify" sem API do Spotify

Esta é a parte que decide se dá para cortar de verdade. Três camadas, em ordem
de preferência, nenhuma delas no caminho de render:

**Camada 1 — os 1.388 ids que já temos.** Estão em `observed_tracks`, foram
pagos, não expiram. Consulta local, custo zero.

**Camada 2 — resolução preguiçosa.** Para quem não tem id, resolver
`isrc:` → Spotify **quando alguém abrir a página**, e gravar para sempre. A
diferença para hoje é de natureza, não de grau:

| | hoje (job) | proposto (preguiçoso) |
|---|---|---|
| Quando | 2.027 de uma vez, toda noite | 1 por página nunca visitada |
| Escala com | tamanho do catálogo | interesse real |
| Se der 429 | a etapa inteira falha | o botão não aparece; tenta na próxima visita |
| Bloqueia o render | — | **não** (roda depois, fora do caminho crítico) |

É o mesmo desenho que a seção 8 do `analise-escala-apis-e-banco.md` propõe para
o catálogo: custo proporcional a interesse, não a tamanho.

**Camada 3 — deep link de busca, zero API.** Quando não há id e a resolução não
rolou:

```
https://open.spotify.com/search/Lola%20Young%20Messy   ->  200
```

Testado. Abre o Spotify com a busca feita. Não é tão bom quanto cair na faixa
exata, mas é infinitamente melhor que botão ausente — e **nunca falha**.

Com as três camadas, o botão "ouvir no Spotify" existe em 100% das páginas, e o
Spotify some do caminho crítico por completo.

### 5.1 Alternativa testada e rejeitada: Odesli / song.link

A ideia era boa: uma API que recebe um link de uma plataforma e devolve o
equivalente em todas as outras — resolveria a camada 2 sem tocar no Spotify, e
de quebra daria Apple Music, Tidal e YouTube Music.

Testado com 4 faixas do catálogo, por `platform=deezer&type=song&id=`:

```
Taylor Swift - Fate of Ophelia  -> 200 | 6 plataformas | spotify: NAO
Lady Gaga - Die With A Smile    -> 200 | 9 plataformas | spotify: NAO
Djo - End of Beginning          -> 200 | 9 plataformas | spotify: NAO
Lola Young - Messy              -> 200 | 8 plataformas | spotify: NAO
```

**0 de 4.** A API responde, resolve a gravação, devolve Amazon, Tidal, Napster,
Pandora, Anghami, Yandex — e nunca o Spotify. Não serve para o que precisamos.

Fica registrado porque é o tipo de ideia que reaparece em seis meses, e o teste
já está feito. (Serve, isso sim, para *acrescentar* links de outras plataformas
depois, se um dia isso interessar.)

---

## 6. Plano de execução

Cinco fases. Cada uma entrega valor sozinha e nenhuma depende da seguinte ter
sido feita — se o plano parar na fase 2, o site já está melhor do que hoje.

### Fase 0 — parar o sangramento

**Objetivo:** a página nunca mais renderizar em branco por causa de terceiro.
**Esforço:** horas. **Risco:** baixo — só adiciona caminho, não remove.

Em `app/(dashboard)/track/[id]/page.tsx`, quando `fetchSpotifyTrackInfo`
devolver `null`, montar a página a partir do Deezer. Como o id na URL ainda é do
Spotify, a ponte de volta é o banco: `observed_tracks.spotify_track_id = id` →
pega `isrc` e `deezer_track_id` → resolve no Deezer.

**Verificação:** com a credencial em 429 (ou com `SPOTIFY_CLIENT_ID` apagado no
ambiente local), as 4 URLs da §1.2 renderizam título, capa, artista e curva.

### Fase 1 — a rota aceita ISRC

**Objetivo:** dar página às 5.102 órfãs. **Esforço:** médio. **Risco:** baixo —
URLs antigas continuam por `301`.

1. Detecção de formato na rota (§4.2), `301` de Spotify/Deezer para a forma ISRC
2. `getTrackCurve(isrc)` já funciona — não muda
3. Rodar a fila de ISRC até o fim (`OBS_LIMITE_ISRC` sem teto): 6 min
4. Trocar a geração de links para a forma ISRC em: `components/Pile/Pile.tsx`,
   `components/Landing/Acervo.tsx`, `landingHelpers.ts`,
   `components/Profile/trackHref.ts`, `FeedContent.tsx`, `RecentClaims.tsx`,
   `RecentActivity.tsx`
5. Migrations: `get_pile_tracks` (014) e `get_landing_observatory` (015) passam a
   devolver `isrc` em vez de `spotify_id`; `utils/pileTypes.ts`,
   `utils/pileService.ts`, `utils/homeService.ts` acompanham

O índice já existe (`observed_tracks_isrc_idx`, parcial em `isrc is not null`) —
nenhuma migration de índice é necessária.

**Verificação:** `select count(*) from observed_tracks where active and isrc is
not null` bate com o número de tiles linkáveis na `/pilha`. `/track/GBUM72401610`
("Messy", hoje sem página) abre.

### Fase 2 — Deezer vira a fonte primária

**Objetivo:** tirar o Spotify do caminho de render. **Esforço:** médio.
**Risco:** médio — é onde a aparência da página pode mudar.

O fallback da fase 0 vira o caminho principal: `/track/isrc:{isrc}` numa
requisição, `/album/{id}` para gênero, `/artist/{id}` para `nb_fan`. A
popularidade passa a ser `popScore(rank)` — número que já usamos nos Stakes e no
Observatório, o que tem um efeito colateral bom: **a "popularidade hoje" na
página passa a ser a mesma métrica da curva logo abaixo dela.** Hoje são duas
escalas diferentes de duas empresas diferentes no mesmo bloco visual.

Trocar `TrackPreviewBar` de YouTube para `preview` do Deezer, com YouTube como
fallback (o cache existente continua servindo o que já está lá).

**Verificação:** com `SPOTIFY_CLIENT_ID` vazio, a página renderiza completa,
incluindo prévia. Nenhuma requisição para `api.spotify.com` no caminho de render.

### Fase 3 — busca e página de artista

**Objetivo:** tirar os dois últimos consumidores grandes. **Esforço:** médio.
**Risco:** médio — a busca é fluxo de usuário, precisa de olho na qualidade dos
resultados.

- `app/api/search/route.ts` → `/search` e `/search/artist` do Deezer
- `app/(dashboard)/artist/[id]/page.tsx` e `components/Artist/*` → `/artist/{id}`,
  `/artist/{id}/albums`, `/artist/{id}/top` (que conserta o `403` de hoje)
- `/artist/[id]` passa a ser id do Deezer; ids do Spotify legados redirecionam
- `components/Library/AddMusicDialog.tsx` e o backend `GET /tracks/search`
  (`src/routes/tracks.ts`) acompanham

Ponto de atenção: os Stakes casam a faixa escolhida com o Deezer por ISRC
(`src/lib/deezer.ts:resolveTrack`). Com a busca já vindo do Deezer, esse
casamento deixa de existir — a faixa **nasce** com id do Deezer. Simplifica.

### Fase 4 — o job para de gastar Spotify

**Objetivo:** tirar a etapa 5 do caminho crítico da rodada. **Esforço:** baixo.

A etapa 5 de `catalogSnapshot.ts` (2.027 buscas no Spotify por noite) deixa de
existir como etapa do job. A resolução vira preguiçosa (§5, camada 2). O
`spotify_track_id` continua na tabela e continua sendo preenchido — só que por
visita, não por varredura.

Aproveitar para aplicar o **item 5** do `analise-escala-apis-e-banco.md`: ISRC
via `/album/{id}/tracks` em vez de `/track/{id}`, que é ~10x mais barato e agora
está no caminho crítico de verdade (é ele que dá página às faixas novas).

### Fase 5 — limpeza

`utils/spotifyService.ts` e `src/lib/spotify.ts` encolhem para uma função só
(`findSpotifyIdByIsrc`, usada pela camada 2). `app/api/spotify/track/[id]/route.ts`
e `GET /tracks/spotify/:id` saem ou viram redirect. As envs
`SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` passam a ser **opcionais** — o site
sobe e funciona inteiro sem elas, e isso vira o teste de aceitação do plano.

---

## 7. O que este plano NÃO muda

**`tracks.track_uri` continua sendo `spotify:track:<id>`.** É a chave de todo o
sistema de salvar/reivindicar: `position`, contadores do feed, `savers_count`,
`get_track_save_counts`, `unique_user_track_url`. Migrar isso é risco alto com
retorno zero — o valor é uma **chave opaca**, e chave opaca não precisa
significar nada. O que resolve o casamento com o Observatório é acrescentar uma
coluna `isrc` em `tracks`, preenchida no momento do save (a faixa vem do Deezer
a partir da fase 3, então o ISRC está em mãos).

Isso também mantém intacto o acervo real de usuários (46 linhas, 35 faixas) —
nenhum salvamento existente é tocado.

**As URLs antigas continuam.** `301`, não `404`. Link mandado no WhatsApp há três
meses continua abrindo, que é a razão de o middleware ter aberto `/track` ao
público.

**A curva do Observatório não muda em nada.** Ela sempre foi do Deezer, sempre
foi casada por ISRC. Este plano só remove o intermediário que estava na frente
dela.

---

## 8. Alternativas rejeitadas

| Alternativa | Por que não |
|---|---|
| **Só fallback** (Deezer como plano B) | Conserta o branco, mantém as 5.102 sem página. É a fase 0, não o plano |
| **Odesli / song.link** para os links | Testado: 0 de 4 faixas devolveram link do Spotify (§5.1) |
| **Migrar `track_uri` para ISRC** | Risco alto no único dado insubstituível (o acervo) para trocar uma chave opaca por outra |
| **Endereçar por `deezer_track_id`** | Troca o dono do problema. Se a fonte mudar, as URLs mudam junto |
| **Esperar a credencial de produção** | Não resolve `market=BR`, não resolve endpoint descontinuado, e as páginas continuam caindo enquanto isso |
| **Rotação de IP contra o Spotify** | Viola os termos, é frágil e resolve o problema errado — mesma conclusão da §6 do doc de escala |

---

## 9. Quando você conseguir a credencial de produção

Nada aqui é desperdiçado, e nada precisa ser desfeito.

Extended Quota Mode levanta o teto de requisições. Ele **não** devolve os
endpoints descontinuados (`recommendations` está em `404` para todo mundo,
`audio-features` foi restringido em toda a plataforma), **não** faz aparecer
gravação fora do `market=BR`, e **não** devolve `preview_url`.

Ou seja: dos três problemas da §1, a credencial melhor resolve um. Com o plano
aplicado, ela vira exatamente o que deveria ter sido desde o começo —
**enriquecimento opcional**: a camada 2 resolve mais links, mais rápido, e o
botão "ouvir no Spotify" cai na faixa exata com mais frequência. A página não
depende disso para existir.

---

## 10. Riscos

**Fonte única.** Depois disto, Deezer é a única fonte de metadado *e* de métrica.
Se a Deezer mudar o cálculo do `rank`, a série histórica inteira perde
comparabilidade — e não há segundo sinal para perceber. Este risco **já existe
hoje** para o Observatório e os Stakes (é a última seção do
`analise-escala-apis-e-banco.md`); o plano o estende para o metadado da página.

A mitigação não é manter o Spotify — ele não serve de segunda métrica, já que o
`popularity` saiu do ar. É o que aquele documento já aponta: Last.fm
(`listeners`, 5 req/s, chave gratuita) como segunda métrica, e MusicBrainz
(dumps completos, offline, sem cota) como identidade neutra. Nenhum dos dois é
urgente. Os dois ficam mais fáceis com ISRC como canônico, porque é a chave que
os dois falam.

**Rate limit do Deezer.** ~50 requisições a cada 5 s, sem `Retry-After` e sem
headers de cota — só o erro `code: 4`. `deezerCatalog.ts` já trata isso com fila,
`INTERVALO_MS` e `EM_VOO_MAX`. Mas as chamadas de página (`src/lib/deezer.ts`)
ficam **fora** dessa fila de propósito, porque nascem de ação do usuário. Com a
página passando a bater no Deezer em todo request-time, vale reavaliar: o
`revalidate` do Next continua sendo a principal proteção, e o dado local
(`observed_tracks`) cobre título, artista, capa e rank sem chamada nenhuma para
as 6.490 faixas do catálogo.

**Qualidade da busca.** A busca do Deezer não é a do Spotify. É o único ponto do
plano onde a experiência pode piorar, e o único que merece um A/B informal antes
de trocar de vez (fase 3).

**Capas.** O CDN do Deezer serve qualquer tamanho a partir do `md5` que já está
gravado — a Pilha faz isso hoje com 504 imagens numa página. Sem surpresa
esperada, mas é mudança visível se algum `md5` estiver vazio.

---

## 11. Ordem recomendada

| # | Fase | Esforço | O que compra |
|---|---|---|---|
| 1 | **Fase 0** — fallback | horas | a página para de cair. **Fazer hoje** |
| 2 | **Fase 1** — rota por ISRC | médio | 1.388 → ~6.490 páginas (4,7x) |
| 3 | **Fase 2** — Deezer primário | médio | Spotify sai do render; prévia de graça |
| 4 | **Fase 4** — job preguiçoso | baixo | −2.027 req/noite; a rodada para de depender do Spotify |
| 5 | **Fase 3** — busca e artista | médio | conserta o `403` do top-tracks; último consumidor |
| 6 | **Fase 5** — limpeza | baixo | envs do Spotify viram opcionais |

A fase 4 vem antes da 3 de propósito: é barata, e enquanto a etapa 5 do job
existir a rodada noturna continua podendo falhar por causa de uma API que já não
usamos para nada crítico.

**O teste de aceitação do plano inteiro:** subir o site com `SPOTIFY_CLIENT_ID`
e `SPOTIFY_CLIENT_SECRET` vazios e não notar diferença nenhuma, exceto que o
botão "ouvir no Spotify" às vezes cai na busca em vez da faixa exata.

---

## Anexo A — verificação (banco)

```sql
-- Cobertura do catálogo
select
  (select count(*) from public.observed_tracks where active) as ativas,
  (select count(*) from public.observed_tracks where active and isrc is not null) as com_isrc,
  (select count(*) from public.observed_tracks where active and spotify_track_id is not null) as com_spotify,
  (select count(*) from public.observed_tracks
     where active and isrc is null and isrc_checked_at is null) as fila_isrc,
  (select count(*) from public.observed_tracks
     where active and isrc is null and isrc_checked_at is not null) as deezer_sem_isrc,
  (select count(*) from public.observed_tracks
     where active and spotify_track_id is null and spotify_checked_at is not null) as spotify_nao_achou;
-- 15/08/2026: 6490, 3425, 1388, 3065, 0, 10

-- ISRCs duplicados (o desempate da migration 011)
with d as (
  select isrc, count(*) as n from public.observed_tracks
  where active and isrc is not null group by isrc
)
select count(*) as distintos, count(*) filter (where n > 1) as duplicados from d;
-- 15/08/2026: 3416, 9

-- A regex de roteamento (§4.2) contra os ISRCs reais
select
  count(*) as total,
  count(*) filter (where isrc ~ '^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$') as casam,
  count(*) filter (where isrc ~ '^[A-Za-z0-9]{22}$') as colide_spotify,
  count(*) filter (where isrc ~ '^[0-9]+$') as colide_deezer
from public.observed_tracks where active and isrc is not null;
-- 15/08/2026: 3425, 3425, 0, 0
```

## Anexo B — verificação (APIs)

```js
const dz = async (p) => (await fetch('https://api.deezer.com' + p)).json()

// A chamada que substitui a página inteira — sem chave, sem token
await dz('/track/isrc:USUM72409273')   // title, artist, album, cover, rank, isrc, preview
await dz('/album/591239352')           // genres
await dz('/artist/9266850')            // nb_fan: 94698, nb_album: 41

// Página de artista
await dz('/artist/9266850/top?limit=99')   // n=69, com rank (Spotify: 403)
await dz('/artist/9266850/albums?limit=100') // n=41

// Busca
await dz('/search?q=lola+young+messy&limit=5')  // n=5, com rank
await dz('/search/artist?q=lola+young&limit=3') // n=3, com nb_fan

// Prévia de 30s: 200 audio/mpeg, 479.827 bytes (URL assinada, exp curto)

// Deep link de busca do Spotify, sem API: 200
// https://open.spotify.com/search/Lola%20Young%20Messy

// Odesli: 0 de 4 devolveram spotify
// https://api.song.link/v1-alpha.1/links?platform=deezer&type=song&id=2815968782
```

Sondagem da credencial do Spotify: `429` com `Retry-After: 12205` em
`/tracks/{id}`, `/artists/{id}`, `/search`, `/artists/{id}/albums`; `403` em
`/artists/{id}/top-tracks`, `/audio-features/{id}` e `/tracks?ids=`; `404` em
`/recommendations`.

---

## O que a execução encontrou

Aplicado em 15/08/2026, nas seis fases e na ordem da §11. O que segue é medição,
não projeção.

### A cobertura bateu no teto

```
                         antes    depois
faixas ativas             6.490     6.490
com ISRC                  3.425     6.490   <- 100%
ISRCs distintos           3.416     6.475
fila de ISRC              3.065         0
consultadas sem ISRC          0         0   <- o Deezer nunca falhou
com spotify_track_id      1.388     1.388
```

**1.388 → 6.490 páginas: 4,67x.** A projeção da §4.3 era "~6.490 (~100%)" e a
ressalva era que uma queda pela metade na cauda ainda daria ~5.000. Não houve
queda: a taxa de ISRC do Deezer se manteve em **3.065 de 3.065**, zero falhas,
exatamente como nas 3.425 da primeira medição.

A drenagem levou **398 segundos** (previsto: 6 min 23 s = 383 s).

### A regex de roteamento, agora sobre o catálogo inteiro

A §4.2 verificou os 3.425 ISRCs que existiam. Refeito sobre os 6.490:

```
casam ^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$   6.490   (100%)
colidem com o formato do Spotify          0
colidem com o formato do Deezer           0
```

O invariante que a rota inteira depende continua valendo com o dobro da amostra.

### O teste de aceitação

Site buildado e servido com `SPOTIFY_CLIENT_ID` e `SPOTIFY_CLIENT_SECRET`
**vazios**. As quatro URLs da §1.2 — as que renderizavam "Faixa Desconhecida" —
foram pedidas pelo id do Spotify:

```
/track/2plbrEY59IikOBgBGLjaoe -> 308 -> /track/USUM72409273  Die With A Smile — Lady Gaga, Bruno Mars
/track/3oTuTpF1F3A7rEC6RKsMRz -> 308 -> /track/GBUM72506029  Raindance — Dave, Tems
/track/53iuhJlwXhSER5J2IYYv1W -> 308 -> /track/USUG12506436  The Fate of Ophelia — Taylor Swift
/track/3qhlB30KknSejmIvZZLjOD -> 308 -> /track/GBKPL2205058  End of Beginning — Djo
```

4 de 4 com `<title>` correto, capa do CDN do Deezer, participações (`contributors`)
e **prévia de 30 s**. Nenhuma credencial no caminho.

O redirecionamento é `308`, e não o `301` que a §4.2 escreveu: é o que
`permanentRedirect` do Next emite, e o equivalente moderno — permanente, mas sem
permitir que o método mude no caminho.

Outros casos, todos verificados no mesmo servidor sem credencial:

| Pedido | Resposta |
|---|---|
| `/track/2815968782` (id do Deezer) | `308` → `/track/GBUM72401610` |
| `/track/gbum72401610` (caixa baixa) | `308` → `/track/GBUM72401610` |
| `/track/ZZZZ99999999` (inexistente) | `404` — e não mais um 200 com página vazia |
| `/track/GBUM72401610` ("Messy", órfã até hoje) | `200`, completa |
| `/pilha` | 168 peças, **168 com link** (antes ~1 em 5) |
| home | 70 faixas, 70 linkadas por ISRC |

### Três coisas que o plano não tinha previsto

**1. `Retry-After` de 3h24 dentro de uma requisição HTTP.** A fase 4 move
`findSpotifyIdByIsrc` do job noturno para um endpoint. A função respeitava o
`Retry-After` do Spotify dormindo — o que num job é uma noite perdida e num
handler seria um pedido do navegador pendurado por 3 horas e 24 minutos. Entrou
um teto de 5 s (`ESPERA_MAXIMA_S`): acima disso a resposta é "não sei", que é
exatamente o que o botão já sabe tratar.

**2. `extractSpotifyIdFromUri` lança.** Dois componentes da página de artista
montavam o link com ela, e ela faz `throw` para qualquer uri fora do formato
`spotify:track:<id>`. Com a fase 3, a primeira faixa vinda do Deezer derrubaria a
página inteira. As rotas passaram a vir prontas de `artistPageService`.

**3. `/artist/{id}/top` não traz ISRC.** É o único endpoint do Deezer usado aqui
que não traz (o `/search` traz, o `/album/{id}/tracks` traz). Sem conserto, cada
link da lista de "mais tocadas" pagaria um redirecionamento extra. O conserto não
custou requisição: o Observatório mede essas faixas por id do Deezer todo dia e
guarda o ISRC ao lado, então é uma consulta local para a lista inteira.

### O item 5 da análise de escala entrou, mas ainda não rendeu

`/album/{id}/tracks` está implementado (`faixasDoAlbum`, migration 024), e a
drenagem rodou **3.065 de 3.065 pelo caminho antigo**, um a um. O motivo é
simples e temporário: `deezer_album_id` acabava de ser criada e estava vazia — o
id do álbum sempre veio nas respostas do Deezer e era descartado.

Essa mesma rodada preencheu a coluna em **3.075 faixas**, e cada varredura de
chart preenche mais. O ganho de ~10x aparece na próxima fila de ISRC, não nesta.

### O que NÃO mudou, como prometido

- `tracks.track_uri` intacto. As 46 linhas do acervo real não foram tocadas; o
  que entrou foi a coluna `tracks.isrc` ao lado, com **28 das 46** preenchidas
  pela ponte que o job já tinha pago. As outras 18 continuam sendo identificadas
  por `track_uri`, como sempre foram.
- A curva do Observatório: mesma RPC, mesma chave, mesmo desempate.
- URLs antigas: `308`, nunca `404`.

### O que ficou de fora

- **A busca do Deezer não foi comparada com a do Spotify.** A §10 pedia um A/B
  informal e ele não aconteceu; o Spotify ficou como reserva (cai nele quando o
  Deezer não devolve nada), que era a segunda opção da decisão. É o único ponto
  do plano onde a experiência ainda pode ter piorado sem ninguém ter medido.
- **`/tracks?ids=` continua sem reconfirmação.** A ressalva da §1.3 segue de pé:
  aquele `403` foi observado uma vez, durante a janela de castigo. Não foi
  reconfirmado, e não é citado como fato em lugar nenhum.
- **A página de artista por id do Spotify** depende da credencial para
  redirecionar (é preciso o nome do artista para achá-lo no Deezer). Sem
  credencial, URL antiga de artista dá `404`. Faixa não tem esse problema: a
  ponte é local.

---

## Referências no código

- `app/(dashboard)/track/[id]/page.tsx:132` — a linha sem plano B
- `app/(dashboard)/artist/[id]/page.tsx` — página de artista, 100% Spotify
- `utils/spotifyService.ts` / `src/lib/spotify.ts` — os dois clientes
- `utils/deezerService.ts` / `src/lib/deezer.ts` — o padrão a generalizar
  (`resolveTrack` já faz ISRC primeiro, busca textual depois)
- `src/jobs/catalogSnapshot.ts` — etapas 4 (ISRC) e 5 (Spotify)
- `src/lib/deezerCatalog.ts` — fila, `INTERVALO_MS`, tratamento de `code: 4`
- `migrations/010_observatorio_isrc.sql` — a marca de "já tentei"
- `migrations/011_curva_da_faixa.sql` — o desempate dos ISRCs duplicados
- `migrations/014_ponte_spotify.sql` — a ponte que este plano aposenta
- `docs/analise-escala-apis-e-banco.md` §7, §8, §10 — a análise que originou isto

### O que a execução acrescentou

- `migrations/023_isrc_canonico.sql` — `tracks.isrc`, a Pilha e a landing por
  ISRC, a landing sem a exigência de `spotify_track_id`
- `migrations/024_isrc_por_album.sql` — `observed_tracks.deezer_album_id` e o
  item 5 da análise de escala
- `utils/trackIdentity.ts` — os três formatos de id e a resolução em degraus
- `utils/trackPageService.ts` — Deezer e Observatório se completando
- `utils/deezerService.ts` / `src/lib/deezer.ts` — o cliente que substituiu o do
  Spotify
- `utils/trackHref.ts` — as quatro cópias divergentes da regra de link, agora uma
- `components/SpotifyListenButton` — as três camadas da §5
- `src/routes/tracks.ts` — `POST /tracks/resolve-spotify` (a camada 2) e
  `GET /tracks/isrc/:isrc`
