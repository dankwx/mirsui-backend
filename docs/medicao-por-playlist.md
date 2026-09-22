# Medição por playlist do Deezer — 22/09/2026

- **Status:** investigado e testado, **não integrado**. A integração fica para
  depois de o dono assinar o TuneMyMusic.
- **Pergunta que originou:** "dá para medir todas as ~100 mil faixas do
  Observatório todo dia, e isso aguenta se o projeto crescer?"
- **Resposta curta:** uma playlist pública do Deezer devolve o `rank` de até
  2.000 faixas numa requisição, e o rank é o mesmo de `/track/{id}`. Se as
  faixas do catálogo estiverem em playlists do perfil do dono, a medição diária
  cai de ~38 mil requisições para ~3 a 6 mil (−85% a −92%). Como o Deezer não
  aceita mais app novo, as faixas entram nas playlists por um serviço de
  transferência que já tem permissão de escrita (TuneMyMusic). Em dois testes
  com 400 faixas, 87% vieram exatamente como pedidas. As outras vieram em outra
  versão com o mesmo ISRC e são detectadas pelo id.

Leia junto com a [análise de escala](analise-escala-apis-e-banco.md), a
[medição por álbum](medicao-por-album.md) e o
[Deezer compartilhado](deezer-compartilhado.md).

---

## 1. O problema

A etapa 3 da rodada mede cada faixa pelo caminho mais barato que existe hoje:
uma consulta a `/album/{id}/tracks` quando duas ou mais faixas do mesmo álbum
estão vencidas, e `/track/{id}` quando a faixa está sozinha no álbum. Tudo passa
pelo `mirsui-deezer-gateway`, a 3 requisições por segundo, que é o ritmo em que
o Deezer parou de devolver 403 (medido em 13/09).

Rodada de 22/09/2026, lida do log (`Observatório: rodada concluída`):

| | |
|---|---|
| Faixas ativas | 100.648 |
| Bandas | quente 62.577 (1 dia) · morna 11.225 (7) · fria 17.447 (14) · 9.399 novas |
| Medidas na etapa 3 | 62.454 — 44.413 por álbum (5.787 álbuns) + 18.041 uma a uma |
| Requisições da rodada | 26.991, ~2,7 por segundo efetivos |
| Duração | 9.900 s (**2h45**) |
| Faixas por requisição na medição | ~2,6 |

A duração subiu de 37 min (14/09) para 2h45 (22/09), porque a descoberta traz
~9,4 mil faixas por noite (`OBS_LIMITE_DESCOBERTA=10000`).

**Medir tudo todo dia com o método atual.** Distribuição das faixas ativas por
álbum, em 22/09:

| Faixas do catálogo no álbum | Álbuns | Faixas |
|---|---|---|
| 1 (sozinha) | 26.111 | 26.111 |
| 2–3 | 3.688 | 8.410 |
| 4–6 | 1.996 | 9.590 |
| 7–12 | 2.082 | 19.891 |
| 13+ | 1.471 | 35.967 |
| sem álbum | — | 679 |

São 9.237 requisições de álbum mais 26.790 de faixa, **~38 mil requisições e
~4h por noite**. As faixas sozinhas no álbum são 27% do catálogo e 72% do custo.

O custo cresce com o catálogo: ~2,65 faixas por requisição. A 500 mil faixas (o
`OBS_MAX_CATALOGO`) seriam ~189 mil requisições e ~19h por noite, dividindo o
mesmo gateway com as páginas do site. A seção 7 tem a projeção.

`/artist/{id}/top?limit=100` foi testado como alternativa e **não serve**. Em
dois artistas com faixas sozinhas no álbum, cobriu 0 de 4 e 2 de 3: o top traz
outras versões, com outros ids. Quando cobre, o rank bate.

## 2. A ideia

`/playlist/{id}/tracks` devolve, para cada faixa, `id`, `isrc`, `rank`,
`readable`, título, artista e álbum. Uma playlist **pública** é lida sem token,
e a de qualquer usuário comum também. Se o catálogo estiver dividido em
playlists públicas do perfil do dono do Mirsui, a rodada lê algumas dezenas de
respostas em vez de dezenas de milhares.

