import { supabase } from '@/lib/supabase';
import type { WazzupIframeUrlRequest, WazzupSendMessageRequest } from '@/types/wazzup';

export function normalizeWazzupChatId(value: string | null | undefined) {
  return (value ?? '').replace(/\D/g, '');
}

async function invokeWazzupFunction<T>(name: string, body: Record<string, any>): Promise<T> {
  const { data, error } = await supabase.functions.invoke<T>(name, { body });
  if (error) throw new Error(error.message);
  return data as T;
}

export async function fetchWazzupIframeUrl(request: WazzupIframeUrlRequest) {
  const payload = {
    ...request,
    contactPhone: normalizeWazzupChatId(request.contactPhone),
    chatType: request.chatType ?? 'whatsapp',
    scope: request.scope ?? 'card',
  };
  const data = await invokeWazzupFunction<{ url: string }>('wazzup-iframe-url', payload);
  if (!data?.url) throw new Error('Wazzup не вернул ссылку на чат');
  return data.url;
}

export async function sendWazzupMessage(request: WazzupSendMessageRequest) {
  return invokeWazzupFunction<{ success: boolean; messageId?: string }>('wazzup-send', {
    ...request,
    chatId: normalizeWazzupChatId(request.chatId),
    chatType: request.chatType ?? 'whatsapp',
  });
}
