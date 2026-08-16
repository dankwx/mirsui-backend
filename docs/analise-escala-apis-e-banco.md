# Análise de escala — limites de API e crescimento do banco

- **Data:** 15 de agosto de 2026
- **Status** (marcação revista em 16/08/2026): **itens 2, 3, 4, 5 e 9 aplicados
  em produção**; item 1 aplicado no código e freado no ambiente (ver 4.1 e 9);
  **pendentes 6, 7 e 8**. O item 4 entrou pela migration 025 e é o que troca
  O(N) por orçamento fixo — mas ele **não economiza nada ainda**, porque o
  catálogo inteiro tem menos de 30 dias e é 100% quente (ver 5.1). A
  `track_popularity_history` saiu de 5.632 kB /
  21.027 linhas para **1.528 kB / 7.707 linhas (−72,9%)** (migrations 020, 021 e
  022), com a saída das funções de leitura inalterada byte a byte. Os itens 5 e 9
  entraram junto, pelo
  [plano de independência do Spotify](plano-independencia-do-spotify.md)
  (migrations 023 e 024): o Observatório inteiro passou a ter página, de 1.388
  para 6.490 faixas
- **Escopo:** job do Observatório (`src/jobs/catalogSnapshot.ts`), descoberta
  (`src/jobs/catalogDiscovery.ts`), clientes Deezer/Spotify e a tabela
  `track_popularity_history`
- **Pergunta que originou:** "atualizar todas as tracks salvas por dia vai ficar
  inviável conforme o projeto cresce? dá pra burlar o limite das APIs?"

Todos os números vieram de medição no banco de produção
(`tqprioqqitimssshcrcr`) e de requisições reais à API pública do Deezer, não de
estimativa. As queries e os testes estão reproduzidos no anexo.

---

## Resumo executivo

O rate limit do Deezer **não é o gargalo**, e não chega perto de ser. O que vai
travar o projeto é o volume do Postgres, que estoura cerca de **25x antes** da
API — e a causa raiz dos dois problemas é a mesma:

> **91,9% das medições registram um rank idêntico ao do dia anterior.**

Nove em cada dez requisições ao Deezer e nove em cada dez linhas gravadas no
banco existem para dizer que nada mudou. Rate limit é sintoma; o modelo de
"medir tudo, todo dia" é a doença.

Existem duas ordens de grandeza de ganho disponíveis por caminhos legítimos
antes de sequer fazer sentido pensar em contornar limite de API.

---

## 1. Estado atual (medido em 15/08/2026)

| Métrica | Valor |
|---|---|
| Faixas ativas no Observatório | 6.490 |
| Artistas distintos | 2.353 (2,76 faixas/artista) |
| Pontos no histórico | 21.027 |
| Fila de ISRC pendente | 3.065 |
| Fila de Spotify pendente | 2.027 |
| Fila de descoberta (sementes) | 3.407 |
| Acervo real de usuários | 46 linhas / 35 faixas únicas |
| Faixas com `spotify_track_id` | 1.388 (21,4%) |

### Pontos gravados por dia

| Dia | Pontos |
|---|---|
| 2026-08-15 | 6.490 |
| 2026-08-14 | 2.964 |
| 2026-08-13 | 2.971 |
| 2026-08-12 | 2.969 |
| 2026-08-11 | 2.994 |
| 2026-08-10 | 2.602 |

O salto de 15/08 é a primeira rodada da descoberta controlada (ADR 001), que
praticamente dobrou o catálogo de uma vez.

### Custo estimado de uma rodada hoje

| Etapa | Requisições ao Deezer |
|---|---|
| 1. `/genre` + charts (28 gêneros) | ~28 |
| 2. Acervo → Observatório | ~1 |
| 3. Medição individual (`N − vistasHoje`) | ~3.500 |
| 4. ISRC pendente | até ~3.065 |
| 5. Spotify (ISRC → id) | ~2.027 (API do Spotify, não Deezer) |
| 6. Descoberta (1 req por artista) | ~1.500–2.300 |
| **Total Deezer** | **~8.000–8.500** |

A `INTERVALO_MS = 125` em `src/lib/deezerCatalog.ts`, isso é **~8 req/s** →
**rodada de ~18 minutos**.

**Você usa 18 minutos de uma janela de 1.440.** 1,2% do dia. Espalhar o job
pelas 24h já daria ~80x de folga sem tocar em mais nada.

---

## 2. Onde quebra de verdade

### 2.1 Deezer — folga de 26x

A 8 req/s sustentados, com o modelo atual de 1 requisição por faixa medida:

| Janela | Faixas suportadas |
|---|---|
| 6 horas | ~173.000 |
| 12 horas | ~346.000 |
| 24 horas | ~691.000 |

O catálogo está em 6.490. A folga é de aproximadamente **26x** só na janela de
6 horas — e o teto configurado hoje (`OBS_MAX_CATALOGO = 10.000`) está de 15 a
20x **abaixo** do que o Deezer aguentaria.

### 2.2 Postgres — estoura em ~6 meses

Medição real da `track_popularity_history`:

```
total    5.632 kB
dados    1.744 kB
índices  3.848 kB
linhas   21.027
```

**274 bytes por linha**, com índices. Projetando:

| Catálogo | Linhas/ano | Armazenamento/ano |
|---|---|---|
| 10.000 (teto atual) | 3,65M | **~1,0 GB** |
| 100.000 | 36,5M | ~10 GB |
| 1.000.000 | 365M | ~100 GB |

Free tier do Supabase são 500 MB. **Com o teto de 10k que já está configurado,
o banco estoura em cerca de 6 meses** — enquanto o Deezer nem percebe (rodada
de 15 min). O plano Pro inclui 8 GB, o que a 100k faixas dura menos de um ano.

**Conclusão: o gargalo real é o banco, não a API.** A preocupação inicial estava
apontada para o lugar errado.

#### Onde isso ficou depois dos itens 2 e 3 (15/08/2026)

Custo por linha medido de novo: **203 bytes** (era 274). Com a gravação por delta,
o número de linhas por ano deixa de ser `catálogo × 365`:

