# Propostas — 22/09/2026

Recomendações que saíram da análise de 22/09/2026 sobre medir o catálogo
inteiro todo dia, além das duas que já estão encaminhadas: a medição diária de
tudo (ligada em 22/09) e a [medição por playlist](medicao-por-playlist.md)
(integração marcada para 10/10). Em ordem de ganho, da maior para a menor.

## 1. Tirar os visitantes do site da cota do Deezer (maior ganho)

**A situação hoje:** o site e a medição dividem as mesmas ~3 requisições por
segundo do `mirsui-deezer-gateway`.

- A página de faixa (`carregarFaixaPorIsrc` em `utils/trackPageService.ts`)
  pede ao Deezer a faixa (`/track/isrc:X`, cache de 15 min) e o artista
  (`/artist/{id}`, cache de 24h). O gênero do álbum quase nunca é pedido, porque
  o gênero do banco tem precedência. Na prática, **2 chamadas por visita fora do
  cache**.
- A página de artista faz mais 3, e a busca faz 1 ou 2.
- A cota enche com ~1 página nova por segundo. Quando enche, a medição fica com
  só 1/7 da cota (rodízio 4:2:1 do gateway).

**Não é literalmente a cada visita, e o problema são os robôs.** Uma página que
muita gente abre fica no cache e custa pouco. Um robô (Google ou raspador)
visita 100 mil páginas diferentes, uma vez cada, e todas estão fora do cache. O
cache protege o que é popular, e robô percorre justamente o que não é.

**Há um segundo problema, que a medição diária deixa mais visível:** a página
mostra a popularidade do Deezer ao vivo (`popScore(doDeezer.rank)`), enquanto a
curva mostra a nossa medição do dia. Os dois números podem não bater na mesma
tela. Lendo do banco, ficam iguais.

### O que o Deezer ainda fornece que o banco não tem

Levantado em 22/09/2026 a partir do objeto que a página monta:

| Dado | Muda? | Como resolver sem chamada por visita |
|---|---|---|
| Título, artista, álbum, capa, gênero, ISRC | não | **já está no banco** (`observed_tracks`) |
| Popularidade | todo dia | **já está no banco** (a medição do dia) |
| Data de lançamento, duração, explícito, artistas participantes (feat.) | não | gravar **uma vez**. A rodada da noite já recebe esses campos nas respostas de álbum e de faixa, e hoje descarta. Custo: zero requisições a mais |
| Fãs do artista (`nb_fan`) | devagar | guardar por artista e atualizar de tempos em tempos, ou tirar da página |
| **Prévia de 30 segundos** | **o link expira** | **não dá para guardar**: o link é assinado com prazo, e um lido ~2h30 antes já estava vencido. Buscar só quando a pessoa aperta o play. Robô não aperta play |

### A proposta

1. **A rodada da noite passa a guardar os campos fixos** (data, duração,
   explícito, feat.) quando mede a faixa, sem requisição a mais.
2. **O botão de play chama uma rota nossa**, que pede a prévia ao Deezer
   naquele momento. Uma chamada por play de verdade, não por visita.
3. **A página de faixa lê só do banco** e fica em cache no próprio Next,
   renovada depois da rodada da noite. O robô recebe a página pronta, sem tocar
   no Deezer e quase sem tocar no Postgres.
4. **Faixa que não está no catálogo** (alguém achou pela busca) continua usando
   o Deezer, e pode entrar no catálogo nessa primeira visita. Assim a próxima
   visita já sai do banco.
5. **Busca:** procurar primeiro no próprio catálogo, com Postgres (`pg_trgm`), e
   só ir ao Deezer se não achar.
6. A página de artista pode seguir o mesmo caminho depois.

Ordem sugerida: 1 e 2 primeiro (pequenos); 3 depois, com prévia no worktree
antes de publicar, porque mexe na página de faixa.

**Resultado:** o custo no Deezer passa a depender de quantas pessoas apertam
play, não de quantas páginas os robôs visitam.

