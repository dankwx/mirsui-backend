// Os e-mails de aviso: novo seguidor e o resumo semanal dos saltos.
//
// HTML de e-mail é HTML de 2005: tabela, estilo inline, nada de flex nem de
// variável CSS. Cores da paleta mostarda e fontes do site (DESIGN.md); quem não
// carrega a fonte do Google cai na Helvetica/Arial, que é o que o Gmail faz.
//
// Texto: a faixa é o assunto e o número mostra o feito, como no aviso do feed
// (components/Feed/SaltoDaSemana.tsx). Nada de texto que repete o que a tela
// já mostra.

import { enderecoDaFaixa } from './enderecoDaFaixa'

export interface NotificacaoParaEmail {
  id: number
  tipo: string
  dados: unknown
  tentativas: number
  email: string
  token: string
  destino_username: string | null
  ator_username: string | null
  ator_nome: string | null
  ator_avatar: string | null
  ator_bio: string | null
  ator_faixas: number | null
}

export interface EmailMontado {
  assunto: string
  html: string
  texto: string
  /** o tipo como a página de preferências e o descadastro conhecem */
  preferencia: 'seguidor' | 'saltos'
}

interface Salto {
  isrc: string
  titulo: string
  artista: string | null
  capaMd5: string | null
  antes: number
  agora: number
}

// A paleta mostarda do site (components/Club/ClubPalettes.module.css), com
// os color-mix já resolvidos: e-mail não tem variável CSS.
const COR = {
  fundo: '#fffdf1',
  faixa: '#f9d454',
  papel: '#ffffff',
  texto: '#2d230f',
  apoio: '#645c4a',
  linha: '#cfcbbd',
  acento: '#775500',
  acentoSuave: '#ebe4cd',
  sobreBotao: '#ffffff',
}

const FONTE = {
  titulo: "Archivo, 'Helvetica Neue', Helvetica, Arial, sans-serif",
  texto: "'Hanken Grotesk', 'Helvetica Neue', Helvetica, Arial, sans-serif",
  numero: "'Space Grotesk', 'Helvetica Neue', Helvetica, Arial, sans-serif",
}