Limites de conta do Deezer (página de suporte atualizada em 16/06/2026):

| | |
|---|---|
| Playlists criadas | 2.000 |
| Faixas por playlist | 5.000 |
| **Teto teórico** | **10 milhões de faixas por conta** |

O Deezer avisa que, acima de certo volume, parte do conteúdo deixa de aparecer
na interface, mas continua na conta. **Ainda não foi testado se a API devolve
as faixas de uma playlist cheia de 5.000.**

### Por que não pela API oficial

Criar playlist e adicionar faixa pela API pede OAuth com a permissão
`manage_library`, e o Deezer não aceita mais cadastro de app novo. Três saídas
foram consideradas:

1. **Serviço de transferência que já tem app aprovado** (TuneMyMusic,
   Soundiiz). O dono autoriza pelo login oficial do Deezer e importa um CSV.
   Não viola nada. **Escolhido.**
2. **A API interna do player web** (`gw-light`, com o cookie de sessão), que é a
   que programas de download usam. Automática e grátis, mas viola os termos, pode
   parar sem aviso, e a punição cai na conta do dono. **Descartado.**
3. **Adicionar à mão pelo app.** Inviável com 100 mil faixas.

Custo (preços públicos de setembro de 2026):

| Serviço | Grátis | Pago |
|---|---|---|
| TuneMyMusic | até 500 faixas por transferência | US$ 4,50/mês ou **US$ 24/ano** |
| Soundiiz | até 200 faixas por transferência | US$ 5/mês ou US$ 39/ano |

O TuneMyMusic diz que usa o ISRC para achar a faixa, e divide sozinho em partes
o que passa de 5.000.

## 3. Como foi testado

Todas as leituras do banco foram feitas com `default_transaction_read_only = on`.
Nada foi gravado no banco de produção.

### 3.1 Uma requisição, muitas faixas

- `/playlist/{id}/tracks?limit=2000` numa playlist pública de 1.947 faixas, de
  um usuário qualquer: **as 1.947 vieram numa resposta**, todas com `rank`, e
  sem `next`.
- Duas faixas da posição 500 conferidas em `/track/{id}` na mesma hora: rank
  idêntico (831.391 e 783.386).
- A resposta tem ~4 MB (~2 KB por faixa). 100 mil faixas são ~200 MB por noite.
- Não se achou playlist pública com mais de 2.000 faixas para testar se uma
  página chega a 5.000. No pior caso, são 3 páginas por playlist.

Essas requisições foram feitas direto em `api.deezer.com`, fora do gateway (~10
no total), porque o gateway não aceita `/playlist` (seção 8).

### 3.2 Teste 1 — faixas sozinhas no álbum

- **Amostra:** 200 faixas ativas, com ISRC, sozinhas no seu álbum dentro do
  catálogo. São as mais caras de medir. O sorteio é determinístico:
  `order by md5(deezer_track_id || 'mirsui-teste-200')`. 197 artistas, rank de
  70 a 944.560 (mediana ~137 mil).
- **CSV:** `Track name, Artist name, Album, Playlist name, Type, ISRC`, o mesmo
  formato que o próprio TuneMyMusic exporta.
- **No TuneMyMusic:** origem "Upload file"; Song name field = Track name; Artist
  name field = Artist name; Separate playlists by = "Put all songs in a big
  playlist"; destino Deezer. O ISRC não foi pedido na tela, mas a coluna foi
  junto.
- **Playlist gerada:** `15782734641`, pública no perfil do dono.
- **Comparação** (`comparar.py`): a playlist lida numa requisição; as 200 faixas
  medidas também uma a uma por `/track/{nosso id}`, pelo gateway, com
  `priority: catalog` e `maxAgeMs: 0`, na mesma hora; casamento pelo id e depois
  pelo ISRC.

### 3.3 Teste 2 — álbuns inteiros

- **Amostra:** 31 álbuns sorteados (semente `mirsui-teste-albuns-200`) entre os
  que têm de 2 a 25 faixas no catálogo, com todas as faixas deles, somando 200.
  62 artistas, rank de 0 a 915.930. Álbum inteiro mostra quantos álbuns ficam
  com alguma faixa trocada, e é isso que decide o custo, porque um álbum com uma
  faixa trocada ainda gasta uma requisição.
