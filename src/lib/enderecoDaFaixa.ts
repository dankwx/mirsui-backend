// O endereço da página de faixa no site, para os links dos e-mails.
//
// Cópia da regra de utils/slug.ts + utils/trackHref.ts do mirsui-web. O ISRC
// é a chave e fica sozinho no fim; o slug é decoração (a rota corrige com 308
// se ele divergir), então uma diferença entre as duas cópias custa um
// redirecionamento, não um link quebrado.

const MAXIMO = 60
const ISRC_RE = /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/

export function slugify(texto: string | null | undefined): string {
  const semAcento = (texto || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
  const bruto = semAcento.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (bruto.length <= MAXIMO) return bruto
  const cortado = bruto.slice(0, MAXIMO)
  const ultimoHifen = cortado.lastIndexOf('-')
  const fim = ultimoHifen > 0 ? cortado.slice(0, ultimoHifen) : cortado
  return fim.replace(/-+$/, '')
}

export function enderecoDaFaixa(
  isrc: string,
  artista?: string | null,
  titulo?: string | null
): string {
  if (!ISRC_RE.test(isrc.toUpperCase())) return `/track/${isrc}`
  const principal = (artista ?? '').split(',')[0]
  const slug = slugify(`${principal} ${titulo ?? ''}`)
  const id = isrc.toLowerCase()
  return slug ? `/track/${slug}-${id}` : `/track/${id}`
}
