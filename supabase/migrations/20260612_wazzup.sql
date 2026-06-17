-- Wazzup integration tables for Negis CRM.
-- Run in Supabase SQL editor or through Supabase CLI.

CREATE TABLE IF NOT EXISTS wz_channels (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id   uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  channel_id  text NOT NULL UNIQUE,
  chat_type   text NOT NULL DEFAULT 'whatsapp',
  name        text,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wz_contacts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id      uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  chat_type      text NOT NULL DEFAULT 'whatsapp',
  chat_id        text NOT NULL,
  name           text,
  avatar_uri     text,
  crm_contact_id uuid REFERENCES leads(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, chat_type, chat_id)
);

CREATE TABLE IF NOT EXISTS wz_deals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id     uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  wz_contact_id uuid REFERENCES wz_contacts(id) ON DELETE CASCADE,
  crm_deal_id   uuid REFERENCES leads(id) ON DELETE SET NULL,
  title         text,
  status        text NOT NULL DEFAULT 'open',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wz_messages (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id    uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  wz_contact_id uuid REFERENCES wz_contacts(id) ON DELETE SET NULL,
  message_id   text NOT NULL UNIQUE,
  channel_id   text NOT NULL,
  chat_type    text NOT NULL DEFAULT 'whatsapp',
  chat_id      text NOT NULL,
  contact_name text,
  text         text,
  content_uri  text,
  msg_type     text NOT NULL DEFAULT 'text',
  is_echo      boolean NOT NULL DEFAULT false,
  status       text,
  author_id    text,
  author_name  text,
  error        jsonb,
  raw_payload  jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS wz_channels_clinic_idx
  ON wz_channels (clinic_id, is_active);

CREATE INDEX IF NOT EXISTS wz_contacts_clinic_chat_idx
  ON wz_contacts (clinic_id, chat_type, chat_id);

CREATE INDEX IF NOT EXISTS wz_deals_clinic_contact_idx
  ON wz_deals (clinic_id, wz_contact_id, status);

CREATE INDEX IF NOT EXISTS wz_messages_clinic_created_idx
  ON wz_messages (clinic_id, created_at DESC);

CREATE INDEX IF NOT EXISTS wz_messages_chat_created_idx
  ON wz_messages (clinic_id, chat_type, chat_id, created_at DESC);

ALTER TABLE wz_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE wz_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE wz_deals ENABLE ROW LEVEL SECURITY;
ALTER TABLE wz_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "wz_channels_clinic_access" ON wz_channels;
CREATE POLICY "wz_channels_clinic_access" ON wz_channels
  USING (
    clinic_id IN (
      SELECT clinic_id FROM user_roles WHERE user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "wz_contacts_clinic_access" ON wz_contacts;
CREATE POLICY "wz_contacts_clinic_access" ON wz_contacts
  USING (
    clinic_id IN (
      SELECT clinic_id FROM user_roles WHERE user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "wz_deals_clinic_access" ON wz_deals;
CREATE POLICY "wz_deals_clinic_access" ON wz_deals
  USING (
    clinic_id IN (
      SELECT clinic_id FROM user_roles WHERE user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "wz_messages_clinic_access" ON wz_messages;
CREATE POLICY "wz_messages_clinic_access" ON wz_messages
  USING (
    clinic_id IN (
      SELECT clinic_id FROM user_roles WHERE user_id = auth.uid()
    )
  );

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE wz_messages;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_object THEN NULL;
END $$;
