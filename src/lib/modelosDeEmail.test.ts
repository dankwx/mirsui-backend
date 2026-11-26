import assert from 'node:assert/strict'
import test from 'node:test'
import { enderecoDaFaixa } from './enderecoDaFaixa'
import { emailDeSaltos, emailDeSeguidor, montarEmail, type NotificacaoParaEmail } from './modelosDeEmail'

const SITE = 'https://www.mirsui.com'

const base: NotificacaoParaEmail = {
  id: 1,
  tipo: 'seguidor',
  dados: {},
  tentativas: 1,
  email: 'b@exemplo.dev',
  token: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  destino_username: 'bia',
  ator_username: 'ana',
  ator_nome: 'Ana <Souza>',
  ator_avatar: 'https://db.mirsui.com/storage/v1/object/public/avatars/a.jpg',
  ator_bio: 'Garimpa "shoegaze" & dream pop',
  ator_faixas: 42,
}

test('seguidor: assunto pelo nome, perfil com origem, tudo escapado', () => {
  const e = emailDeSeguidor(base, SITE)!
  assert.equal(e.assunto, 'Ana <Souza> começou a te seguir')
  assert.equal(e.preferencia, 'seguidor')
  assert.match(e.html, /Ana &lt;Souza&gt; começou a te seguir/)
  assert.doesNotMatch(e.html, /<Souza>/)
  assert.match(e.html, /Garimpa &quot;shoegaze&quot; &amp; dream pop/)
  assert.match(e.html, /@ana · 42 faixas no acervo/)
  assert.match(e.html, /href="https:\/\/www\.mirsui\.com\/user\/ana\?utm_source=email&amp;utm_medium=aviso&amp;utm_campaign=seguidor"/)
  assert.match(e.html, /src="https:\/\/db\.mirsui\.com\/storage/)
  assert.match(e.html, /\/emails\?token=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/)
  assert.match(e.texto, /^Ana <Souza> começou a te seguir\n@ana · 42 faixas no acervo\nGarimpa/)
  assert.match(e.texto, /Ver perfil: https:\/\/www\.mirsui\.com\/user\/ana\?utm_source=email/)
})

test('seguidor sem nome, sem foto e sem faixas: o @ vira o nome e a inicial vira a foto', () => {
  const e = emailDeSeguidor(
    { ...base, ator_nome: null, ator_avatar: 'http://inseguro/a.jpg', ator_bio: '  ', ator_faixas: 0 },
    SITE
  )!
  assert.equal(e.assunto, '@ana começou a te seguir')
  assert.doesNotMatch(e.html, /inseguro/)
  assert.match(e.html, />A<\/td>/)
  assert.doesNotMatch(e.html, /no acervo/)
  assert.equal(e.texto.split('\n')[1], '')
})

test('seguidor sem username não vira e-mail', () => {
  assert.equal(emailDeSeguidor({ ...base, ator_username: null }, SITE), null)
})

const saltos = {
  total: 5,
  saltos: [
    { isrc: 'USUM72409273', titulo: 'Tuyo', artista: 'Rodrigo Amarante, Outro', capaMd5: '0123456789abcdef0123456789abcdef', antes: 9, agora: 19 },
    { isrc: 'GBAAA2400001', titulo: 'Nowhere <To> Go', artista: null, capaMd5: 'nao-e-md5', antes: 24, agora: 32 },
    { isrc: 'BRXXX2400002', titulo: 'Poison', artista: 'X', capaMd5: null, antes: 11, agora: 16 },
  ],
}

test('saltos: assunto com o maior, a curva de cada faixa e "e mais"', () => {
  const e = emailDeSaltos({ ...base, tipo: 'saltos_semana', dados: saltos }, SITE)!
  assert.equal(e.assunto, 'Tuyo subiu de 9 para 19 de audiência nesta semana')
  assert.equal(e.preferencia, 'saltos')
  assert.match(e.html, /5 faixas do seu acervo subiram nesta semana/)
  assert.match(
    e.html,
    /href="https:\/\/www\.mirsui\.com\/track\/rodrigo-amarante-tuyo-usum72409273\?utm_source=email&amp;utm_medium=aviso&amp;utm_campaign=saltos#observatorio-title"/
  )
  assert.match(e.html, /cdn-images\.dzcdn\.net\/images\/cover\/0123456789abcdef0123456789abcdef\/250x250/)
  assert.doesNotMatch(e.html, /nao-e-md5/)
  assert.match(e.html, /Nowhere &lt;To&gt; Go/)
  assert.match(e.html, /E mais 2 no seu acervo/)
  assert.match(e.html, /\/user\/bia\?utm_source=email/)
  assert.match(e.texto, /Tuyo · Rodrigo Amarante, Outro: 9 → 19\n/)
})

test('saltos: um só', () => {
  const e = emailDeSaltos(
    { ...base, tipo: 'saltos_semana', dados: { total: 1, saltos: [saltos.saltos[2]] } },
    SITE
  )!
  assert.match(e.html, /Uma faixa do seu acervo subiu nesta semana/)
  assert.doesNotMatch(e.html, /E mais/)
})

test('saltos vazios ou tipo desconhecido não viram e-mail', () => {
  assert.equal(emailDeSaltos({ ...base, tipo: 'saltos_semana', dados: { saltos: [] } }, SITE), null)
  assert.equal(emailDeSaltos({ ...base, tipo: 'saltos_semana', dados: null }, SITE), null)
  assert.equal(montarEmail({ ...base, tipo: 'outro' }, SITE), null)
})

test('endereço da faixa igual ao do site', () => {
  assert.equal(enderecoDaFaixa('USUM72409273', 'Rodrigo Amarante', 'Tuyo'), '/track/rodrigo-amarante-tuyo-usum72409273')
  assert.equal(enderecoDaFaixa('USUM72409273', 'Daft Punk, Julian Casablancas', 'Instant Crush'), '/track/daft-punk-instant-crush-usum72409273')
  assert.equal(enderecoDaFaixa('USUM72409273', '坂本龍一', '戦場'), '/track/usum72409273')
  assert.equal(enderecoDaFaixa('3135556', 'X', 'Y'), '/track/3135556')
})
