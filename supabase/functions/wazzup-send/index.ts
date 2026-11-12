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
    const channelId = String(body.channelId || '');
    const chatType = String(body.chatType || 'whatsapp');
    const chatId = normalizeChatId(body.chatId);
    const text = String(body.text || '').trim();

    if (!clinicId || !channelId || !chatId || !text) {
      return jsonResponse({ error: 'clinicId, channelId, chatId and text are required' }, { status: 400 });
    }
    await assertClinicAccess(supabase, user.id, clinicId);

    const crmMessageId = crypto.randomUUID();
    const data = await wazzupFetch('/message', {
      method: 'POST',
      body: JSON.stringify({
        channelId,
        crmUserId: user.id,
        crmMessageId,
        chatId,
        chatType,
        text,
      }),
    });

    const messageId = data?.messageId || data?.id || crmMessageId;
    await supabase.from('wz_messages').upsert({
      clinic_id: clinicId,
      message_id: messageId,
      channel_id: channelId,
      chat_type: chatType,
      chat_id: chatId,
      text,
      msg_type: 'text',
      is_echo: true,
      status: 'sent',
      author_id: user.id,
      raw_payload: data,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'message_id' });

    return jsonResponse({ success: true, messageId });
  } catch (err) {
    if (err instanceof Response) return err;
    return jsonResponse({ error: err instanceof Error ? err.message : 'Unknown error' }, { status: 500 });
  }
});
