import { adminClient, bearerToken } from '../_shared/auth.ts';
import { handleOptions, jsonResponse } from '../_shared/cors.ts';

function webhookKeyMatches(req: Request) {
  const expected = Deno.env.get('WAZZUP_CRM_KEY');
  if (!expected) return true;
  const url = new URL(req.url);
  return (
    bearerToken(req) === expected ||
    req.headers.get('x-wazzup-crm-key') === expected ||
    url.searchParams.get('key') === expected
  );
}

async function clinicIdForChannel(supabase: ReturnType<typeof adminClient>, channelId: string) {
  const { data } = await supabase
    .from('wz_channels')
    .select('clinic_id')
    .eq('channel_id', channelId)
    .eq('is_active', true)
    .maybeSingle();
  return data?.clinic_id || Deno.env.get('WAZZUP_DEFAULT_CLINIC_ID') || null;
}

Deno.serve(async req => {
  const options = handleOptions(req);
  if (options) return options;

  try {
    if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, { status: 405 });
    if (!webhookKeyMatches(req)) return jsonResponse({ error: 'Unauthorized' }, { status: 401 });

    const supabase = adminClient();
    const body = await req.json();
    if (body?.test === true) return jsonResponse({ ok: true });

    const savedMessages: string[] = [];
    const skippedMessages: Array<{ messageId?: string; reason: string }> = [];

    if (Array.isArray(body?.messages)) {
      for (const message of body.messages) {
        const messageId = String(message.messageId || '');
        const channelId = String(message.channelId || '');
        const chatType = String(message.chatType || 'whatsapp');
        const chatId = String(message.chatId || '');
        if (!messageId || !channelId || !chatId) {
          skippedMessages.push({ messageId, reason: 'missing messageId/channelId/chatId' });
          continue;
        }

        const clinicId = await clinicIdForChannel(supabase, channelId);
        if (!clinicId) {
          skippedMessages.push({ messageId, reason: 'clinic not resolved for channelId' });
          continue;
        }

        const contactName = message.contact?.name || message.contact?.phone || chatId;
        const { data: contact } = await supabase
          .from('wz_contacts')
          .upsert({
            clinic_id: clinicId,
            chat_type: chatType,
            chat_id: chatId,
            name: contactName,
            avatar_uri: message.contact?.avatarUri || null,
            updated_at: new Date().toISOString(),
          }, { onConflict: 'clinic_id,chat_type,chat_id' })
          .select('id')
          .single();

        await supabase
          .from('wz_messages')
          .upsert({
            clinic_id: clinicId,
            wz_contact_id: contact?.id || null,
            message_id: messageId,
            channel_id: channelId,
            chat_type: chatType,
            chat_id: chatId,
            contact_name: contactName,
            text: message.text || null,
            content_uri: message.contentUri || null,
            msg_type: message.type || 'text',
            is_echo: Boolean(message.isEcho),
            status: message.status || (message.isEcho ? 'sent' : 'inbound'),
            author_id: message.authorId || null,
            author_name: message.authorName || null,
            error: message.error || null,
            raw_payload: message,
            created_at: message.dateTime || new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }, { onConflict: 'message_id' });

        savedMessages.push(messageId);
      }
    }

    if (body?.createContact) {
      const contact = body.createContact;
      const channelId = String(contact.channelId || body.channelId || '');
      const clinicId = await clinicIdForChannel(supabase, channelId);
      if (clinicId) {
        const { data } = await supabase
          .from('wz_contacts')
          .upsert({
            clinic_id: clinicId,
            chat_type: contact.chatType || 'whatsapp',
            chat_id: String(contact.chatId || contact.phone || ''),
            name: contact.name || contact.phone || contact.chatId || null,
            avatar_uri: contact.avatarUri || null,
            updated_at: new Date().toISOString(),
          }, { onConflict: 'clinic_id,chat_type,chat_id' })
          .select()
          .single();
        return jsonResponse({ ok: true, contact: data });
      }
    }

    if (body?.createDeal) {
      const deal = body.createDeal;
      const channelId = String(deal.channelId || body.channelId || '');
      const clinicId = await clinicIdForChannel(supabase, channelId);
      if (clinicId) {
        const { data } = await supabase
          .from('wz_deals')
          .insert({
            clinic_id: clinicId,
            wz_contact_id: deal.wzContactId || null,
            crm_deal_id: deal.crmDealId || null,
            title: deal.title || 'WhatsApp',
            status: deal.status || 'open',
          })
          .select()
          .single();
        return jsonResponse({ ok: true, deal: data });
      }
    }

    return jsonResponse({ ok: true, savedMessages, skippedMessages });
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : 'Unknown error' }, { status: 500 });
  }
});
