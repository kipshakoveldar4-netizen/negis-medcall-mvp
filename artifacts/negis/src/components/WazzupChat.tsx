import { useEffect, useMemo, useState } from 'react';
import { MessageCircle, RefreshCw } from 'lucide-react';
import { fetchWazzupIframeUrl, normalizeWazzupChatId } from '@/lib/wazzup';
import type { WazzupChatType, WazzupIframeEvent } from '@/types/wazzup';

interface WazzupChatProps {
  clinicId: string;
  userId: string;
  userName?: string;
  contactPhone: string | null;
  contactName: string;
  leadId?: string;
  chatType?: WazzupChatType;
  onDealCreate?: (data: WazzupIframeEvent) => void;
  onDealOpen?: (data: WazzupIframeEvent) => void;
}

export function WazzupChat({
  clinicId,
  userId,
  userName,
  contactPhone,
  contactName,
  leadId,
  chatType = 'whatsapp',
  onDealCreate,
  onDealOpen,
}: WazzupChatProps) {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const chatId = useMemo(() => normalizeWazzupChatId(contactPhone), [contactPhone]);

  const loadUrl = async () => {
    if (!chatId) {
      setError('У клиента не указан номер WhatsApp.');
      setUrl('');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const nextUrl = await fetchWazzupIframeUrl({
        clinicId,
        userId,
        userName,
        contactPhone: chatId,
        contactName,
        leadId,
        chatType,
      });
      setUrl(nextUrl);
    } catch (err: any) {
      setUrl('');
      setError(err?.message || 'Не удалось открыть Wazzup.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadUrl();
  }, [clinicId, userId, chatId, contactName, leadId, chatType]);

  useEffect(() => {
    const handler = (event: MessageEvent<WazzupIframeEvent>) => {
      const type = event.data?.type || event.data?.event;
      if (type === 'WZ_CREATE_ENTITY') onDealCreate?.(event.data);
      if (type === 'WZ_OPEN_ENTITY') onDealOpen?.(event.data);
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [onDealCreate, onDealOpen]);

  if (loading) {
    return (
      <div className="h-[560px] rounded-xl border border-[#E7ECF3] bg-[#F8FAFC] flex items-center justify-center text-sm text-[#64748B]">
        <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
        Загрузка WhatsApp-чата...
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-[560px] rounded-xl border border-[#E7ECF3] bg-[#F8FAFC] flex flex-col items-center justify-center gap-3 p-6 text-center">
        <MessageCircle className="h-8 w-8 text-[#94A3B8]" />
        <div className="text-sm font-semibold text-[#0B1220]">WhatsApp пока не открылся</div>
        <div className="max-w-md text-sm text-[#64748B]">{error}</div>
        <button
          type="button"
          onClick={loadUrl}
          className="mt-1 rounded-xl bg-[#1E325C] px-4 py-2 text-sm font-semibold text-white"
        >
          Повторить
        </button>
      </div>
    );
  }

  return (
    <div className="h-[560px] overflow-hidden rounded-xl border border-[#E7ECF3] bg-white">
      {url && (
        <iframe
          title={`WhatsApp ${contactName}`}
          src={url}
          allow="microphone *; clipboard-write *"
          className="h-full w-full border-0"
        />
      )}
    </div>
  );
}
