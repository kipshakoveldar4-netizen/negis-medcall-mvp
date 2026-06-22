import { createClient } from '@supabase/supabase-js'

const env = import.meta.env as Record<string, string | undefined>
const configuredSupabaseUrl = env.VITE_SUPABASE_URL
const configuredSupabaseAnonKey = env.VITE_SUPABASE_ANON_KEY || env.SUPABASE_ANON_KEY
const supabaseUrl = configuredSupabaseUrl || 'https://placeholder.supabase.co'
const supabaseAnonKey = configuredSupabaseAnonKey || 'placeholder'

export const supabase = createClient(supabaseUrl, supabaseAnonKey)
export const hasSupabaseFrontendEnv = Boolean(configuredSupabaseUrl && configuredSupabaseAnonKey)
