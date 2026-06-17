import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

export function adminClient() {
  const url = Deno.env.get('SUPABASE_URL');
  const serviceRole = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceRole) throw new Error('Supabase secrets are not configured');
  return createClient(url, serviceRole, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function bearerToken(req: Request) {
  const value = req.headers.get('Authorization') || '';
  return value.startsWith('Bearer ') ? value.slice(7).trim() : '';
}

export async function requireUser(req: Request) {
  const supabase = adminClient();
  const token = bearerToken(req);
  if (!token) throw new Response('Unauthorized', { status: 401 });
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) throw new Response('Unauthorized', { status: 401 });
  return { supabase, user: data.user };
}

export async function assertClinicAccess(supabase: ReturnType<typeof adminClient>, userId: string, clinicId: string) {
  const { data, error } = await supabase
    .from('user_roles')
    .select('clinic_id')
    .eq('user_id', userId)
    .eq('clinic_id', clinicId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Response('Forbidden', { status: 403 });
}