- Mesmo procedimento. **Playlist `15782763741`.** Script `comparar-albuns.py`.

## 4. Resultados

### Teste 1 — faixas sozinhas no álbum

| | Faixas | Rank igual ao `/track/{id}`? |
|---|---|---|
| Nosso id, exato | **179 (89,5%)** | **sim, 179 de 179** |
| Outro id, mesmo ISRC | 21 (10,5%) | não, 0 de 21 |
| Não veio | 0 | — |

### Teste 2 — álbuns inteiros

| | Faixas | Rank igual? |
|---|---|---|
| Nosso id, exato | **171 (85,5%)** | **sim, 171 de 171** |
| Outro id, mesmo ISRC | 29 (14,5%) | não, 0 de 29 |
| Não veio | 0 | — |

| | Álbuns |
|---|---|
| Todas as faixas com o nosso id | **27 de 31** |
| Com alguma troca | 4: um com 24/24, um com 2/20, um com 2/9, um com 1/7 |

**24 das 29 trocas estão num álbum só**, uma coletânea de música clássica que
reusa os ISRCs dos discos originais (Vivaldi, Kreisler, Samouil…). O TuneMyMusic
escolheu as faixas dos discos originais.

### O que a acurácia quer dizer

- **Quando o id vem igual, o rank é exato: 350 de 350.** A playlist não é uma
  aproximação: é o mesmo número que `/track/{id}` devolve.
- **Quando o id vem diferente, o rank é de outra gravação.** Exemplos: "Danse
  arabe" (André Previn) com rank 72.338 na nossa versão e 21 na escolhida; "Go
  West" (Eldissa) com 102.153 contra 6.193. O TuneMyMusic casa pelo ISRC e, quando
  há várias versões, costuma escolher a mais popular.
- **ISRC não identifica a gravação sozinho no Deezer.** No teste 1, "Espírito
  Vem" (Isaías Saad) voltou como "Mais Perto" (Denise Seixas), outra música com o
  mesmo ISRC.
- Nenhuma faixa se perdeu (0 de 400) e nenhuma faixa estranha entrou.
- As trocas se concentram em música clássica e em coletâneas, onde o mesmo ISRC
  aparece em vários lançamentos.

**Regra que sai disto:** a medição por playlist casa **somente pelo id do
Deezer**. Faixa da playlist cujo id não está no catálogo é ignorada. Faixa do
catálogo que não apareceu com o próprio id volta para o caminho atual (álbum ou
faixa). Assim, o erro de casamento do TuneMyMusic custa requisição, nunca dado
errado.

## 5. Por que é viável

Projeção para o catálogo de 22/09, com tudo medido todo dia:

| | Hoje | Com playlists |
|---|---|---|
| Faixas sozinhas no álbum | ~26,8 mil requisições | ~2,8 mil (10,5% trocadas) |
| Faixas em álbuns com várias | ~9,2 mil | ~0,4 a 2,8 mil (4/31 álbuns com troca, intervalo largo) |
| Leitura das playlists | — | ~21 playlists × 1 a 3 páginas ≈ 25 a 60 |
| **Medição** | **~38 mil** | **~3 a 6 mil (−85% a −92%)** |
| Descoberta, charts e ISRC | ~3,2 mil | ~3,2 mil |
| **Rodada** | **~41 mil, ~4h** | **~6 a 9 mil, ~45 min** |

O intervalo do caso "álbuns com várias" é largo porque 31 álbuns é amostra
pequena: 4 em 31 é compatível com algo entre 5% e 30% no catálogo. Mesmo no pior
caso, a medição cai ~85%.

Outras razões:

- O custo passa a depender do **número de playlists**, não do número de faixas.
  A 500 mil faixas são ~100 playlists; a 10 milhões, 2.000.
- A fração trocada (~10–15%) continua pelo método atual, que já funciona e já é
  testado. Não há caminho novo sem volta.
- O gateway deixa de ser dominado pelo job e sobra cota para as páginas do site,
  que é o que quebra primeiro se o tráfego crescer.