export function escapar(texto: string | number | null | undefined): string {
  return String(texto ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function comOrigem(url: string, campanha: string): string {
  const [base, ancora] = url.split('#')
  const sep = base.includes('?') ? '&' : '?'
  return `${base}${sep}utm_source=email&utm_medium=aviso&utm_campaign=${campanha}${ancora ? `#${ancora}` : ''}`
}

export function linkDasPreferencias(site: string, token: string): string {
  return `${site}/emails?token=${encodeURIComponent(token)}`
}

/** O alvo do List-Unsubscribe de um clique (RFC 8058), que o Gmail mostra no topo. */
export function linkDeDescadastro(site: string, token: string, tipo: 'seguidor' | 'saltos'): string {
  return `${site}/api/emails/sair?token=${encodeURIComponent(token)}&tipo=${tipo}`
}

function capa(md5: string | null): string | null {
  return md5 && /^[0-9a-f]{32}$/i.test(md5)
    ? `https://cdn-images.dzcdn.net/images/cover/${md5}/250x250-000000-80-0-0.jpg`
    : null
}

function botao(href: string, rotulo: string): string {
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin-top:24px"><tr>
<td style="background:${COR.texto};border-radius:2px">
<a href="${escapar(href)}" style="display:inline-block;padding:13px 22px;font-family:${FONTE.texto};font-size:15px;font-weight:700;line-height:1;color:${COR.sobreBotao};text-decoration:none;border-radius:2px">${escapar(rotulo)}</a>
</td></tr></table>`
}

function moldura(opts: {
  site: string
  previa: string
  corpo: string
  preferencias: string
}): string {
  const { site, previa, corpo, preferencias } = opts
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@800&family=Hanken+Grotesk:wght@400;700&family=Space+Grotesk:wght@500;700&display=swap" rel="stylesheet">
<title>Mirsui</title>
</head>
<body style="margin:0;padding:0;background:${COR.fundo}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${escapar(previa)}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:${COR.fundo}">
<tr><td align="center" style="padding:32px 16px 40px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:520px">
<tr><td style="background:${COR.faixa};border-radius:4px 4px 0 0;padding:20px 28px">
<a href="${escapar(site)}" style="text-decoration:none"><img src="${escapar(site)}/email/mirsui.png" width="123" height="36" alt="mirsui" style="display:block;border:0"></a>
</td></tr>
<tr><td style="background:${COR.papel};border:1px solid ${COR.linha};border-top:0;border-radius:0 0 4px 4px;padding:28px 28px 30px;font-family:${FONTE.texto};color:${COR.texto}">
${corpo}
</td></tr>
<tr><td style="padding:18px 4px 0;font-family:${FONTE.texto};font-size:12px;line-height:1.5;color:${COR.apoio}">
<a href="${escapar(preferencias)}" style="color:${COR.apoio};text-decoration:underline">Parar estes avisos</a>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`
}

// ---------------------------------------------------------------------------
// Novo seguidor
// ---------------------------------------------------------------------------

function faixasNoAcervo(n: number | null): string | null {
  if (!n || n < 1) return null
  return `${n.toLocaleString('pt-BR')} ${n === 1 ? 'faixa' : 'faixas'} no acervo`
}

export function emailDeSeguidor(n: NotificacaoParaEmail, site: string): EmailMontado | null {
  const username = n.ator_username?.trim()
  if (!username) return null

  const arroba = `@${username}`
  const nome = n.ator_nome?.trim() || arroba
  const assunto = `${nome} começou a te seguir`
  const perfil = comOrigem(`${site}/user/${encodeURIComponent(username)}`, 'seguidor')
  const apoio = [nome === arroba ? null : arroba, faixasNoAcervo(n.ator_faixas)]
    .filter(Boolean)
    .join(' · ')
  const bio = (n.ator_bio ?? '').trim().replace(/\s+/g, ' ')
  const bioCurta = bio.length > 180 ? `${bio.slice(0, 179).trimEnd()}…` : bio
  const preferencias = linkDasPreferencias(site, n.token)

  const avatar =
    n.ator_avatar && /^https:\/\//.test(n.ator_avatar)
      ? `<img src="${escapar(n.ator_avatar)}" width="64" height="64" alt="" style="display:block;width:64px;height:64px;border-radius:50%;object-fit:cover;border:0">`
      : `<table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr><td width="64" height="64" align="center" valign="middle" style="width:64px;height:64px;border-radius:50%;background:${COR.acentoSuave};font-family:${FONTE.titulo};font-size:26px;font-weight:800;color:${COR.acento}">${escapar(nome.replace(/^@/, '').charAt(0).toUpperCase())}</td></tr></table>`

  const corpo = `<a href="${escapar(perfil)}" style="text-decoration:none">${avatar}</a>
<h1 style="margin:18px 0 0;font-family:${FONTE.titulo};font-size:24px;font-weight:800;line-height:1.15;letter-spacing:-0.03em;color:${COR.texto}">${escapar(nome)} começou a te seguir</h1>
${apoio ? `<p style="margin:6px 0 0;font-size:14px;line-height:1.5;color:${COR.apoio}">${escapar(apoio)}</p>` : ''}
${bioCurta ? `<p style="margin:14px 0 0;font-size:15px;line-height:1.55;color:${COR.texto}">${escapar(bioCurta)}</p>` : ''}
${botao(perfil, 'Ver perfil')}`

  const texto = [
    assunto,
    apoio || null,
    bioCurta || null,
    '',
    `Ver perfil: ${perfil}`,
    '',
    `Parar estes avisos: ${preferencias}`,
  ]
    .filter((l) => l !== null)
    .join('\n')

  return {
    assunto,
    html: moldura({ site, previa: apoio || assunto, corpo, preferencias }),
    texto,
    preferencia: 'seguidor',
  }
}

// ---------------------------------------------------------------------------
// Resumo semanal dos saltos
// ---------------------------------------------------------------------------

function lerSaltos(dados: unknown): { saltos: Salto[]; total: number } {
  const d = (dados ?? {}) as { saltos?: unknown; total?: unknown }
  const saltos = (Array.isArray(d.saltos) ? d.saltos : [])
    .map((s) => s as Partial<Salto>)
    .filter(
      (s): s is Salto =>
        typeof s.isrc === 'string' &&
        typeof s.titulo === 'string' &&
        Number.isFinite(s.antes) &&
        Number.isFinite(s.agora)
    )
  const total = Math.max(Number(d.total) || 0, saltos.length)
  return { saltos, total }
}

export function emailDeSaltos(n: NotificacaoParaEmail, site: string): EmailMontado | null {
  const { saltos, total } = lerSaltos(n.dados)
  if (saltos.length === 0) return null

  const maior = saltos[0]
  const assunto = `${maior.titulo} subiu de ${maior.antes} para ${maior.agora} de audiência nesta semana`
  const titulo =
    total === 1
      ? 'Uma faixa do seu acervo subiu nesta semana'
      : `${total} faixas do seu acervo subiram nesta semana`
  const preferencias = linkDasPreferencias(site, n.token)
  const href = (s: Salto) =>
    comOrigem(`${site}${enderecoDaFaixa(s.isrc, s.artista, s.titulo)}#observatorio-title`, 'saltos')

  const linhas = saltos
    .map((s, i) => {
      const img = capa(s.capaMd5)
      const borda = i === 0 ? '' : `border-top:1px solid ${COR.linha};`
      return `<tr>
<td width="56" valign="middle" style="${borda}padding:14px 14px 14px 0;width:56px">
<a href="${escapar(href(s))}" style="text-decoration:none">${
        img
          ? `<img src="${escapar(img)}" width="56" height="56" alt="" style="display:block;width:56px;height:56px;border-radius:3px;border:0">`
          : `<div style="width:56px;height:56px;border-radius:3px;background:${COR.linha}"></div>`
      }</a>
</td>
<td valign="middle" style="${borda}padding:14px 0">
<a href="${escapar(href(s))}" style="font-family:${FONTE.texto};font-size:15px;font-weight:700;line-height:1.3;color:${COR.texto};text-decoration:none">${escapar(s.titulo)}</a>
${s.artista ? `<div style="font-family:${FONTE.texto};font-size:13px;line-height:1.4;color:${COR.apoio};margin-top:2px">${escapar(s.artista)}</div>` : ''}
</td>
<td valign="middle" align="right" style="${borda}padding:14px 0 14px 12px;white-space:nowrap;font-family:${FONTE.numero};font-size:16px;font-weight:500;color:${COR.apoio}">
${escapar(s.antes)} → <span style="font-weight:700;color:${COR.acento}">${escapar(s.agora)}</span>
</td>
</tr>`
    })
    .join('\n')

  const resto = total - saltos.length
  const perfil = n.destino_username
    ? comOrigem(`${site}/user/${encodeURIComponent(n.destino_username)}`, 'saltos')
    : null
  const maisLinha =
    resto > 0
      ? `<p style="margin:6px 0 0;font-size:14px;line-height:1.5;color:${COR.apoio}">${
          perfil
            ? `<a href="${escapar(perfil)}" style="color:${COR.apoio};text-decoration:underline">E mais ${resto} no seu acervo</a>`
            : `E mais ${resto} no seu acervo`
        }</p>`
      : ''

  const corpo = `<h1 style="margin:0 0 6px;font-family:${FONTE.titulo};font-size:24px;font-weight:800;line-height:1.15;letter-spacing:-0.03em;color:${COR.texto}">${escapar(titulo)}</h1>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
${linhas}
</table>
${maisLinha}
${botao(href(maior), 'Ver a curva')}`

  const previa =
    saltos.length > 1
      ? saltos.map((s) => `${s.titulo} ${s.antes} → ${s.agora}`).join(' · ')
      : maior.artista ?? titulo

  const texto = [
    titulo,
    '',
    ...saltos.map(
      (s) => `${s.titulo}${s.artista ? ` · ${s.artista}` : ''}: ${s.antes} → ${s.agora}\n${href(s)}`
    ),
    ...(resto > 0 ? ['', `E mais ${resto} no seu acervo${perfil ? `: ${perfil}` : ''}`] : []),
    '',
    `Parar estes avisos: ${preferencias}`,
  ].join('\n')

  return {
    assunto,
    html: moldura({ site, previa, corpo, preferencias }),
    texto,
    preferencia: 'saltos',
  }
}

export function montarEmail(n: NotificacaoParaEmail, site: string): EmailMontado | null {
  if (n.tipo === 'seguidor') return emailDeSeguidor(n, site)
  if (n.tipo === 'saltos_semana') return emailDeSaltos(n, site)
  return null
}
