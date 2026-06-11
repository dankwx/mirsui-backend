import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'

dotenv.config()

const supabaseUrl = process.env.SUPABASE_URL
const supabaseKey = process.env.SUPABASE_KEY

if (!supabaseUrl || !supabaseKey) {
  throw new Error('SUPABASE_URL e SUPABASE_KEY são obrigatórias. Verifique seu arquivo .env')
}

export const supabase = createClient(supabaseUrl, supabaseKey)

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
