-- 027_isrc_das_orfas_do_acervo.sql
-- Dá identidade aos três saves que a ponte textual nunca ligou ao Observatório.
--
-- O PROBLEMA
-- A etapa 2 do job (acervo → Observatório) casava por `"<artista> <título>"` na
-- busca do Deezer, e o Deezer normaliza o texto na gravação. Medido em
-- 16/08/2026, 3 das 36 gravações do acervo (8,3%) não casavam por ISRC nem por
-- texto — e não por serem exóticas: são exatamente as categorias que
-- docs/plano-de-urls-e-seo.md §2 já tinha medido como grandes (1.208 títulos com
-- marcador de versão, 210 com participação, 3 sem ASCII).
--
-- O `isrc` das três é null porque a coluna nasceu na migration 023 e o backfill
-- de lá só alcançava quem o Observatório já conhecia pelo id do Spotify. Ou
-- seja: as órfãs são justamente as que aquele backfill não podia alcançar, e a
-- correção da etapa 2 (casar por ISRC) também não as alcança sozinha, porque não
-- há ISRC para casar. Precisam desta resolução avulsa, uma vez.
--
-- "ÓRFÃ" NÃO QUER DIZER "NÃO MEDIDA" — SÃO TRÊS ESTADOS DIFERENTES
-- Ao conferir uma a uma no Deezer, o que parecia um problema só era três:
--
--   Bladee — FUN FACT (feat. Yung Lean)     álbum salvo: Cold Visions
--     JÁ ESTÁ no Observatório: deezer 3187013171, isrc QM6MZ2475254, título
--     'FUN FACT', source_list 'acervo', ativa e medida todo dia. A ponte
--     resolveu esta certo. O que nunca existiu foi a LIGAÇÃO com o save: o
--     Spotify põe a participação no título e o Deezer põe em contributors, então
--     'fun fact (feat. yung lean)' nunca bateu com 'fun fact' e, sem isrc no
--     acervo, não havia outro caminho. Consequência: o job re-buscava esta faixa
--     no Deezer TODA NOITE, e nada em `tracks` sabia que ela já era medida.
--
--   物語シリーズ — 白金ディスコ   álbum salvo: Utamonogatari Special Edition (Original Soundtrack)
--     Essa sim nunca entrou. É deezer 569780372, isrc JPE301201661, 'Platinum
--     Disco' de 'MONOGATARI Series', no MESMO álbum do save — o Deezer guarda a
--     faixa romanizada, e nenhuma busca pelo texto salvo, todo em japonês,
--     chegaria nela. Conferida pelo álbum, que é o dado que a busca ignora.
--
--   maxy4wyn — INSONAMIA - Slowed           álbum salvo: INSOMNIA
--     Não está no Observatório, e no lugar dela entrou OUTRA COISA: a linha
--     'Ronald Figo — INSONAMIA (Slowed)' (deezer 3938495701, isrc QZWFG2518722),
--     marcada como `acervo`, ativa, medida em 16/08/2026 08:00. É o primeiro
--     resultado que `/search` devolve para o texto do save — de outro artista.
--     O Deezer não tem esta gravação: as 25 faixas creditadas a maxy4wyn foram
--     listadas e não há INSONAMIA entre elas.
--
-- ESTA MIGRATION NÃO INVENTA ISRC PARA A TERCEIRA, DE PROPÓSITO
-- Ela fica com isrc null e continua fora do Observatório. É o resultado certo:
-- uma ponte que casa errado é pior que uma que não casa — a faixa salva continua
-- sem medição E o catálogo paga cadência eterna por uma gravação que ninguém
-- pediu. Se um dia o Deezer publicar a faixa, a etapa 2 a encontra sozinha.
--
-- A linha do 'Ronald Figo' fica onde está e é decisão à parte: é uma gravação
-- real, que o Observatório pode legitimamente medir, mas está classificada como
-- `acervo` afirmando que alguém a salvou, o que é falso. Não existe caminho de
-- despromoção — `promote_saved_observed_tracks()` é de mão única (ver 025).
--
-- O QUE ISTO DESTRAVA
-- Nenhuma linha de observed_tracks é inserida aqui. Com o ISRC no lugar, a etapa
-- 2 do próximo job faz o resto sozinha e de forma exata:
--
--   Bladee          o ISRC passa a bater com a linha que já existe -> sai da
--                   fila de pendentes e a re-busca noturna acaba
--   物語シリーズ      resolvida por /track/isrc: -> entra no Observatório
--
-- Medido: a fila de pendentes da etapa 2 cai de 11 gravações por noite para 2, e
-- depois da primeira rodada para 1 (a do maxy4wyn, que é honestamente
-- irresolvível). Das 11 de hoje, 8 já eram medidas e voltavam à busca todas as
-- noites só porque a comparação era textual.

update public.tracks
set isrc = 'QM6MZ2475254'
where track_uri = 'spotify:track:2TJIzpD5w4eQdXNFhdnfmv'
  and isrc is null;

update public.tracks
set isrc = 'JPE301201661'
where track_uri = 'spotify:track:5Yiwmn4PZAzVAms9UDICU2'
  and isrc is null;