| Catálogo | Linhas/ano | Armazenamento/ano |
|---|---|---|
| 10.000, denso (como era) | 3,65M | ~740 MB |
| 10.000, delta a −63% (medido hoje) | 1,34M | ~272 MB |
| 10.000, delta a −92% (regime maduro) | 292k | **~59 MB** |

O "estoura em 6 meses" vira **anos** dentro dos mesmos 500 MB do free tier. Vale
o cuidado de sempre: os −92% são o comportamento de uma série longa, e o
histórico tem 6 dias. O número honesto hoje é −63%, subindo.

Isso não revoga o item 4 — ele continua sendo o único que troca O(N) por
orçamento fixo, e é o que resolve o lado da API. Mas tira a urgência de prazo:
o banco deixou de ser a coisa que quebra primeiro.

### 2.3 Parte do custo do banco é autoinfligida

> **Aplicado em 15/08/2026** — migration `020_indices_do_historico.sql`. Mas
> **os dois índices que saíram não são os que esta seção indicava**; a correção
> está no fim dela.

A tabela tem **5 índices**, e há redundância clara:

```
track_popularity_history_pkey            (id)
idx_track_popularity_track_uri           (track_uri)                    ← prefixo redundante
idx_track_popularity_recorded_at         (recorded_at)
idx_track_popularity_track_uri_date      (track_uri, recorded_at)       ← cobre o de cima
track_popularity_history_dia_idx  UNIQUE (track_uri, recorded_at::date) ← cobre quase tudo
```

Resultado: **índices ocupam 3.848 kB contra 1.744 kB de dados — 2,2x maiores que
a tabela**.

Somado a isso, `track_uri` é `text` guardando strings como
`'deezer:track:3135556'` (~20 bytes), repetidas em quatro índices.

#### Correção — quem sai é o maior, não o prefixo

Faltava o dado de uso. Com ele:

| índice | tamanho | scans |
|---|---|---|
| `track_popularity_history_dia_idx` (track_uri, dia) UNIQUE | 1.344 kB | 31.027 |
| `idx_track_popularity_track_uri_date` (track_uri, recorded_at) | 1.336 kB | 4.194 |
| `idx_track_popularity_track_uri` (track_uri) | 512 kB | **902.322** |
| `track_popularity_history_pkey` (id) | 480 kB | 30.986 |
| `idx_track_popularity_recorded_at` (recorded_at) | 176 kB | 94 |

O `(track_uri)` que esta seção mandava dropar por "prefixo redundante" é o
**índice mais quente da tabela** — e é o menor. Entre dois índices onde um é
prefixo do outro, quem sai é o **maior**, se o menor der conta. E dá: quem lê
esta tabela pergunta sempre `where track_uri = $1 and rank is not null`
(`get_track_curve` na 011, o lateral da landing na 015), e o `EXPLAIN ANALYZE`
confirma que o planner já escolhe o de 512 kB.

Dropar os dois que a seção indicava liberaria 688 kB (18%) e empurraria o
caminho quente para um índice 2,6x maior. Saíram, em vez disso,
`idx_track_popularity_track_uri_date` (1.336 kB para 0,5% dos scans) e
`idx_track_popularity_recorded_at` (94 scans de vida inteira).

**Resultado medido:** índices 3.848 → 2.336 kB (−39,3%), total 5.632 → 4.120 kB,
274 → 201 bytes por linha. Que é o ~40% que esta seção prometia — pelos índices
certos.

---

## 3. O número que muda tudo

```sql
medicoes_com_anterior     14.500
rank_identico             13.320
pct_sem_mudanca            91,9%
pct_variacao_menor_2pct    93,1%
```

**91,9% das medições consecutivas têm rank exatamente igual ao do dia anterior.**
93,1% variam menos de 2%.

Isso invalida o modelo de "medir tudo todo dia" por dois lados ao mesmo tempo:

- **API:** 92% das requisições são desperdício puro.
- **Banco:** 92% das linhas gravadas não carregam informação nenhuma.

E é a justificativa quantitativa para as duas mudanças estruturais propostas
adiante (cadência adaptativa e gravação por delta).

---

## 4. Alavancas de API (todas verificadas contra a API ao vivo)

### 4.1 O chart tem 300 faixas, não 100 — melhor retorno por esforço

`src/jobs/catalogSnapshot.ts` passa `OBS_LIMITE_CHART = 100`, com o comentário
de que 100 é "o máximo que `/chart/{id}/tracks` devolve numa resposta". **Isso
está errado.** Teste em quatro gêneros:

```
chart/132 (Pop)              limit=500 -> n=300
chart/116 (Rap/Hip Hop)      limit=500 -> n=300
chart/12  (Música Brasileira) limit=500 -> n=300
chart/152 (Rock)             limit=500 -> n=300
chart/0   (Todos)            limit=500 -> n=299
```

A paginação por `index` confirma o teto real:

```
chart/0 index=0    -> n=100
chart/0 index=200  -> n=99
chart/0 index=500  -> n=0     ← acaba em ~300
```

Impacto medido nos 28 gêneros reais (15/08/2026): as mesmas 28 requisições
rendem **7.687 faixas únicas em vez de 2.561 — exatamente 3,00x**.

#### Correção (medido em 15/08/2026, contra o catálogo de produção)

A primeira versão desta seção afirmava que a mudança "corta cerca de 40% da
rodada". **Isso está errado**, e o erro é de premissa: a conta assumia que toda
faixa vinda do chart apenas sai da etapa 3. Isso só vale para faixa que **já
está no catálogo**, e das 7.687 só 3.382 estão.

```
etapa 3 (1 req/faixa)   hoje 3.929  →  com 300: 3.108   = corta 20,9%
faixas NOVAS entrando      0        →           4.305
catálogo ativo          6.490       →          10.795
```

As 4.305 novas entram por `record_observations`, que insere sem consultar
`OBS_MAX_CATALOGO` — esse teto governa só a descoberta (`catalogDiscovery.ts`).
E como o chart não traz ISRC, **todas caem na fila da etapa 4 na mesma rodada**:
3.065 → ~7.370 requisições.

