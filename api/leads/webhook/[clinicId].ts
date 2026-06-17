import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const { clinicId } = req.query
  const { full_name, phone, email, source } = req.body

  if (!clinicId || !phone) {
    return res.status(400).json({ error: 'clinic_id and phone are required' })
  }

  const { data, error } = await supabase
    .from('leads')
    .insert({
      clinic_id: clinicId,
      full_name: full_name || null,
      phone: phone,
      email: email || null,
      source: source || 'webhook',
      phone_normalized: phone.replace(/\D/g, '')
    })
    .select()
    .single()

  if (error) {
    return res.status(500).json({ error: error.message })
  }

  return res.status(200).json({ success: true, lead: data })
}
