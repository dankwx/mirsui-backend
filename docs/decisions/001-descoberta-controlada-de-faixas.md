# ADR 001 — Descoberta controlada de faixas semelhantes

- **Status:** aceita e implementada
- **Data:** 15 de agosto de 2026
- **Responsável:** Mirsui

## Contexto

O Observatório tinha 3.302 faixas ativas, vindas principalmente dos charts do
Deezer, e 17.839 pontos históricos. O pedido foi usar cada faixa existente para
encontrar uma nova faixa semelhante, inicialmente duplicando o catálogo e
continuando a descoberta nas rodadas seguintes.

Aplicar literalmente “uma nova para cada faixa em toda rodada” produziria
crescimento exponencial: 3.302, 6.604, 13.208 e 26.416. Depois de sete rodadas
seriam mais de 422 mil faixas, além de um ponto histórico por faixa por dia.

O Spotify não é uma fonte viável para esta função no app atual. Os endpoints de
recomendações, artistas relacionados e top tracks estão restritos ou removidos
no Development Mode. A credencial atual respondeu `403` para related artists e
top tracks.

## Decisão

Usar `GET /artist/{id}/radio` da API pública do Deezer. O rádio mistura faixas
do mesmo artista e de artistas relacionados e já devolve `rank`, capa, álbum e
identificadores necessários para criar o primeiro ponto do Observatório.

Essa é uma semelhança editorial/algorítmica por artista, não uma comparação
acústica faixa a faixa. Ela atende tanto “música semelhante” quanto o fallback
“outra música do mesmo artista” em uma única fonte.

Em uma amostra de 40 artistas do catálogo antes da implementação, 39 (98%)
trouxeram pelo menos uma candidata ainda desconhecida. Das 39 escolhidas, 34
eram do mesmo artista e 5 de artistas relacionados.

### Limites

| Fase | Regra padrão |
|---|---|
| Expansão inicial | crescer até 6.604 faixas ativas |
| Regime contínuo | no máximo 250 novas faixas por dia |
| Proteção absoluta | parar em 10.000 faixas ativas |

Os valores são configuráveis por `OBS_DESCOBERTA_META_INICIAL`,
`OBS_LIMITE_DESCOBERTA` e `OBS_MAX_CATALOGO`. A etapa inteira pode ser desligada
imediatamente com `OBS_DESCOBERTA_ATIVA=false`, sem apagar nenhuma faixa ou
histórico.

## Algoritmo

1. Calcular o orçamento da rodada usando catálogo atual, meta inicial, limite
   diário e teto absoluto.
2. Ler somente sementes ativas com `recommendation_checked_at is null`, das
   mais antigas para as mais novas.
3. Agrupar sementes por `deezer_artist_id` para fazer uma chamada de rádio por
   artista, não uma chamada por faixa.
4. Reservar globalmente no máximo uma candidata inédita para cada semente. A
   chave primária `deezer_track_id` continua sendo a proteção final contra
   duplicatas.
5. Em uma RPC transacional, inserir catálogo e primeiro ponto histórico,
   registrar `recommendation_parent_track_id` e marcar as sementes processadas.
6. Se a chamada ao Deezer falhar por rede ou quota, não marcar a semente; ela
   volta à fila no dia seguinte. Uma resposta válida sem candidata inédita é
   marcada para não ocupar a fila para sempre.

As novas faixas entram na última etapa do cron. Por isso o ISRC e a ponte para
o Spotify são resolvidos no snapshot seguinte, evitando multiplicar todas as
chamadas caras durante a expansão inicial.

## Banco e segurança

A migration `20260815041317_similar_track_discovery.sql` adiciona:

- `recommendation_checked_at` para idempotência por semente;
- `recommendation_parent_track_id` para linhagem;
- índice parcial da fila pendente e índice da chave estrangeira;
- RPC `record_recommendation_expansion(jsonb, text[])`.

A RPC usa `security invoker`, qualifica objetos com o schema `public`, tem
execução revogada de `public`, `anon` e `authenticated`, e é concedida somente
à `service_role`.

## Consequências

- A expansão inicial acrescenta aproximadamente 3.302 faixas, mas o total exato
  depende de duplicatas, catálogo disponível e falhas transitórias.
- Depois da meta inicial, o crescimento deixa de ser exponencial e passa a ser
  linear.
- No teto de 10 mil faixas, o histórico pode crescer cerca de 3,65 milhões de
  linhas por ano. Índices e armazenamento devem ser acompanhados antes de
  aumentar esse teto.
- Desligar a descoberta não interrompe a medição das faixas já incorporadas.

## Alternativas rejeitadas

- **Uma nova por faixa em toda rodada, sem teto:** crescimento exponencial.
- **Spotify Recommendations/Related Artists:** indisponível para a credencial e
  o modo atuais.
- **Somente top tracks do mesmo artista:** cobertura menor e mais duplicatas,
  especialmente para artistas que já aparecem muitas vezes nos charts.
- **Sem marca de processamento:** repetiria chamadas e faria sementes sem
  candidatas bloquearem o avanço da fila.
