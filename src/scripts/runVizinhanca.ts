// src/scripts/runVizinhanca.ts
// Roda só a etapa 6 do Observatório (a vizinhança dos artistas), na mão:
//
//   npx tsx src/scripts/runVizinhanca.ts 8
//
// O argumento é o número de lotes. Só SQL: não passa pelo gateway e não gasta
// nada do Deezer, então pode rodar a qualquer hora.

import { supabaseAdmin } from '../lib/supabase'
import { remontarVizinhanca } from '../jobs/artistNeighbors'

const lotes = Number(process.argv[2] ?? process.env.OBS_VIZINHANCA_LOTES ?? 8)
if (!supabaseAdmin) throw new Error('SUPABASE_SERVICE_ROLE_KEY não configurada')

const inicio = Date.now()
const r = await remontarVizinhanca(supabaseAdmin, lotes, {
  info: (o, m) => console.log(m ?? '', JSON.stringify(o)),
  error: (o, m) => console.error(m ?? '', o),
})
console.log(JSON.stringify({ ...r, segundos: Math.round((Date.now() - inicio) / 1000) }))