- Custa US$ 24/ano, e só a partir do momento em que fizer diferença.

## 6. Limitações e riscos

- **Faixas novas só entram na playlist quando o dono faz upload.** Enquanto a
  descoberta trouxer ~9,4 mil por noite, o upload tem que ser **semanal**.
  Uploads mensais acumulariam ~280 mil faixas fora das playlists, ~108 mil
  requisições por noite, pior que hoje. Depois que o catálogo parar no teto, um
  upload final basta.
- **Faixa removida ou indisponível no Deezer** some da playlist ou vem com
  `readable: false`. Ela cai no caminho atual, que é o único que pode confirmar
  remoção (a mesma regra da medição por álbum).
- **Não testado:** ler uma playlist de 5.000 numa página; o tempo que o
  TuneMyMusic leva para importar 100 mil ou mais faixas; se o Deezer modera
  contas com muitas playlists grandes; a política de uso do TuneMyMusic para
  volumes assim.
- **Dependência de terceiro:** se o TuneMyMusic sair do ar ou perder o acesso ao
  Deezer, as playlists que já existem continuam legíveis. Só deixam de entrar
  faixas novas, que seguem pelo caminho atual.
- **O que foi medido é pouco:** 400 faixas, num dia. O número de 350 de 350
  ranks exatos é forte. A taxa de troca por álbum ainda tem intervalo largo.

## 7. Quando passa a valer a pena

Projeção com tudo medido todo dia pelo método atual (~2,65 faixas por
requisição, ~2,7 requisições por segundo, descoberta de 9,4 mil por noite a
partir de 100.648 em 22/09):

| Catálogo | Por volta de | Requisições por noite | Duração |
|---|---|---|---|
| 100 mil | 22/09 | ~41 mil | ~4h |
| 200 mil | 03/10 | ~79 mil | ~8h |
| 300 mil | 13/10 | ~116 mil | ~12h |
| 400 mil | 24/10 | ~154 mil | ~16h |
| 500 mil (teto) | 03/11 | ~189 mil | ~19h |

Com as bandas atuais (morna a 7 dias, fria a 14) não há aperto antes do teto: a
rodada fica na casa de 3 a 5 horas.

Dois motivos para não esperar a conta chegar a 24h:

1. **Volume sustentado nunca visto.** O maior dia medido foi ~27 mil
   requisições do job. Não há evidência de que o Deezer aceite 100 mil ou mais
   por dia deste IP a 3 por segundo, sem uma onda de 403 como a de 13/09.
2. **A rodada entra no horário do site.** Passando de ~12h, ela atravessa a
   tarde e a noite, dividindo o gateway com as páginas. As páginas têm
   prioridade 4:2:1, e o job fica mais lento justamente quando não tem folga.

Recomendação: ter o código pronto antes, **assinar por volta de 06–10/10** e
fazer o primeiro upload grande antes de o catálogo passar de ~250–300 mil
(~08–13/10).

**Ligado em 22/09/2026, 19:36:** `OBS_CADENCIA_MORNA=1`, `OBS_CADENCIA_FRIA=1` e
`OBS_ORCAMENTO_MEDICAO=300000` no `.env` de produção (backup em
`.env.bak-2026-09-22`). A primeira rodada com tudo diário é a de 23/09. O
orçamento de 300 mil é a trava para o caso de a integração atrasar: por volta
de 13/10 ele passa a cortar, a rodada fica em ~12h, e o que sobra (a banda
fria primeiro, pela ordem da fila) vai para o dia seguinte e aparece como
`adiadas` no log. Para voltar ao modo anterior, restaurar o backup e reiniciar
o `mirsui-backend`.

## 8. Desenho da integração (para depois)

1. **Gateway** (`src/lib/deezerGateway.ts`): aceitar `/playlist/{id}/tracks` em
   `normalizeDeezerPath` e permitir `limit` até 2.000 (ou 5.000, se o teste pendente
   da seção 6 confirmar) só nesse caminho. Rever o limite de 2 MB por entrada do
   cache: medição usa `maxAgeMs: 0` e não precisa de cache, mas a resposta tem
   ~4 MB.
