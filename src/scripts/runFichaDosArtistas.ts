// src/scripts/runFichaDosArtistas.ts
// Roda só a etapa 4c do Observatório (a ficha da página de artista), na mão:
//
//   npx tsx src/scripts/runFichaDosArtistas.ts 500
//
// São 3 requisições por artista. Passa pelo gateway na prioridade do
// catálogo, como a rodada, então não tira a vez do site. Não rode perto das
// 05:00: somaria à rodada.

import { supabaseAdmin } from '../lib/supabase'
import { preencherFichaDosArtistas } from '../jobs/artistDetails'
import { contadoresDeezer } from '../lib/deezerCatalog'

const limite = Number(process.argv[2] ?? 500)
const dias = Number(process.argv[3] ?? process.env.OBS_FICHA_ARTISTA_DIAS ?? 30)
if (!supabaseAdmin) throw new Error('SUPABASE_SERVICE_ROLE_KEY não configurada')

const inicio = Date.now()
const r = await preencherFichaDosArtistas(supabaseAdmin, limite, dias, {
  info: (o, m) => console.log(m ?? '', JSON.stringify(o)),
  error: (o, m) => console.error(m ?? '', o),
})
console.log(JSON.stringify({ ...r, deezer: contadoresDeezer(), segundos: Math.round((Date.now() - inicio) / 1000) }))
