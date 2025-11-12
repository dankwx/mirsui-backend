import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'

// Carrega variáveis de ambiente
dotenv.config()

const supabaseUrl = process.env.SUPABASE_URL!
const supabaseKey = process.env.SUPABASE_KEY!

// Cria e exporta o cliente Supabase
export const supabase = createClient(supabaseUrl, supabaseKey)

// Interface para o tipo Profile
export interface Profile {
  id: string
  email: string | null
  username: string | null
  description: string | null
  display_name: string | null
  avatar_url: string | null
  rating: number
  points: number
  prophet_points: number | null
}
