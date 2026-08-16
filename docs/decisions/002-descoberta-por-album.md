# ADR 002 — Descoberta por artista relacionado e álbum

- **Status:** aceita e implementada (código); migration 026 pendente de aplicação
- **Data:** 16 de agosto de 2026
- **Responsável:** Mirsui
- **Substitui parcialmente:** [ADR 001](001-descoberta-controlada-de-faixas.md) —
  o rádio continua existindo, com participação configurável

## Contexto

A descoberta do ADR 001 usa `GET /artist/{id}/radio`, o motor de recomendação da
Deezer. Quatro meses depois, duas propriedades dela conflitam com a tese do
produto ("achar antes de estourar"):

**1. Ela traz o que já é popular.** Medição de 16/08/2026 contra a API ao vivo:

| Fonte | rank mediana | rank p90 |
|---|---|---|
| `chart/0` top 100 | 865.789 | — |
| `chart/132` posições 200–300 | 795.974 | — |
| `radio` (ADR 001) | 447.301 | **607.033** |
| `related → album` | **38.978** | 144.526 |

O p90 é o número que decide: um décimo do que a descoberta traz hoje está acima
de rank 607.033, e o **piso** do chart é 721.380. A cauda do rádio encosta no
chart.

**2. Ela não traz ISRC.** `radioDoArtista` grava `isrc: null` de propósito, porque
o endpoint não devolve o campo. Desde a migration 023 o ISRC é o endereço da
página da faixa, então **toda** faixa descoberta hoje nasce sem página e cai na
fila da etapa 4 do snapshot, custando uma segunda requisição depois. O custo real
por faixa útil do rádio é ~2 requisições, não 1.

Havia também a hipótese de sondar **ids aleatórios** do Deezer. Foi medida e
rejeitada: a taxa de acerto vai de 64% (ids 0–100M, mas rank médio 8.899 — acervo
morto) a 0% (acima de 2,4B), com ~16% na média útil, o que dá **~6.000
requisições por 1.000 faixas**. Além do custo, rank ~13.000 não é "obscura
prestes a estourar", é ruído sem probabilidade de movimento.

## Decisão

Adicionar uma segunda fonte de descoberta, em três pernas:

1. `GET /artist/{id}/related` — 20 artistas, **com `nb_fan`**
2. `GET /artist/{id}/albums` — discografia inteira numa requisição, paginável
3. `GET /album/{id}/tracks` — 8–14 faixas **com rank e ISRC**

O que torna este caminho utilizável e o rádio não é o `nb_fan`: ele vem de graça
na resposta do `/related` e permite **escolher** o quão obscuro é o próximo
salto, em vez de aceitar o que o motor de recomendação achar melhor — que é
sempre o mais popular. A fila da fronteira é ordenada por `nb_fan` crescente.

As duas fontes convivem, com o corte em `OBS_DESCOBERTA_SPLIT_ALBUM` (padrão
0,7). Isso **não é meio-termo por indecisão**: é que ninguém sabe de que faixa de
rank sai a faixa que estoura. Se o salto típico for 400k → 900k, o rádio está
mirando certo e a caminhada erra o alvo; se for 39k → 400k, o contrário. Como
`origin_list` já guarda a procedência (`album:N` contra `radio:N`) e a 025 já
guarda `prev_rank`, em ~60 dias `select * from discovery_source_report()` responde
qual fonte produziu faixa que de fato se mexeu — e aí o corte vira decisão medida.

### O que a medição impôs ao desenho

`GET /artist/58732/related` (artista pequeno) devolve **zero** artistas. **O grafo
seca na ponta obscura.** A caminhada não pode afundar sozinha em profundidade,
saltando de obscuro em obscuro: ela precisa ser re-semeada do catálogo. Por isso
a fronteira guarda `depth` mas o job trabalha a um salto. É limitação da fonte,
não escolha de desenho.

### Limites

| Parâmetro | Padrão | Papel |
|---|---|---|
| `OBS_DESCOBERTA_SPLIT_ALBUM` | 0,7 | fração do orçamento para a caminhada |
| `OBS_DESCOBERTA_MAX_FAS` | 50.000 | teto de fãs — o dial de obscuridade |
| `OBS_DESCOBERTA_RELACIONADOS` | 3 | artistas que cada semente contribui |
| `OBS_DESCOBERTA_FRONTEIRA_MIN` | 50 | abaixo disto a fronteira é reabastecida |
| `OBS_DESCOBERTA_ALBUNS_POR_ARTISTA` | 6 | álbuns por artista por noite |

`OBS_DESCOBERTA_SPLIT_ALBUM=0` volta exatamente ao comportamento do ADR 001, sem
apagar nada. O orçamento total continua sendo `OBS_LIMITE_DESCOBERTA`, e o teto
absoluto continua sendo `OBS_MAX_CATALOGO`.

