export type WazzupChatType =
  | 'whatsapp'
  | 'whatsgroup'
  | 'telegram'
  | 'telegroup'
  | 'viber'
  | 'instagram'
  | 'vk'
  | 'avito'
  | 'max'
  | 'maxgroup';

export type WazzupMessageType =
  | 'text'
  | 'image'
  | 'audio'
  | 'video'
  | 'document'
  | 'vcard'
  | 'geo';

export type WazzupMessageStatus =
  | 'sent'
  | 'delivered'
  | 'read'
  | 'error'
  | 'inbound';

export interface WazzupContact {
  name?: string;
  phone?: string;
  avatarUri?: string;
  username?: string;
}

export interface WazzupMessage {
  messageId: string;
  channelId: string;
  chatType: WazzupChatType;
  chatId: string;
  dateTime: string;
  type: WazzupMessageType;
  isEcho: boolean;
  text?: string;
  contentUri?: string;
  status?: WazzupMessageStatus;
  contact?: WazzupContact;
  authorId?: string;
  authorName?: string;
}

export interface WazzupEntityData {
  entity?: {
    id?: string;
    type?: string;
  };
  contact?: WazzupContact;
  chatType?: WazzupChatType;
  chatId?: string;
}

export interface WazzupIframeEvent {
  type?: 'WZ_CREATE_ENTITY' | 'WZ_OPEN_ENTITY';
  event?: 'WZ_CREATE_ENTITY' | 'WZ_OPEN_ENTITY';
  data?: WazzupEntityData;
  entity?: WazzupEntityData['entity'];
}

export interface WazzupIframeUrlRequest {
  clinicId: string;
  userId: string;
  userName?: string;
  contactPhone: string;
  contactName?: string;
  leadId?: string;
  chatType?: WazzupChatType;
  scope?: 'card' | 'global';
}

export interface WazzupSendMessageRequest {
  clinicId: string;
  channelId: string;
  chatId: string;
  chatType?: WazzupChatType;
  text: string;
}
