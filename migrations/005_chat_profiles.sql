-- ============================================================
-- NEGIS Migration 005 — Chat + employee profile avatars
-- Run in Supabase Dashboard -> SQL Editor
-- Safe to run multiple times
-- ============================================================

-- 1. Employee profile visuals
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS avatar_url text,
  ADD COLUMN IF NOT EXISTS avatar_icon text,
  ADD COLUMN IF NOT EXISTS avatar_color text;

-- 2. Chat conversations
CREATE TABLE IF NOT EXISTS chat_conversations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id   uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  type        text NOT NULL CHECK (type IN ('direct', 'group')),
  title       text NOT NULL,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chat_conversations_clinic_id_idx
  ON chat_conversations(clinic_id);

CREATE INDEX IF NOT EXISTS chat_conversations_updated_at_idx
  ON chat_conversations(clinic_id, updated_at DESC);

-- 3. Chat members
CREATE TABLE IF NOT EXISTS chat_members (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id       uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  agent_id        uuid REFERENCES agents(id) ON DELETE CASCADE,
  user_id         uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chat_members_agent_or_user CHECK (agent_id IS NOT NULL OR user_id IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS chat_members_conversation_agent_uidx
  ON chat_members(conversation_id, agent_id)
  WHERE agent_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS chat_members_conversation_user_uidx
  ON chat_members(conversation_id, user_id)
  WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS chat_members_clinic_id_idx
  ON chat_members(clinic_id);

CREATE INDEX IF NOT EXISTS chat_members_conversation_id_idx
  ON chat_members(conversation_id);

-- 4. Chat messages
CREATE TABLE IF NOT EXISTS chat_messages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id        uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  conversation_id  uuid NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  sender_agent_id  uuid REFERENCES agents(id) ON DELETE SET NULL,
  sender_user_id   uuid DEFAULT auth.uid(),
  body             text NOT NULL,
  read_by          uuid[] NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chat_messages_conversation_created_idx
  ON chat_messages(conversation_id, created_at);

CREATE INDEX IF NOT EXISTS chat_messages_clinic_id_idx
  ON chat_messages(clinic_id);

-- 5. updated_at trigger
CREATE OR REPLACE FUNCTION set_chat_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE chat_conversations
  SET updated_at = now()
  WHERE id = NEW.conversation_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS chat_messages_touch_conversation ON chat_messages;
CREATE TRIGGER chat_messages_touch_conversation
AFTER INSERT ON chat_messages
FOR EACH ROW
EXECUTE FUNCTION set_chat_updated_at();

-- 6. RLS
ALTER TABLE chat_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "chat_conversations_clinic_access" ON chat_conversations;
CREATE POLICY "chat_conversations_clinic_access" ON chat_conversations
  FOR ALL
  USING (
    clinic_id IN (
      SELECT clinic_id FROM user_roles WHERE user_id = auth.uid()
    )
  )
  WITH CHECK (
    clinic_id IN (
      SELECT clinic_id FROM user_roles WHERE user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "chat_members_clinic_access" ON chat_members;
CREATE POLICY "chat_members_clinic_access" ON chat_members
  FOR ALL
  USING (
    clinic_id IN (
      SELECT clinic_id FROM user_roles WHERE user_id = auth.uid()
    )
  )
  WITH CHECK (
    clinic_id IN (
      SELECT clinic_id FROM user_roles WHERE user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "chat_messages_clinic_access" ON chat_messages;
CREATE POLICY "chat_messages_clinic_access" ON chat_messages
  FOR ALL
  USING (
    clinic_id IN (
      SELECT clinic_id FROM user_roles WHERE user_id = auth.uid()
    )
  )
  WITH CHECK (
    clinic_id IN (
      SELECT clinic_id FROM user_roles WHERE user_id = auth.uid()
    )
  );