## Algoritmo

1. Calcular o orçamento da noite (inalterado, `calcularOrcamentoDescoberta`).
2. Dividir: `albumAlvo = round(orçamento × split)`; o rádio recebe **o resto** —
   não uma segunda multiplicação, para a soma fechar sempre.
3. **Reabastecer a fronteira**, só se ela estiver abaixo do mínimo: ler sementes
   do catálogo, uma chamada `/related` por artista, filtrar por `nb_fan ≤ maxFas`,
   pegar os menos populares. Gravado **antes** da colheita, para os artistas
   novos já entrarem na fila da mesma noite.
4. **Colher**: do mais obscuro para o menos, `/artist/{id}/albums` a partir de
   `next_album_index`, pular `record_type = 'compilation'`, e uma chamada
   `/album/{id}/tracks` por álbum restante. Para quando o alvo de faixas novas é
   atingido ou o teto de requisições estoura.
5. Gravar numa transação: faixas, histórico, linhagem, marca das sementes,
   artistas novos e progresso da discografia.
6. Rodar o rádio (ADR 001, inalterado) com o resto do orçamento.

O conjunto `conhecidas` é compartilhado pelas duas fontes: uma faixa que a
caminhada acabou de trazer não pode ser contada de novo pelo rádio.

**A sobra da caminhada volta para o rádio.** Se ela falha inteira (a migration
ainda não aplicada, o Deezer fora do ar) ou apenas não acha o que colher
(fronteira vazia), o orçamento não gasto é somado ao alvo do rádio. Sem isso, o
deploy do código antes da migration perderia 70% da descoberta toda noite, e o
único sinal seria uma linha de erro no meio do log. **O orçamento é do
Observatório, não de um mecanismo** — e isso torna a ordem entre deploy e
migration indiferente.

## Banco e segurança

A migration `026_descoberta_por_album.sql` adiciona:

- tabela `discovery_artists` — a fronteira, com `nb_fan`, linhagem,
  `next_album_index` (progresso parcial) e `exhausted`;
- índice parcial da fila (`not exhausted`, ordenado por `nb_fan`);
- RPCs `discovery_artist_queue(integer)` e `discovery_frontier_size()`;
- RPC `record_album_expansion(jsonb, text[], jsonb, jsonb)` — a gravação atômica;
- RPC `discovery_source_report()` — a query do experimento.

Todas com execução revogada de `public`, `anon` e `authenticated`, concedida
somente à `service_role`, no mesmo padrão da 20260815041317 e da 025. A migration
é **puramente aditiva**: não altera nem remove nada existente.

## Consequências

- Faixa descoberta pela caminhada nasce **com ISRC**, portanto com página, e a
  etapa 4 do snapshot não paga nada por ela. É o ganho que paga a mudança.
- A caminhada devolve o álbum inteiro, então `faixas colhidas` é sempre maior que
  `faixas novas` — parte já está no catálogo. Os dois números vão no log
  separados de propósito.
- **O catálogo fica mais obscuro de propósito**, e isso tem custo: o p10 medido é
  rank 7.803, ou seja ~10% do que entra está morto o bastante para nunca se
  mexer. Ele esfria para a banda fria em 30 dias e passa a custar ~26 medições
  por ano, não zero.
- **Viés para artista com discografia.** Artista novo de single único é pouco
  alcançado. Mitigado em parte por os álbuns virem em ordem de lançamento
  (mais recente primeiro), mas não resolvido.
- **Risco de colapso de vizinhança:** caminhar sempre pelo vizinho menos popular
  afunda na mesma cena. `discovery_artists.parent_artist_id` e `depth` existem
  para isso ser detectável antes de virar problema.

## Alternativas rejeitadas

- **Substituir o rádio em vez de conviver:** trocaria um chute por outro sobre de
  que rank sai a faixa que estoura, e destruiria a possibilidade de comparar.
- **Sondagem de id aleatório:** ~6.000 requisições por 1.000 faixas, e o que traz
  é ruído (rank mediano ~13.000), não obscuridade com chance de movimento.
- **Caminhada em profundidade (N saltos):** `/related` devolve zero para artista
  pequeno. A fonte não sustenta.
- **`/artist/{id}/top` para colher:** não traz ISRC (§4.5 da análise de escala),
  o que anula o principal ganho, e traz o topo do artista — o oposto de obscuro.
- **Tabela de álbuns colhidos:** a chave primária `deezer_track_id` já protege
  contra duplicata, então re-colher um álbum custa uma requisição, não
  correção. `next_album_index` por artista resolve o caso comum sem uma segunda
  tabela que só cresce.