2. **Tabela `measurement_playlists`**: id da playlist, rótulo, data do upload, e
   a contagem da última leitura (total, casadas pelo id, trocadas).
3. **Etapa 3** (`src/jobs/catalogSnapshot.ts` e `catalogMeasurement.ts`), antes
   do `medirPorAlbum`:
   - ler cada playlist cadastrada, paginando até o fim; paginação incompleta é
     falha e nunca confirma ausência;
   - para cada faixa vencida cujo `deezer_track_id` veio na resposta com `rank`
     válido, gravar pela mesma `record_observations` (histórico por delta
     inalterado);
   - o resto da fila segue para `medirPorAlbum` e `/track/{id}`, como hoje;
   - casar somente pelo id (seção 4).
4. **Log da rodada**: `medidasPorPlaylist`, `playlistsLidas`,
   `playlistFaixasTrocadas` (id diferente com ISRC nosso) e `playlistAusentes`,
   ao lado dos contadores de álbum que já existem. A lição de 26/08 vale aqui:
   medir o que foi entregue, não o que foi pedido.
5. **Export do CSV para upload**: um script que lista as faixas ativas que ainda
   não estão em nenhuma playlist e escreve o CSV já dividido em blocos de 5.000,
   com `Playlist name` = `Mirsui 001`, `Mirsui 002`… No TuneMyMusic, escolher
   "Separate playlists by: Playlist Name". Depois, cadastrar os ids novos na
   tabela.
6. **Parar de reenviar trocadas**: a faixa que voltou trocada num upload não
   deve entrar no próximo CSV, senão ela volta trocada toda semana. Guardar essa
   marca junto da tabela do item 2.

A cadência (bandas, `OBS_CADENCIA_*`) não muda: a playlist só barateia quem já
está na fila. Para medir tudo todo dia, `OBS_CADENCIA_MORNA=1`,
`OBS_CADENCIA_FRIA=1` e `OBS_ORCAMENTO_MEDICAO` acima do tamanho do catálogo
(o orçamento conta faixas, não requisições).

## 9. Arquivos e reprodução

Tudo em `/home/ubuntu/mirsui-playlists/`, fora de git:

| Arquivo | O que é |
|---|---|
| `teste-tunemymusic-200.csv` / `gabarito-teste-200.csv` | CSV enviado e gabarito (id, ISRC, rank) do teste 1 |
| `playlist-teste.json` | resposta de `/playlist/15782734641/tracks` |
| `comparar.py` / `resultado-teste-200.csv` | comparação faixa a faixa do teste 1 |
| `teste-tunemymusic-albuns-200.csv` / `gabarito-teste-albuns-200.csv` | teste 2 |
| `playlist-teste-albuns.json` | resposta de `/playlist/15782763741/tracks` |
| `comparar-albuns.py` / `resultado-teste-albuns-200.csv` | comparação do teste 2 |

`comparar.py` lê `DEEZER_GATEWAY_TOKEN` do `.env` do backend e mede as faixas
individuais pelo gateway. Para repetir com outra playlist, trocar o JSON e o
gabarito nas três primeiras referências de arquivo.

As playlists de teste (`15782734641` e `15782763741`) ficam públicas no perfil
do dono. Servem de base para a primeira rodada real depois da integração: 400
faixas com gabarito conhecido.

## Fontes

- [Deezer Content Limits](https://support.deezer.com/hc/en-gb/articles/115004522449-Deezer-Content-Limits) (atualizada em 16/06/2026)
- [TuneMyMusic — arquivo de texto para Deezer](https://www.tunemymusic.com/transfer/text-file-to-deezer)
- [TuneMyMusic — CSV para Deezer](https://www.tunemymusic.com/transfer/csv-to-deezer)
- [TuneMyMusic — FAQ](https://www.tunemymusic.com/help)
- [Soundiiz — preços](https://soundiiz.com/pricing)
- [Soundiiz — limites do plano grátis](https://support.soundiiz.com/hc/en-us/articles/360017513680-Soundiiz-Free-Plan-Limits-What-You-Can-Do-Without-Premium)
- [Tuneferry — limites do TuneMyMusic em 2026](https://tuneferry.com/blog/tunemymusic-free-limits-2026)
