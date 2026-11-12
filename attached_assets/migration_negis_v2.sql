-- ============================================================
-- Negis CRM — Migration v2
-- Run this in Supabase → SQL Editor
-- Safe to run multiple times (IF NOT EXISTS / DO $$ guards)
-- ============================================================

-- ── 1. leads: add missing columns ──────────────────────────

ALTER TABLE leads ADD COLUMN IF NOT EXISTS full_name  text;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS assigned_to uuid;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS email      text;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS company    text;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS service_id uuid REFERENCES services(id) ON DELETE SET NULL;

-- Migrate first_name + last_name → full_name
UPDATE leads
SET full_name = TRIM(COALESCE(first_name, '') || ' ' || COALESCE(last_name, ''))
WHERE (full_name IS NULL OR full_name = '')
  AND (first_name IS NOT NULL OR last_name IS NOT NULL);

-- Migrate agent_id → assigned_to (where assigned_to is still empty)
UPDATE leads
SET assigned_to = agent_id
WHERE assigned_to IS NULL AND agent_id IS NOT NULL;

-- Fix: if assigned_to was stored as auth.users UUID (not agents.id),
-- look up the correct agents.id via agents.user_id
UPDATE leads l
SET assigned_to = a.id
FROM agents a
WHERE a.user_id = l.assigned_to
  AND l.assigned_to IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM agents a2 WHERE a2.id = l.assigned_to);

-- Add FK constraint for assigned_to → agents(id)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'leads_assigned_to_fkey'
  ) THEN
    ALTER TABLE leads
      ADD CONSTRAINT leads_assigned_to_fkey
      FOREIGN KEY (assigned_to) REFERENCES agents(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ── 2. lead_statuses: add sort_order ───────────────────────

ALTER TABLE lead_statuses ADD COLUMN IF NOT EXISTS sort_order integer DEFAULT 0;

-- Copy from position column if it exists and sort_order is still 0
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'lead_statuses' AND column_name = 'position'
  ) THEN
    UPDATE lead_statuses SET sort_order = position WHERE sort_order = 0;
  END IF;
END $$;

-- ── 3. booking_statuses: add sort_order ────────────────────

ALTER TABLE booking_statuses ADD COLUMN IF NOT EXISTS sort_order integer DEFAULT 0;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'booking_statuses' AND column_name = 'position'
  ) THEN
    UPDATE booking_statuses SET sort_order = position WHERE sort_order = 0;
  END IF;
END $$;

-- ── 4. agents: add role_id ──────────────────────────────────

ALTER TABLE agents ADD COLUMN IF NOT EXISTS role_id uuid REFERENCES roles(id) ON DELETE SET NULL;

-- ── 5. Verify results ───────────────────────────────────────

SELECT 'leads columns' AS check, column_name
FROM information_schema.columns
WHERE table_name = 'leads'
  AND column_name IN ('full_name', 'assigned_to', 'email', 'company', 'service_id')
ORDER BY column_name;

SELECT 'lead_statuses sort_order' AS check, count(*) AS rows_with_sort_order
FROM lead_statuses WHERE sort_order IS NOT NULL;

SELECT 'booking_statuses sort_order' AS check, count(*) AS rows_with_sort_order
FROM booking_statuses WHERE sort_order IS NOT NULL;

SELECT 'agents role_id column' AS check, column_name
FROM information_schema.columns
WHERE table_name = 'agents' AND column_name = 'role_id';

SELECT 'leads data check' AS check,
  count(*) FILTER (WHERE full_name IS NOT NULL AND full_name <> '') AS with_full_name,
  count(*) FILTER (WHERE assigned_to IS NOT NULL)                  AS with_assigned_to,
  count(*)                                                          AS total
FROM leads;