Somando: a rodada **não encolhe, cresce ~25% na primeira noite**. Em regime
permanente a etapa 3 vai de 3.929 para ~7.400 req/noite, e o histórico passa a
gravar 10.795 linhas/dia em vez de 6.490 — acelerando em 66% exatamente o
gargalo que a seção 2.2 identifica como o problema real.

Há ainda um efeito silencioso: `calcularOrcamentoDescoberta` devolve `0` quando
`catalogoAtivo >= maxCatalogo` (`src/jobs/catalogDiscovery.ts:91`). Com o
catálogo em 10.795, **a descoberta do ADR 001 se desliga sozinha a partir da
noite 2**, e nenhum log diz o porquê.

#### O que a mudança realmente é

Não é "corta 40% da rodada". É **expandir o catálogo em 66% a custo zero de
requisição** — o que é um ótimo negócio (a descoberta por `/artist/{id}/radio`
gasta 1 requisição para trazer 1 faixa nova; o chart traz 4.305 por 0) e um mau
negócio para o banco, que é o gargalo.

Por isso a ordem importa: o literal já está em `300` no código, **freado por
`OBS_LIMITE_CHART=100` no ambiente** até os itens 2 e 3 entrarem. Com a gravação
por delta e o schema enxuto no lugar, o mesmo crescimento custa ~60x menos
armazenamento e a mudança passa a ser só ganho.

### 4.2 `/album/{id}/tracks` traz rank **e** ISRC

Teste:

```
album/302127/tracks -> 14 faixas
  cobertura de ISRC: 14/14
  cobertura de rank: 14/14
```

A etapa 4 hoje gasta **1 requisição por faixa** só para preencher ISRC — 3.065
requisições na fila atual. Por álbum, o custo cai para ~1 requisição a cada
10–14 faixas, e ainda resolve ISRC de faixas que sequer estão no catálogo
(útil na descoberta).

Nota: `/artist/{id}/top` **não** traz ISRC. Só `/album/{id}/tracks` traz.

### 4.3 `/artist/{id}/top?limit=99` — 99 faixas com rank em 1 requisição

```
artist/27/top?limit=50  -> n=50,  rank presente, isrc ausente
artist/27/top?limit=200 -> n=99   ← teto real é 99
```

Você já guarda `deezer_artist_id` em `observed_tracks`. Agrupar a medição por
artista em vez de por faixa é a maior alavanca estrutural de API disponível.

Hoje o ganho seria modesto (2,76 faixas/artista → ~2,7x), mas essa razão sobe
significativamente conforme o catálogo cresce, que é exatamente quando importa.

### 4.4 Playlists editoriais — descoberta muito mais barata

```
playlist/1111141961/tracks?limit=100 -> n=100, rank presente
editorial/0/charts -> tracks, albums, artists, playlists (10), podcasts
```

`/editorial/{id}/charts` e `/chart/{id}/playlists` devolvem playlists
editoriais; cada `/playlist/{id}/tracks` traz até 100 faixas com rank numa
requisição.

Compare com o que a descoberta faz hoje: `/artist/{id}/radio` gasta **1
requisição para trazer 1 faixa nova** (a alocação reserva no máximo uma
candidata por semente). As playlists editoriais também cobrem nichos que o
chart de gênero não alcança.

### 4.5 Limites observados dos endpoints

| Endpoint | Teto por requisição | Traz rank | Traz ISRC |
|---|---|---|---|
| `/chart/{id}/tracks` | **300** | sim | não |
| `/playlist/{id}/tracks` | 100 | sim | não |
| `/artist/{id}/top` | 99 | sim | **não** |
| `/album/{id}/tracks` | todas do álbum | sim | **sim** |
| `/artist/{id}/radio` | 100 | sim | não |
| `/track/{id}` | 1 | sim | sim |

A API do Deezer **não expõe headers de rate limit**. Verificado:

```
headers relevantes: access-control-max-age, x-content-type-options, x-host, x-org
(nenhum X-RateLimit-*, Retry-After, ETag ou Cache-Control)
```

Ou seja: não há como descobrir a cota restante a não ser levando o erro `code: 4`
("Quota limit exceeded"), que é o que `deezerCatalog.ts` já trata. O tratamento
atual (frear a fila inteira, não só a chamada que falhou) está correto.

---

## 5. Mudanças estruturais

### 5.1 Cadência adaptativa — troca O(N) por orçamento fixo

> **Aplicado em 16/08/2026** — migration `025_cadencia_adaptativa.sql`. As três
> bandas, o orçamento fixo, a promoção de faixa salva e a correção da dívida que
> a 021 deixou marcada entraram juntos. **O que a implementação encontrou está
> abaixo da proposta, e muda coisas importantes.**

Dado que 92% não muda, medir tudo diariamente é indefensável. Proposta de três
faixas de cadência:

| Faixa | Critério | Cadência |
|---|---|---|
| Quente | apareceu em chart, rank subindo, salva por alguém, tem stake ativo, descoberta nos últimos 30 dias | diária |
| Morna | teve movimento nos últimos 30 dias | 7 dias |
| Fria | parada há mais de 30 dias | 30 dias |

Com uma distribuição de 5% / 25% / 70%:

```
custo/dia = 0,05N + 0,25N/7 + 0,70N/30
          = 0,050N + 0,036N + 0,023N
          = 0,109N        →  ~9x mais catálogo pelo mesmo orçamento
```

E a qualidade do dado **não cai**: faixa parada no rank 300.000 há seis meses
não tem curva a perder. A tese do produto ("achar antes de estourar") exige
série densa em faixa que se move — que é justamente o que a cadência quente
garante.

**A inversão de desenho:** hoje a fila é "tudo que ainda não medi hoje" e a
rodada cresce com o catálogo. Deveria ser **orçamento fixo de R requisições por
noite**, gastas em ordem de valor esperado da medição. O catálogo cresce, a
rodada não. É a diferença entre um job que escala e um que não escala.

Isso também elimina a necessidade do `OBS_MAX_CATALOGO`, que hoje é uma
restrição de banco disfarçada de restrição de API.

#### O que a implementação encontrou

