// src/scripts/runFichaDosAlbuns.ts
// Roda só a etapa 4b do Observatório (gênero e data dos álbuns), na mão:
//
//   npx tsx src/scripts/runFichaDosAlbuns.ts 5000
//
// Existe para adiantar a varredura inicial da migration 037 sem esperar as
// noites. Passa pelo gateway na prioridade do catálogo, como a rodada, então
// não tira a vez do site. Não rode perto das 05:00: somaria à rodada.

import { supabaseAdmin } from '../lib/supabase'
import { preencherFichaDosAlbuns } from '../jobs/albumDetails'
import { contadoresDeezer } from '../lib/deezerCatalog'

const limite = Number(process.argv[2] ?? 5000)
if (!supabaseAdmin) throw new Error('SUPABASE_SERVICE_ROLE_KEY não configurada')

const inicio = Date.now()
const r = await preencherFichaDosAlbuns(supabaseAdmin, limite, {
  info: (o, m) => console.log(m ?? '', JSON.stringify(o)),
  error: (o, m) => console.error(m ?? '', o),
})
console.log(JSON.stringify({ ...r, deezer: contadoresDeezer(), segundos: Math.round((Date.now() - inicio) / 1000) }))
