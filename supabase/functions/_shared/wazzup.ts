export const WAZZUP_API_BASE = 'https://api.wazzup24.com/v3';

export function wazzupApiKey() {
  const key = Deno.env.get('WAZZUP_API_KEY');
  if (!key) throw new Error('WAZZUP_API_KEY is not configured');
  return key;
}

export async function wazzupFetch(path: string, init: RequestInit) {
  const response = await fetch(`${WAZZUP_API_BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${wazzupApiKey()}`,
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    throw new Error(data?.description || data?.error || `Wazzup API error ${response.status}`);
  }
  return data;
}

export function normalizeChatId(value: string | null | undefined) {
  return (value ?? '').replace(/\D/g, '');
}
