const FB_API_BASE = 'https://graph.facebook.com/v18.0';

export async function fetchFacebookReport(
  accountId: string,
  accessToken: string,
  dateStart: string,
  dateEnd: string
) {
  const fields = ['impressions', 'clicks', 'actions', 'spend', 'ctr', 'cost_per_action_type'].join(',');
  const url = `${FB_API_BASE}/${accountId}/insights?fields=${fields}&time_range={"since":"${dateStart}","until":"${dateEnd}"}&access_token=${accessToken}`;
  const response = await fetch(url);
  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  const leads = data.data[0]?.actions?.find((a: any) => a.action_type === 'lead')?.value || 0;
  return {
    impressions: parseInt(data.data[0]?.impressions || '0'),
    clicks: parseInt(data.data[0]?.clicks || '0'),
    leads: parseInt(leads),
    spend: parseFloat(data.data[0]?.spend || '0'),
    ctr: parseFloat(data.data[0]?.ctr || '0'),
    cpl: parseInt(leads) > 0 ? parseFloat(data.data[0]?.spend || '0') / parseInt(leads) : 0,
  };
}

export async function fetchFacebookCampaigns(
  accountId: string,
  accessToken: string,
  dateStart: string,
  dateEnd: string
) {
  const fields = ['campaign_name', 'campaign_id', 'impressions', 'clicks', 'actions', 'spend', 'ctr'].join(',');
  const url = `${FB_API_BASE}/${accountId}/insights?fields=${fields}&level=campaign&time_range={"since":"${dateStart}","until":"${dateEnd}"}&access_token=${accessToken}`;
  const response = await fetch(url);
  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  return data.data || [];
}

export async function verifyFacebookAccount(accountId: string, accessToken: string) {
  const url = `${FB_API_BASE}/${accountId}?fields=name,account_status&access_token=${accessToken}`;
  const response = await fetch(url);
  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  return { name: data.name || accountId, status: data.account_status };
}

/* ── Lead Ads: fetch pages managed by the user token ── */
export async function fetchFacebookPages(accessToken: string): Promise<{ id: string; name: string; access_token: string }[]> {
  const url = `${FB_API_BASE}/me/accounts?fields=id,name,access_token&limit=50&access_token=${accessToken}`;
  const response = await fetch(url);
  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  return data.data || [];
}

/* ── Lead Ads: fetch lead gen forms for a page ── */
export async function fetchFacebookLeadForms(
  pageId: string,
  pageToken: string
): Promise<{ id: string; name: string; leads_count: number }[]> {
  const url = `${FB_API_BASE}/${pageId}/leadgen_forms?fields=id,name,leads_count&limit=50&access_token=${pageToken}`;
  const response = await fetch(url);
  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  return data.data || [];
}

/* ── Lead Ads: fetch leads from a form since a unix timestamp ── */
export async function fetchFacebookFormLeads(
  formId: string,
  pageToken: string,
  sinceTs?: number
): Promise<any[]> {
  let url = `${FB_API_BASE}/${formId}/leads?fields=id,created_time,field_data&limit=100&access_token=${pageToken}`;
  if (sinceTs) {
    url += `&filtering=${encodeURIComponent(JSON.stringify([{ field: 'time_created', operator: 'GREATER_THAN', value: sinceTs }]))}`;
  }
  const allLeads: any[] = [];
  let nextUrl: string | null = url;
  while (nextUrl) {
    const currentUrl: string = nextUrl;
    const response: Response = await fetch(currentUrl);
    const data: any = await response.json();
    if (data.error) throw new Error(data.error.message);
    allLeads.push(...(data.data || []));
    nextUrl = data.paging?.next ?? null;
    if (allLeads.length >= 500) break;
  }
  return allLeads;
}

/* ── Parse a raw Facebook lead into { name, phone, email } ── */
export function parseFacebookLead(raw: any): { name: string | null; phone: string | null; email: string | null } {
  const fields: Record<string, string> = {};
  for (const f of (raw.field_data || [])) {
    fields[String(f.name).toLowerCase()] = f.values?.[0] || '';
  }
  const name =
    fields['full_name'] ||
    [fields['first_name'], fields['last_name']].filter(Boolean).join(' ') ||
    null;
  const phone = fields['phone_number'] || fields['phone'] || null;
  const email = fields['email'] || null;
  return { name: name || null, phone: phone || null, email: email || null };
}