**As bandas não são níveis de popularidade, e a tabela acima comunica isso mal.**
Lida rápido, "quente/morna/fria" parece uma escala de rank. Não é: o eixo é
**interesse e movimento**. Faixa no rank 400.000 que uma pessoa salvou é quente;
faixa no rank 800 que ninguém tocou e não mexe há dois meses é fria. Popularidade
não entra em critério nenhum — o que entra é a derivada dela e a existência de
gente interessada. É o mesmo princípio da seção 8 (*o custo escala com interesse,
não com catálogo*) aplicado à cadência.

**Hoje isso não economiza nada, e está certo assim.** Medido em 16/08/2026, antes
de aplicar:

```
ativas                              6.490
entraram entre 10/08 e 15/08        6.490   ← 100% do catálogo
com histórico de mais de 30 dias        0
```

O catálogo inteiro tem menos de sete dias, então "descoberta nos últimos 30 dias"
torna **toda** faixa quente. A primeira classificação real confirmou:
`{"quente": 6490}`. A cadência é um no-op na primeira noite e a economia aparece
conforme o catálogo envelhece. Quem for ler o log de agosto procurando o ganho
não vai achar — não porque a configuração não pegou, mas porque o critério
"entrou há pouco" está funcionando.

**A distribuição 5/25/70 era chute, e o formato real parece outro.** Forçando as
janelas para 3 dias (simulação, para ver as bandas separarem num catálogo que
ainda não tem idade para isso):

| Banda | Prioridade | Faixas | % |
|---|---|---|---|
| quente — stake ou salva | 0 | 32 | 0,5% |
| quente — nova ou subindo | 1 | 3.447 | 53,1% |
| morna | 2 | 145 | 2,2% |
| fria | 3 | 2.866 | 44,2% |

A **morna quase não existe** (2,2% contra os 25% supostos). Faz sentido: faixa ou
se mexe — e aí sobe, e vira quente — ou não se mexe, e vira fria. A banda do meio
é um estado de transição, não uma população. Se isso se confirmar num catálogo
maduro, a conta real fica mais perto de `0,05N + 0,02N/7 + 0,93N/C_fria`, e o
parâmetro da banda fria manda ainda mais do que a proposta previa. **O log da
rodada passa a trazer `bandas` toda noite**, então isso deixa de ser suposição em
30 dias.

**A cadência fria ficou em 14 dias, não 30.** A banda fria é onde mora a faixa
obscura que ninguém tocou *ainda* e que está prestes a estourar — exatamente a
tese do produto. Ela é promovida a quente na primeira medição que detectar a
subida, então a subida não se perde; perde-se o **começo** dela, e a janela cega
tem o tamanho exato da cadência fria. O gráfico mostra um degrau onde deveria ter
uma curva. O preço de encurtar essa janela:

```
C_fria = 30  ->  0,109N  ->  9,2x
C_fria = 14  ->  0,136N  ->  7,4x   ← padrão adotado
C_fria =  7  ->  0,186N  ->  5,4x
```

Cortar de 30 para 14 custa 20% do ganho e corta a janela cega pela metade. É
`OBS_CADENCIA_FRIA`, não é dogma.

**A prioridade 0 existe porque orçamento aperta.** Dentro da banda quente, quem
tem stake ativo ou foi salva vem antes de quem é apenas nova. Quando a fila passa
do orçamento, a faixa que alguém está acompanhando é a última que pode ficar sem
ponto no dia.

**O corte do orçamento não pode ser silencioso.** O comentário de `OBS_LIMITE_*`
em `catalogSnapshot.ts` já nomeava esse defeito: um teto de contagem faz faixas
sumirem da série do dia sem nada gritar no log. Por isso o orçamento vem com
`observatory_queue_size()` ao lado, e toda rodada loga `filaVencida` e `adiadas`.
Verificado com orçamento de 5 numa fila de 3.415: `adiadas: 3410`, e a mensagem
do log troca para "orçamento esgotado, fila sobrou para amanhã".

#### A dívida da 021, paga

A gravação por delta assume que "sem linha no dia" significa "medi e não mudou".
Com cadência isso deixa de valer — faixa fria passa 14 dias sem medição, e
preencher esse intervalo seria invenção, que é o que a migration 009 proíbe.

A 025 resolve com `track_popularity_history.measured_gap_days`: cada linha de
mudança carrega **a largura da janela em que a mudança pode ter acontecido**. Com
medição diária é sempre 1 e não afirma nada de novo. Com cadência fria, uma linha
com gap 14 diz "o rank era 400.000 quando olhei da última vez, é 5.000 agora, e a
virada aconteceu em algum ponto destes 14 dias".

`get_track_curve` ganhou duas chaves e **`series` saiu byte a byte igual** — o
front é outro repositório e não podia quebrar. Verificado nas 6.475 gravações com
ISRC: **zero divergências**, e o hash de `get_landing_observatory` idêntico antes
e depois. As chaves novas são aditivas:

```json
"cadencia_dias": 14,
"lacunas": [{ "de": "2026-08-03", "ate": "2026-08-15" }]
```

O que isto **não** resolve, e é honesto registrar: em trechos *planos* da curva
continua-se sem saber quais dias foram medidos. Mas ali o valor é o mesmo nas duas
pontas, e o único erro possível é esconder um pico que subiu e voltou dentro da
janela — afirmação muito mais fraca do que inventar a data de um degrau, que é o
que esta parte corrige. Quem precisar da resolução do trecho plano lê
`cadencia_dias`.

#### Salvou? então saiu do chart

`source_list` era gravado na entrada e nunca mais mexido: faixa que entrou pelo
chart e foi salva depois continuava lida como `chart:81` para sempre. Medido antes
da migration: **2 faixas salvas estavam marcadas como chart/radio** — "Get Lucky"
(entrou por `chart:165`) e "3:30 A.M" (entrou por `radio:234423431`).

