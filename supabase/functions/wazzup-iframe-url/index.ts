import { assertClinicAccess, requireUser } from '../_shared/auth.ts';
import { handleOptions, jsonResponse } from '../_shared/cors.ts';
import { normalizeChatId, wazzupFetch } from '../_shared/wazzup.ts';

Deno.serve(async req => {
  const options = handleOptions(req);
  if (options) return options;

  try {
    if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, { status: 405 });
    const { supabase, user } = await requireUser(req);
    const body = await req.json();
    const clinicId = String(body.clinicId || '');
    const chatType = String(body.chatType || 'whatsapp');
    const chatId = normalizeChatId(body.contactPhone || body.chatId);
    const contactName = String(body.contactName || chatId);
    const scope = body.scope === 'global' ? 'global' : 'card';

    if (!clinicId) return jsonResponse({ error: 'clinicId is required' }, { status: 400 });
    await assertClinicAccess(supabase, user.id, clinicId);

    if (scope === 'card' && !chatId) {
      return jsonResponse({ error: 'contactPhone/chatId is required' }, { status: 400 });
    }

    const payload: Record<string, unknown> = {
      user: {
        id: String(body.userId || user.id),
        name: body.userName || user.email || user.id,
      },
      scope,
      options: {
        useDealsEvents: true,
        useMessageEvents: true,
        clientType: 'Negis CRM',
      },
    };

    if (scope === 'card') {
      payload.filter = [{ chatType, chatId, name: contactName }];
      payload.activeChat = { chatType, chatId };
    }

    const data = await wazzupFetch('/iframe', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    const url = data?.url || data?.iframeUrl || data?.link;
    if (!url) return jsonResponse({ error: 'Wazzup iframe URL is missing', data }, { status: 502 });

    if (chatId) {
      await supabase
        .from('wz_contacts')
        .upsert({
          clinic_id: clinicId,
          chat_type: chatType,
          chat_id: chatId,
          name: contactName,
          crm_contact_id: body.leadId || null,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'clinic_id,chat_type,chat_id' });
    }

    return jsonResponse({ url });
  } catch (err) {
    if (err instanceof Response) return err;
    return jsonResponse({ error: err instanceof Error ? err.message : 'Unknown error' }, { status: 500 });
  }
});
