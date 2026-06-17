-- ============================================================
-- NEGIS Migration 007 - Fix "permission denied for table users"
-- Run in Supabase Dashboard -> SQL Editor
-- Safe to run multiple times
--
-- Why:
-- anon/authenticated clients cannot read auth.users directly. Foreign keys
-- from chat tables to auth.users can trigger permission checks during inserts
-- and produce: permission denied for table users.
--
-- We keep user UUID values for ownership/display, but remove FK constraints
-- to auth.users. Access is still protected by clinic_id RLS policies.
-- ============================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_schema = 'public'
      AND table_name = 'chat_conversations'
      AND constraint_name = 'chat_conversations_created_by_fkey'
  ) THEN
    ALTER TABLE public.chat_conversations
      DROP CONSTRAINT chat_conversations_created_by_fkey;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_schema = 'public'
      AND table_name = 'chat_members'
      AND constraint_name = 'chat_members_user_id_fkey'
  ) THEN
    ALTER TABLE public.chat_members
      DROP CONSTRAINT chat_members_user_id_fkey;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_schema = 'public'
      AND table_name = 'chat_messages'
      AND constraint_name = 'chat_messages_sender_user_id_fkey'
  ) THEN
    ALTER TABLE public.chat_messages
      DROP CONSTRAINT chat_messages_sender_user_id_fkey;
  END IF;
END $$;

ALTER TABLE public.chat_conversations
  ALTER COLUMN created_by DROP NOT NULL;

ALTER TABLE public.chat_members
  ALTER COLUMN user_id DROP NOT NULL;

ALTER TABLE public.chat_messages
  ALTER COLUMN sender_user_id SET DEFAULT auth.uid(),
  ALTER COLUMN sender_user_id DROP NOT NULL;