### O que se ganha

- **Escala:** é a mudança que responde ao "e se o site explodir". As playlists
  resolvem a medição; isto resolve os visitantes.
- **Velocidade:** a página deixa de esperar uma API externa. Hoje, sem cache,
  ela espera a resposta do Deezer, e sob carga essa espera chega a 8 segundos.
- **Confiabilidade:** quando o Deezer bloqueia, hoje partes da página somem. Os
  dados do banco não somem.
- **Consistência:** a popularidade da página e a da curva passam a ser o mesmo
  número.

Pontos de entrada no frontend: `utils/trackPageService.ts`,
`utils/artistPageService.ts` e `app/api/search/route.ts`, todos passando por
`utils/deezerService.ts`.

### Revisão e implementação (22/09/2026)

Conferido contra respostas reais do Deezer e contra o dump de 03/09 antes de
implementar. O diagnóstico se sustenta; três premissas não:

- **"Custo zero" vale para duração, explícito e prévia, não para data e
  feat.** `/album/{id}/tracks`, que mede ~73% do catálogo, não traz
  `release_date` nem `contributors`. Só `/track/{id}` traz.
- **"Gênero já está no banco" vale só para o que veio de chart.** No dump,
  74% das faixas ativas estavam sem gênero (descoberta e rádio). A página
  cobria isso pedindo `/album/{id}` na visita, e o documento contava esse
  caso como raro.
- **Cache da página inteira no Next (passo 3) não cabe.** A página lê o
  cookie (quem está olhando, "Você salvou") e a lista de quem salvou tem que
  aparecer na hora. Fica dinâmica, com uma consulta ao nosso Postgres por
  visita (a RPC de sempre), e isso não é problema desde a VPS. O ganho que
  importa, zero Deezer, vem inteiro.

Implementado e **publicado em 22/09/2026, ~20:40** (backend 7067805 e
30b26e3, site ab053ce, os dois na `main` e no GitHub):

1. **Migration 037.** Colunas `duration_seconds`, `explicit_lyrics`,
   `has_preview`, `release_date`, `contributors` em `observed_tracks`,
   gravadas por `record_observations` a partir de toda resposta que a rodada
   já recebe. O que um endpoint não traz não apaga o que outro trouxe.
2. **Gênero e data.** A descoberta por álbum passa a gravá-los a partir da
   discografia (`genre_id`, `release_date`), de graça. A etapa nova 4b pede
   `/album/{id}` uma vez por álbum pendente, com teto
   `OBS_LIMITE_FICHA_ALBUM` (5.000 por noite). É uma varredura única, de
   ~1 semana; depois a fila fica no que chega por rádio e chart.
3. **Página de faixa do catálogo sai só do banco.** Zero chamadas ao gateway
   por visita (medido na prévia). A popularidade é a do dia, a mesma da curva.
   A linha "fãs no Deezer" saiu, junto com a chamada a `/artist/{id}`.
4. **Prévia no play.** `/api/previa/{id do Deezer}` redireciona para o MP3 no
   clique; a forma de onda é medida depois do play. Por id, e não por ISRC,
   porque o mesmo ISRC pode ser outra versão no Deezer.
5. **Faixa fora do catálogo** continua no Deezer (faixa + gênero do álbum).
   **Não** entra no catálogo na visita: o site não tem service role, o
   catálogo tem curadoria (blacklist, descoberta), e o que alguém salva já
   entra na rodada seguinte.

Adiado, com motivo:

- **Busca no próprio catálogo (passo 5).** A busca é `/api/`, bloqueada no
  robots, e só gente digitando a usa. O custo dela já é "por pessoa", que é o
  objetivo. Vale fazer quando a busca pesar, não antes.
- **Página de artista (passo 6).** É a próxima, e é problema de robô também:
  3 chamadas por visita fora do cache. Deve precisar guardar dados por
  artista (foto, fãs, discografia); fica para depois de a 037 rodar.
