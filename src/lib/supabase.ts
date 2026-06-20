import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'

dotenv.config()

const supabaseUrl = process.env.SUPABASE_URL
const supabaseKey = process.env.SUPABASE_KEY

if (!supabaseUrl || !supabaseKey) {
  throw new Error('SUPABASE_URL e SUPABASE_KEY são obrigatórias. Verifique seu arquivo .env')
}

export const supabase = createClient(supabaseUrl, supabaseKey)

/**
 * Cliente com o token do usuário anexado: as queries rodam como o papel
 * `authenticated` e o RLS enxerga o auth.uid() correto.
 * Use para toda escrita (e leitura de dados próprios) em rotas autenticadas.
 */
export function supabaseForUser(accessToken: string) {
  return createClient(supabaseUrl as string, supabaseKey as string, {
    global: {
      headers: { Authorization: `Bearer ${accessToken}` }
    },
    auth: { persistSession: false, autoRefreshToken: false }
  })
}

export interface Profile {
  id: string
  email: string | null
  username: string | null
  description: string | null
  display_name: string | null
  avatar_url: string | null
  rating: number
}