Agora `promote_saved_observed_tracks()` roda a cada rodada e promove essas faixas
a `acervo`. A origem não se perde: foi para a coluna nova `origin_list`, imutável,
que é o que a migration 009 realmente queria de `source_list` ("saber se o
Observatório está enviesado para o que já é popular").

Duas decisões que valem registro:

- **A promoção é de mão única.** Quem salvou e depois desfez continua marcado como
  acervo. Desmarcar reescreveria a linha toda noite para todo mundo que já
  desfez um save — escrita cara por informação que a banda já obtém de graça.
- **A banda não lê `source_list`.** Ela usa o join vivo com `tracks` e `stakes`.
  Ou seja: a coluna conta a história, o join manda na cadência. Quem desfez o save
  esfria sozinho, sem escrita nenhuma. Isso também é o que faz a promoção não ter
  latência: ela roda na etapa 2.5, antes da etapa 3 da mesma rodada, então faixa
  salva a qualquer hora do dia já está quente na medição daquela noite — não
  precisou de gancho na rota de save.

#### O que vigiar quando o projeto crescer

- **"Quente" não tem prazo de validade.** "Descoberta nos últimos 30 dias" expira;
  "salva por alguém" e "tem stake ativo" não. Se o acervo crescer muito, a banda
  quente vira o catálogo inteiro e a rodada volta a crescer com ele — O(N) de
  novo, com constante menor. Isso é coerente com o princípio (acervo cresce com
  interesse, não com catálogo), mas os 5% da distribuição proposta são uma
  **suposição sobre o acervo continuar pequeno em relação ao catálogo**. Hoje são
  36 faixas em 6.490 (0,55%). Vigiar essa razão vale mais que vigiar o orçamento.
- **O join da classificação é `tracks × observed_tracks` por artista+título** para
  as faixas sem ISRC dos dois lados. A 1M de faixas isso deixa de ser barato. A
  saída natural é exigir ISRC nos dois lados quando o acervo tiver ISRC em tudo
  (a migration 023 já preenche no save) e aposentar o casamento textual.
- **`refresh_observatory_cadence()` grava só quem trocou de banda**, pelo mesmo
  motivo da 021: um UPDATE que toca todas as linhas toda noite gera uma versão
  nova de cada tupla por dia, e a 1M de faixas isso é bloat diário maior que o
  histórico que estamos economizando. Se um dia a distribuição ficar instável e
  esse número não parar de subir, o problema é o critério oscilando num limiar,
  não a escrita.
- **O orçamento de 12.000 é folgado de propósito** (a ~8 req/s são ~25 min, e o
  catálogo tem 6.490). Ele não é o que faz a economia — quem faz é a cadência. O
  orçamento é a rede de segurança que garante que a noite tem fim.

### 5.2 Gravar só quando o rank muda

> **Aplicado em 15/08/2026** — migrations `021_historico_por_delta.sql` (regra de
> escrita) e `022_compactar_historico.sql` (as 13.320 linhas redundantes que já
> estavam gravadas).

91,9% das linhas são idênticas à anterior. Se o "não mudou" for implícito,
uma faixa fria passa de 365 para ~20 linhas por ano.

Cuidado de implementação: a leitura da curva (`get_track_curve`, migration 011)
precisa preencher as lacunas — mas isso é `last_value ignore nulls` sobre uma
série de datas, trivial em SQL, e o payload que vai para a página fica menor.

#### O que a implementação encontrou

**`ignore nulls` não existe em Postgres** (é Oracle/DuckDB). O forward-fill sai
por `count(r) over (order by d)` como grupo + `first_value` dentro do grupo.

**A economia hoje é 63,5%, não 92%.** Os 91,9% da seção 3 são sobre pares
consecutivos; a primeira linha de cada faixa sempre entra, e com 6.490 faixas de
~3,2 pontos cada isso pesa muito. A economia tende a 92% conforme a série
alonga. Verificado reconstruindo a série densa a partir do delta em todas as
20.990 linhas: **zero divergências** — o forward-fill é lossless, e os hashes de
`get_track_curve` e `get_landing_observatory` bateram byte a byte antes e depois.

**Um terceiro leitor quebrava, e não estava no radar.** A `get_landing_observatory`
(015) derivava a janela de observação do próprio histórico:

```sql
dias = max(recorded_at)::date - min(recorded_at)::date   -- distância entre LINHAS
```

Com delta isso vira a distância entre **mudanças**. Uma faixa que subiu no dia 2
e ficou parada até o dia 40 teria `dias = 1` e cairia no corte de 3 dias —
exatamente a faixa que a seção existe para mostrar. Agora a janela sai de
`observed_tracks` (`added_at` → `last_checked_at`) e `rank_inicial` sai de
`first_rank`, que já estava gravado e é imune ao delta.

**A comparação é contra o histórico, não contra `last_rank`.** `last_rank` é
atualizado em toda rodada, inclusive quando o ponto é descartado; se a régua
fosse ele, uma segunda medição no mesmo dia UTC (barrada pelo índice de
idempotência) criaria deriva entre o que está gravado e o que se acredita
gravado. Comparando com a tabela, a regra se auto-corrige.

**A grade do forward-fill vai até `last_checked_at`, não até hoje** — se o job
parou de medir a faixa, a curva termina na última medição real em vez de esticar
uma reta que ninguém observou.

**Ressalva para o item 4** — *paga em 16/08/2026 pela migration 025*: tudo isso
valia porque o job media todas as faixas todo dia, então "sem linha" só podia
significar "medi e não mudou". Com cadência adaptativa, faixa fria passa 14 dias
sem medição e o forward-fill sobre esse intervalo **seria** invenção. A 025
resolveu com `measured_gap_days` na linha de mudança e a chave `lacunas` em
`get_track_curve` — ver o fim da seção 5.1.

#### Resultado da compactação (022)

| | linhas | total | dados | índices | B/linha |
|---|---|---|---|---|---|
| antes de tudo | 21.027 | 5.632 kB | 1.744 kB | 3.848 kB | 274 |
| depois de 020 | 21.027 | 4.120 kB | 1.744 kB | 2.336 kB | 201 |
| depois de 022 | **7.707** | **1.528 kB** | 640 kB | 880 kB | 203 |

**−72,9% no total.** A prova de que nada se perdeu: reconstruindo a série densa a
partir da tabela já compactada e comparando com o backup, dia a dia — **20.990
dias, 6.490 faixas, zero divergências** — e os hashes das duas funções de leitura
continuaram idênticos aos de antes da 021.

O `vacuum full` importou: sem ele o heap ficava em 1.744 kB com 45% de espaço
morto, que só seria reabsorvido pelas inserções das noites seguintes.

Backup integral em `public.track_popularity_history_bkp_20260815`, descartável
quando não fizer mais falta.

### 5.3 Schema enxuto

| Mudança | Ganho |
|---|---|
| Dropar `idx_track_popularity_track_uri` (prefixo redundante) | libera índice inteiro |
| Dropar `idx_track_popularity_recorded_at` (pouco útil sozinho num histórico) | libera índice inteiro |
| `track_uri text` → `deezer_track_id bigint` (ou id interno `int`) | −20 B na tabela e em cada índice |
| `recorded_at timestamptz` → `dia date` | −4 B, e casa com a chave de idempotência que já é por data |
| `source varchar` → dispensável se a série for só do Deezer | −alguns bytes + overhead |
| Dropar `id serial` se `(track, dia)` já é a chave natural única | −4 B + um índice único inteiro |

Combinado, **274 → ~50 bytes por linha (~5,5x)**.

### 5.4 Efeito combinado

**No banco:** 12x menos linhas (delta) × 5,5x menos bytes/linha (schema) ≈
**60x menos armazenamento**.

- 10k faixas: 1,0 GB/ano → **~17 MB/ano**
- 1M faixas: 100 GB/ano → **~1,7 GB/ano**

**Na API:** 3x (chart 300) × ~5x (batch por artista/álbum em catálogo grande) ×
9x (cadência adaptativa). Não multiplicam exatamente, mas a ordem de grandeza é
**50–100x**: os ~173k faixas suportados hoje viram algo entre **1 e 2 milhões**
na mesma janela noturna, sem sair de um plano barato de Postgres.

Que já é a ordem de grandeza de "toda música que importa".

---

## 6. Sobre burlar o limite

**Não faça, e você não precisa.**

Rotação de IP/proxy contra a Deezer:

1. Viola os termos de uso deles.
2. É frágil — quebra sem aviso e sem log claro.
3. **Resolve o problema errado.** Mesmo com 10x o teto, o custo continua O(N)
   por dia e quebra igual, só um pouco mais tarde. E o banco quebra antes de
   qualquer forma.

O ganho está em **medir mais faixas por requisição** (3x, 10x, 50x, seção 4) e
em **medir menos vezes as faixas paradas** (seção 5.1), não em fazer mais
requisições. Há duas ordens de grandeza disponíveis pelo caminho legítimo.

O que **é** legítimo e está sobre a mesa, em ordem de simplicidade:

- **Espalhar a rodada pelas 24h** em vez de concentrar às 05:00. Hoje usa 18 min
  de 1.440. Fator 80 de graça, sem tocar em lógica nenhuma.
- Aumentar o paralelismo dentro da cota (`EM_VOO_MAX` já existe e está
  conservador em 6).
- Se um dia a escala realmente exigir, negociar acesso com a Deezer — mas isso
  só depois de esgotar batching e cadência, que valem muito mais.

---

## 7. Sobre o Spotify

**Não é o gargalo e não escala com o catálogo.** Uso atual:

- `findSpotifyIdByIsrc` no job — one-shot por faixa (`spotify_checked_at`),
  ~250/dia em regime permanente. Trivial.
- Frontend (`utils/spotifyService.ts`) em request-time, com
  `next: { revalidate }` de 300s a 86400s. Escala com tráfego, não com catálogo.

O tratamento de 429 em `findSpotifyIdByIsrc` (respeitar `Retry-After`, e a
distinção entre `falhou` e "não existe") está correto e é importante — o próprio
comentário no código registra o incidente de 1.904 faixas queimadas por
confundir os dois casos.

### O risco real é descontinuação, não limite

O ADR 001 já registra `403` em related-artists e top-tracks para a credencial
atual, e a migration 009 registra que o `popularity` saiu do ar. O Spotify vem
cortando endpoints para apps em Development Mode (recommendations,
related-artists, audio-features, top-tracks, previews de 30s).

Depender do Spotify para qualquer coisa além de "id canônico + capa" é risco de
produto, não risco de cota.

### O problema concreto disso hoje

> **Resolvido em 15/08/2026** — esta seção é o que originou o **item 9**, e ele
> saiu do papel pelo
> [plano de independência do Spotify](plano-independencia-do-spotify.md)
> (migrations 023 e 024). O texto abaixo fica como estava escrito: é o
> diagnóstico que motivou a troca, e vale mais intacto que corrigido depois do
> fato. O que mudou está logo em seguida.

As páginas são endereçadas por `/track/[spotifyId]`, e `findSpotifyIdByIsrc`
busca com `market=BR`. Resultado medido:

```
faixas ativas          6.490
com spotify_track_id   1.388  (21,4%)
spotify não achou         10
```

**78,6% do Observatório não tem página no site.** (A maior parte é fila
pendente, não falha — mas a dependência estrutural continua.)

Para a ambição de "qualquer música que exista", o identificador canônico do
Mirsui deveria ser o **ISRC**, com o id do Spotify sendo enriquecimento
opcional. É um refactor grande, mas quanto mais tarde, pior — cada dia de
conteúdo e link indexado aumenta o custo da troca.

#### Onde isso ficou (conferido no banco em 16/08/2026)

O endereço da página deixou de ser `/track/[spotifyId]` e passou a ser o ISRC,
com id do Spotify e id do Deezer redirecionando por consulta local. O funil do
`market=BR` saiu da frente de dado que já era nosso:

```
                        antes    depois
faixas ativas            6.490     6.490
com ISRC                 3.425     6.490   <- fila zerada, 0 falhas do Deezer
com página no site       1.388     6.490   <- 4,67x
com spotify_track_id     1.388     1.388   <- virou enriquecimento opcional
```

O `spotify_track_id` continua sendo gravado, mas **por visita**
(`POST /tracks/resolve-spotify`) e não por varredura: a etapa 5 do job — 2.027
buscas no Spotify por noite — deixou de existir. `SPOTIFY_CLIENT_ID` e
`SPOTIFY_CLIENT_SECRET` são opcionais desde então, e o site sobe inteiro sem
elas. As fases, o teste de aceitação e o que ficou de fora estão no
[plano](plano-independencia-do-spotify.md).

O risco que esta seção nomeia — descontinuação, não cota — continua valendo, só
que agora ele não derruba mais nada: o Spotify saiu do caminho de render.

---

## 8. O limite que nenhuma otimização remove

"Qualquer música que exista" são mais de 100 milhões de gravações. **Ninguém
mede tudo todo dia — nem o Spotify.** Isso não é limitação de infra, é
aritmética.

O desenho de produto que fecha a conta:

- **Página on-demand para qualquer faixa** (resolvida por busca no momento do
  acesso). Qualquer música que exista tem página.
- **Curva só para o catálogo observado.** A faixa entra no catálogo quando
  alguém a salva, crava ou visita.

Assim o custo escala com **interesse**, não com catálogo. E continua honesto com
o que a migration 009 já estabelece: *curva de subida não tem backfill; ou você
mediu naquele dia, ou aquele ponto não existe*. Dizer "observando desde
15/08/2026" é uma afirmação verdadeira e defensável; fingir histórico não seria.

---

## 9. Ordem de execução recomendada

| # | Ação | Esforço | Impacto |
|---|---|---|---|
| 1 | ~~`limit=300` no chart~~ **feito, freado** | 1 linha | 3,00x de cobertura; −20,9% na etapa 3, **+66% de catálogo** (ver 4.1) |
| 2 | ~~Dropar os índices redundantes~~ **feito (020)** | 2 linhas SQL | −39,3% de índice; 274 → 201 B/linha |
| 3 | ~~Gravar só quando o rank muda~~ **feito (021 + 022)** | médio | −63,3% nas linhas de hoje, tendendo a −92%; tabela −72,9% |
| 4 | ~~Cadência adaptativa por orçamento fixo~~ **feito (025), ainda sem efeito** | alto | **o que realmente destrava a escala** — mas 100% do catálogo é quente até ele envelhecer (ver 5.1) |
| 5 | ~~ISRC via `/album/{id}/tracks` em vez de `/track/{id}`~~ **feito (024), ainda não medido** | médio | ~10x na etapa 4 — o ganho aparece na próxima fila (ver nota) |
| 6 | Medição em lote via `/artist/{id}/top` | alto | ~5x em catálogo grande |
| 7 | Reconsiderar `OBS_MAX_CATALOGO = 10.000` | 1 env | destrava crescimento |
| 8 | Playlists editoriais como fonte de descoberta | médio | descoberta ~100x mais barata |
| 9 | ~~ISRC como identificador canônico (em vez de spotify_id)~~ **feito (023)** | alto | tirou o risco estrutural do Spotify; 1.388 → 6.490 páginas (4,67x) |

Item 2 vale a pena mesmo que nada mais seja feito. Item 1 está aplicado no
código mas **freado no ambiente**: ele expande o catálogo em 66%, e isso só é
barato depois do item 3 (ver a correção na seção 4.1). Item 4 é o único que muda
a natureza do problema de O(N) para O(1) — os outros compram tempo, esse compra
escala.

**O item 4 está aplicado e ainda assim a rodada de hoje é idêntica à de ontem.**
Não é contradição: a banda quente inclui "entrou nos últimos 30 dias" e o
catálogo inteiro entrou entre 10 e 15 de agosto, então a primeira classificação
deu `{"quente": 6490}`. O mecanismo está montado e o ganho é uma função do tempo,
não de mais código — a partir de meados de setembro as faixas começam a esfriar
sozinhas e o `bandas` do log passa a mostrar a economia. **Soltar o freio do item
1 agora ficou barato justamente por causa disso**: as ~4.305 faixas novas entram
quentes por 30 dias e depois caem para a banda fria de 14 dias, em vez de custar
uma requisição por noite para sempre.

**Os itens 5 e 9 entraram juntos, e não por esta ordem** — vieram a reboque do
[plano de independência do Spotify](plano-independencia-do-spotify.md), porque o
item 9 deixou de ser dívida técnica e virou incidente: as páginas de faixa
estavam renderizando em branco por causa de um 429. O item 5 foi junto porque a
etapa 4 saiu de "passo intermediário para a ponte do Spotify" e virou o que dá
página às faixas novas.

**Ressalva no item 5:** ele está no código (`faixasDoAlbum` em
`src/lib/deezerCatalog.ts`, usada pela etapa 4 de `catalogSnapshot.ts`, que
agrupa a fila por álbum) mas **ainda não rendeu o ~10x**. Quando a fila de 3.065
drenou, `observed_tracks.deezer_album_id` acabava de ser criada e estava vazia —
tudo passou pelo caminho antigo, uma requisição por faixa. Hoje a coluna tem
3.075 faixas preenchidas e a fila está em 0: o ganho aparece na próxima fila, e
por isso a linha da tabela diz "feito, ainda não medido".

**Ordem revisada de execução:** ~~2~~ → ~~3~~ → ~~9~~ → ~~5~~ → ~~4~~ → soltar o
freio do 1 → 7 → 6 → 8.

O item 4 entrou antes de soltar o freio do 1, e não depois como a ordem anterior
previa. Foi de propósito: a cadência é o que torna o crescimento de catálogo
barato, então fazia mais sentido ter o mecanismo pronto **antes** de despejar
4.305 faixas novas do que depois. Os itens 7 (teto do catálogo) e 6/8 (lote e
descoberta) agora fazem mais sentido nessa ordem — 7 é um env e destrava
crescimento que a cadência já sabe absorver; 6 e 8 baixam o custo unitário, e só
valem depois que o volume justificar.

---

## 10. Adições — fontes complementares (não discutidas antes)

Nada aqui é necessário agora, mas muda o teto do que é possível a médio prazo.

### MusicBrainz — resolve identidade sem gastar API

Rate limit de 1 req/s (apertado), **mas publica dumps completos do banco**.
Baixando o dump você tem ISRC ↔ recording ↔ artist ↔ release offline, de graça,
sem chave e sem cota. Isso resolveria:

- a ponte de ISRC sem gastar uma requisição por faixa (etapa 4 inteira);
- desambiguação dos ids duplicados do Deezer que a migration 011 trata com
  `last_rank desc` (5 casos em 2.602, mas cresce com o catálogo);
- um identificador canônico neutro, que não é do Spotify nem do Deezer — o que
  atende diretamente o problema da seção 7.

### Last.fm — segunda métrica de popularidade

`track.getInfo` devolve `playcount` e `listeners`, 5 req/s, chave gratuita. O
`listeners` é mais estável e mais interpretável que o `rank` do Deezer, que é
um índice opaco. Ter duas métricas independentes também protege contra a fonte
única: se a Deezer mudar o cálculo do `rank`, toda a série histórica vira
incomparável e não há como perceber sem um segundo sinal.

### ListenBrainz

Dumps públicos de escutas reais. Sem cota relevante. Pode servir de validação
externa para o Faro: se uma faixa sobe no Mirsui, subiu também no ListenBrainz?

### Observação sobre depender de fonte única

Hoje toda a métrica do Observatório e dos stakes vem do `rank` do Deezer. Se a
Deezer mudar a fórmula, restringir a API pública ou simplesmente sair do ar,
não há plano B e a série histórica inteira perde comparabilidade. Não é urgente
com 6,5k faixas — mas é o tipo de risco que fica caro exatamente quando o
projeto começa a valer alguma coisa.

---

## Anexo A — Queries de medição

```sql
-- Estado do catálogo e das filas
select
  (select count(*) from public.observed_tracks) as observed_total,
  (select count(*) from public.observed_tracks where active) as observed_ativas,
  (select count(*) from public.observed_tracks where active and isrc is null) as sem_isrc,
  (select count(*) from public.observed_tracks
    where active and isrc is null and isrc_checked_at is null) as fila_isrc,
  (select count(*) from public.observed_tracks
    where active and isrc is not null and spotify_track_id is null
      and spotify_checked_at is null) as fila_spotify,
  (select count(*) from public.observed_tracks
    where active and recommendation_checked_at is null) as fila_descoberta,
  (select count(*) from public.track_popularity_history) as historico_linhas,
  (select count(*) from public.tracks) as acervo_linhas,
  (select count(distinct track_uri) from public.tracks) as acervo_faixas_unicas;

-- O número que muda tudo: quanto o rank realmente muda entre medições
with p as (
  select track_uri, rank, recorded_at,
         lag(rank) over (partition by track_uri order by recorded_at) as anterior
  from public.track_popularity_history
  where source = 'deezer' and rank is not null
)
select count(*) as medicoes_com_anterior,
       count(*) filter (where rank = anterior) as rank_identico,
       round(100.0 * count(*) filter (where rank = anterior)
             / nullif(count(*),0), 1) as pct_sem_mudanca,
       round(100.0 * count(*) filter (where abs(rank - anterior) < greatest(anterior*0.02,1))
             / nullif(count(*),0), 1) as pct_variacao_menor_2pct
from p where anterior is not null;

-- Custo real por linha no histórico
select c.relname as tabela,
       pg_size_pretty(pg_total_relation_size(c.oid)) as total,
       pg_size_pretty(pg_relation_size(c.oid))       as dados,
       pg_size_pretty(pg_indexes_size(c.oid))        as indices
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
order by pg_total_relation_size(c.oid) desc limit 10;

-- Razão faixas/artista e cobertura do Spotify
select count(*) as faixas_ativas,
       count(distinct deezer_artist_id) as artistas,
       round(count(*)::numeric / nullif(count(distinct deezer_artist_id),0), 2)
         as faixas_por_artista,
       count(*) filter (where spotify_track_id is not null) as com_spotify_id,
       count(*) filter (where spotify_checked_at is not null
                          and spotify_track_id is null) as spotify_nao_achou
from public.observed_tracks where active;
```

## Anexo B — Testes contra a API do Deezer

```js
const g = async (p) => (await fetch('https://api.deezer.com' + p)).json()

// Profundidade real do chart — o código assume 100, o teto é 300
await g('/chart/0/tracks?limit=100&index=0')    // n=100
await g('/chart/0/tracks?limit=100&index=200')  // n=99
await g('/chart/0/tracks?limit=100&index=500')  // n=0
await g('/chart/0/tracks?limit=500')            // n=299
await g('/chart/132/tracks?limit=500')          // n=300
await g('/chart/116/tracks?limit=500')          // n=300
await g('/chart/12/tracks?limit=500')           // n=300
await g('/chart/152/tracks?limit=500')          // n=300

// Endpoints em lote: rank e ISRC
await g('/artist/27/top?limit=50')     // n=50,  rank sim, isrc NÃO
await g('/artist/27/top?limit=200')    // n=99   (teto real)
await g('/album/302127/tracks')        // n=14,  rank 14/14, isrc 14/14
await g('/playlist/1111141961/tracks?limit=100') // n=100, rank sim
await g('/editorial/0/charts')         // tracks, albums, artists, playlists(10), podcasts

// Headers: a Deezer não expõe cota
// access-control-max-age, x-content-type-options, x-host, x-org
// (nenhum X-RateLimit-*, Retry-After, ETag ou Cache-Control)
```

---

## Referências no código

- `src/lib/deezerCatalog.ts` — fila, throttle (`INTERVALO_MS`, `EM_VOO_MAX`),
  tratamento de `code: 4`, e o comentário sobre o teto de 100 do chart que
  precisa ser corrigido
- `src/jobs/catalogSnapshot.ts` — as 6 etapas da rodada, `OBS_LIMITE_CHART`
- `src/jobs/catalogDiscovery.ts` — orçamento e alocação da descoberta
- `src/lib/spotify.ts` — `findSpotifyIdByIsrc`, tratamento de 429
- `src/server.ts` — cron das 05:00 e a trava `observatorioRodando`
- `migrations/009_observatorio.sql` — a tese ("curva de subida não tem backfill")
- `migrations/011_curva_da_faixa.sql` — leitura da curva, ids duplicados
- `docs/decisions/001-descoberta-controlada-de-faixas.md` — ADR da descoberta