- **Participações (feat.) para o que é medido por álbum.** Só `/track/{id}`
  traz. Sem elas a página mostra o artista principal, e o Deezer costuma pôr
  o "(feat. X)" no título.

Como foi publicado:

- **037 aplicada na produção às 20:30.** Antes, as definições de
  `record_observations` e `get_track_page` foram salvas em
  `~/backups/037-antes-20260922-2028/` (reaplicar esses arquivos desfaz as
  funções; as colunas novas podem ficar).
- **A produção estava pior que o dump:** 95.220 de 100.648 faixas ativas sem
  gênero, em 35.348 álbuns pendentes. A 5.000 por noite seriam 7 noites, então
  rodou uma leva avulsa de 5.000 na mesma noite
  (`npx tsx src/scripts/runFichaDosAlbuns.ts 5000`, log em
  `ficha-dos-albuns-20260922.log`). Resultado: 5.000 álbuns em 30 min, 63.123
  faixas, zero erros do Deezer. Gênero foi de 5% para **55%** das faixas
  ativas, e data para **63%**. Ficaram 30.328 álbuns na fila, quase todos de
  uma faixa só; a rodada consome 5.000 por noite.
- **Backend reiniciado às 20:30**, longe da rodada das 05:00. A rodada de 23/09
  é a primeira com a etapa 4b: ~5.000 requisições a mais sobre as ~41 mil da
  medição diária. No log, `Observatório: gênero e data dos álbuns preenchidos`
  mostra fila, consultados e faixas.
- **Site publicado às 20:36.** Conferido em produção: páginas do catálogo com
  zero chamadas ao gateway (~30 ms cada), a prévia toca por `www.mirsui.com`,
  e nada é pedido antes do play.
- **Até a rodada de 23/09, as páginas saem sem duração e sem "explícito".** Esses
  campos só chegam na medição da noite, que agora mede todo o catálogo todo
  dia. A data chega pela ficha dos álbuns ou pela medição por `/track`.

## 2. Acompanhar a primeira rodada com tudo diário (23/09)

É barato e evita surpresa. Nunca rodamos mais de ~27 mil requisições por dia, e
em 23/09 serão ~41 mil, subindo a cada noite. Vale olhar três números no log
(`Observatório: rodada concluída`):

- `http.403` e `bloqueios`: dizem se o Deezer reclamou do volume.
- a duração da rodada (`segundos`);
- `adiadas`, que deve vir 0.

Se aparecer onda de 403, a gente descobre o limite de volume por dia antes do
fim de outubro, e não no meio dele.

## 3. Last.fm como segunda métrica, só para as músicas que importam

O `track.getInfo` do Last.fm devolve o total de plays acumulado da faixa. A
diferença de um dia para o outro é **o número de scrobbles do dia**, o mesmo
número que aparece nas páginas deles. É a única forma de ter algo parecido com
"plays por dia", porque o rank do Deezer não é um contador.

- É grátis, com chave, mas custa uma requisição por faixa.
- Vale para as faixas que alguém salvou ou fichou, e talvez as quentes que
  estão subindo. **Não** para o catálogo inteiro: ele é obscuro de propósito, e
  a maioria viria com 0.
- Também protege contra depender de uma fonte só: se o Deezer mudar a fórmula
  do rank, hoje toda a série histórica perde o sentido sem a gente perceber.

## 4. Manutenção do banco, só quando o catálogo passar de ~500 mil

Com tudo diário, a tabela `observed_tracks` recebe uma atualização por faixa por
dia. Com 100 mil faixas o autovacuum dá conta. Com 500 mil ou mais, vale
ajustar o autovacuum e o `fillfactor` para a tabela não inchar. O histórico em
si não preocupa: ~1 a 3 GB por ano, e há 88 GB livres.

## O que não é recomendado

- **Usar vários IPs para multiplicar a cota do Deezer.** É contornar o limite
  deles: viola os termos e quebra sem aviso.
- **A API interna do player web para montar as playlists.** Pelo mesmo motivo,
  e o risco cai na conta do dono.
