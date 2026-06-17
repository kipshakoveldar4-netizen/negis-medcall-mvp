import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { supabase } from '@/lib/supabase';

interface WazzupInboxMessage {
  id: string;
  clinic_id: string;
  chat_id: string;
  contact_name: string | null;
  text: string | null;
  is_echo: boolean;
  created_at: string;
}

interface UseWazzupInboxOptions {
  clinicId: string | null;
  enabled?: boolean;
}

export function useWazzupInbox({ clinicId, enabled = true }: UseWazzupInboxOptions) {
  const [unreadCount, setUnreadCount] = useState(0);
  const [latestMessage, setLatestMessage] = useState<WazzupInboxMessage | null>(null);

  useEffect(() => {
    if (!enabled || !clinicId) return;

    const channel = supabase
      .channel(`wz_messages_realtime:${clinicId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'wz_messages',
          filter: `clinic_id=eq.${clinicId}`,
        },
        payload => {
          const message = payload.new as WazzupInboxMessage;
          if (message.is_echo) return;
          setLatestMessage(message);
          setUnreadCount(count => count + 1);
          toast.message(message.contact_name || message.chat_id || 'WhatsApp', {
            description: message.text || 'Новое входящее сообщение',
          });
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [clinicId, enabled]);

  return {
    unreadCount,
    latestMessage,
    resetUnreadCount: () => setUnreadCount(0),
  };
}
