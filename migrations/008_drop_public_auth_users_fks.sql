-- ============================================================
-- NEGIS Migration 008 - Remove all public foreign keys to auth.users
-- Run in Supabase Dashboard -> SQL Editor
-- Safe to run multiple times
--
-- Why:
-- Browser clients use anon/authenticated roles. Those roles must not read
-- auth.users directly. If public tables have FK constraints to auth.users,
-- inserts/updates from the frontend can fail with:
--   permission denied for table users
--
-- This migration keeps user UUID values in public tables, but removes FK
-- checks to auth.users. Clinic access remains protected by RLS policies.
-- ============================================================

DO $$
DECLARE
  fk record;
BEGIN
  FOR fk IN
    SELECT
      con.conname,
      ns.nspname AS schema_name,
      rel.relname AS table_name
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace ns ON ns.oid = rel.relnamespace
    WHERE con.contype = 'f'
      AND con.confrelid = 'auth.users'::regclass
      AND ns.nspname = 'public'
  LOOP
    EXECUTE format(
      'ALTER TABLE %I.%I DROP CONSTRAINT IF EXISTS %I',
      fk.schema_name,
      fk.table_name,
      fk.conname
    );
  END LOOP;
END $$;

-- Make sure common user-id columns stay nullable-friendly after FK removal.
DO $$
BEGIN
  IF to_regclass('public.user_roles') IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'user_roles' AND column_name = 'user_id'
     ) THEN
    ALTER TABLE public.user_roles ALTER COLUMN user_id DROP NOT NULL;
  END IF;

  IF to_regclass('public.agents') IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'agents' AND column_name = 'user_id'
     ) THEN
    ALTER TABLE public.agents ALTER COLUMN user_id DROP NOT NULL;
  END IF;

  IF to_regclass('public.chat_conversations') IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'chat_conversations' AND column_name = 'created_by'
     ) THEN
    ALTER TABLE public.chat_conversations ALTER COLUMN created_by DROP NOT NULL;
  END IF;

  IF to_regclass('public.chat_members') IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'chat_members' AND column_name = 'user_id'
     ) THEN
    ALTER TABLE public.chat_members ALTER COLUMN user_id DROP NOT NULL;
  END IF;

  IF to_regclass('public.chat_messages') IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'chat_messages' AND column_name = 'sender_user_id'
     ) THEN
    ALTER TABLE public.chat_messages
      ALTER COLUMN sender_user_id SET DEFAULT auth.uid(),
      ALTER COLUMN sender_user_id DROP NOT NULL;
  END IF;
END $$;

-- Diagnostic output: after this migration, this query should return 0 rows.
SELECT
  ns.nspname AS schema_name,
  rel.relname AS table_name,
  con.conname AS constraint_name
FROM pg_constraint con
JOIN pg_class rel ON rel.oid = con.conrelid
JOIN pg_namespace ns ON ns.oid = rel.relnamespace
WHERE con.contype = 'f'
  AND con.confrelid = 'auth.users'::regclass
  AND ns.nspname = 'public'
ORDER BY 1, 2, 3;
