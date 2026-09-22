# Propostas — 22/09/2026

Recomendações que saíram da análise de 22/09/2026 sobre medir o catálogo
inteiro todo dia, além das duas que já estão encaminhadas: a medição diária de
tudo (ligada em 22/09) e a [medição por playlist](medicao-por-playlist.md)
(integração marcada para 10/10). Em ordem de ganho, da maior para a menor.

## 1. Tirar os visitantes do site da cota do Deezer (maior ganho)

**A situação hoje:** o site e a medição dividem as mesmas ~3 requisições por
segundo do `mirsui-deezer-gateway`.

- A página de faixa faz até 3 chamadas ao Deezer: a faixa (cache de 15 min), o
  gênero do álbum e o artista.
- A página de artista faz mais 3, e a busca faz 1 ou 2.
- A cota enche com ~1 página nova por segundo. Um robô do Google percorrendo
  100 mil páginas de faixa já chega nisso.
- Quando enche, a medição fica com só 1/7 da cota (rodízio 4:2:1 do gateway).

**A proposta:**

- **Montar a página de faixa com o que já está no banco.** A tabela
  `observed_tracks` já tem título, artista, álbum, capa, ISRC e gênero.
- **Chamar o Deezer só para a prévia de 30 segundos, e só quando a pessoa
  aperta o play.**
- **Busca:** procurar primeiro no próprio catálogo, com Postgres (`pg_trgm`), e
  só ir ao Deezer se não achar.

**O que se ganha:**

- **Escala:** é a mudança que responde ao "e se o site explodir". As playlists
  resolvem a medição; isto resolve os visitantes.
- **Velocidade:** a página deixa de esperar uma API externa. Hoje, sem cache,
  ela espera a resposta do Deezer, e sob carga essa espera chega a 8 segundos.
- **Confiabilidade:** quando o Deezer bloqueia, hoje partes da página somem. Os
  dados do banco não somem.

Antes de mexer, é preciso levantar exatamente que dados a página usa do
Deezer, como os fãs do artista, para ver o que o banco já cobre. Os pontos de
entrada no frontend são `utils/trackPageService.ts`, `utils/artistPageService.ts`
e `app/api/search/route.ts`, todos passando por `utils/deezerService.ts`.

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
