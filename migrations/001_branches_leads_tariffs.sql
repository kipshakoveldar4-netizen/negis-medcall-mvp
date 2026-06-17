-- ============================================================
-- NEGIS Migration 001 — Branches, Leads fix, Tariffs
-- Run in Supabase Dashboard → SQL Editor
-- Safe to run multiple times (uses IF NOT EXISTS / ADD COLUMN IF NOT EXISTS)
-- ============================================================

-- ============================================================
-- 1. FIX LEADS TABLE
-- Ensure all columns expected by the frontend exist
-- ============================================================

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS full_name    text,
  ADD COLUMN IF NOT EXISTS phone        text,
  ADD COLUMN IF NOT EXISTS email        text,
  ADD COLUMN IF NOT EXISTS company      text,
  ADD COLUMN IF NOT EXISTS age          integer,
  ADD COLUMN IF NOT EXISTS source       text,
  ADD COLUMN IF NOT EXISTS status_id    uuid REFERENCES lead_statuses(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS assigned_to  uuid REFERENCES agents(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS comment      text,
  ADD COLUMN IF NOT EXISTS updated_at   timestamptz DEFAULT now();

-- Migrate old name fields to full_name if they exist (safe no-op if columns don't exist)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='leads' AND column_name='first_name') THEN
    UPDATE leads SET full_name = TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,''))
    WHERE full_name IS NULL AND (first_name IS NOT NULL OR last_name IS NOT NULL);
  END IF;
END $$;

-- Migrate agent_id → assigned_to if old column exists
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='leads' AND column_name='agent_id') THEN
    UPDATE leads SET assigned_to = agent_id::uuid
    WHERE assigned_to IS NULL AND agent_id IS NOT NULL;
  END IF;
END $$;

-- Migrate name → full_name if old column exists
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='leads' AND column_name='name') THEN
    UPDATE leads SET full_name = name WHERE full_name IS NULL AND name IS NOT NULL;
  END IF;
END $$;

-- ============================================================
-- 2. BRANCHES TABLE
-- ============================================================

CREATE TABLE IF NOT EXISTS branches (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id   uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  name        text NOT NULL,
  address     text,
  phone       text,
  city        text,
  timezone    text DEFAULT 'Asia/Almaty',
  is_main     boolean DEFAULT false,
  is_active   boolean DEFAULT true,
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now()
);

-- Create index for clinic_id lookups
CREATE INDEX IF NOT EXISTS branches_clinic_id_idx ON branches(clinic_id);

-- Enable Row Level Security
ALTER TABLE branches ENABLE ROW LEVEL SECURITY;

-- RLS policies (same pattern as other tables)
DROP POLICY IF EXISTS "branches_clinic_access" ON branches;
CREATE POLICY "branches_clinic_access" ON branches
  USING (
    clinic_id IN (
      SELECT clinic_id FROM user_roles WHERE user_id = auth.uid()
    )
  );

-- Auto-create "Основной филиал" for existing clinics that don't have one
INSERT INTO branches (clinic_id, name, is_main)
SELECT id, 'Основной филиал', true
FROM clinics
WHERE id NOT IN (SELECT clinic_id FROM branches WHERE is_main = true)
ON CONFLICT DO NOTHING;

-- ============================================================
-- 3. ADD branch_id TO RELATED TABLES
-- ============================================================

ALTER TABLE agents   ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES branches(id) ON DELETE SET NULL;
ALTER TABLE services ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES branches(id) ON DELETE SET NULL;
ALTER TABLE leads    ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES branches(id) ON DELETE SET NULL;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES branches(id) ON DELETE SET NULL;

-- ============================================================
-- 4. TARIFF PLANS TABLE
-- ============================================================

CREATE TABLE IF NOT EXISTS tariff_plans (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                text UNIQUE NOT NULL,
  name                text NOT NULL,
  price_monthly_kzt   integer NOT NULL DEFAULT 0,
  max_branches        integer,   -- NULL = unlimited
  max_agents          integer,   -- NULL = unlimited
  max_leads_monthly   integer,   -- NULL = unlimited
  max_bookings_monthly integer,  -- NULL = unlimited
  trial_days          integer DEFAULT 0,
  is_active           boolean DEFAULT true
);

-- Seed tariff plans
INSERT INTO tariff_plans (slug, name, price_monthly_kzt, max_branches, max_agents, max_leads_monthly, max_bookings_monthly, trial_days)
VALUES
  ('trial', 'Trial',   0,      1, 2,    30,   20,   7),
  ('start', 'Start',   20000,  1, 5,    300,  300,  0),
  ('pro',   'Pro',     50000,  3, 20,   3000, NULL, 0),
  ('max',   'Max',     100000, NULL, NULL, NULL, NULL, 0)
ON CONFLICT (slug) DO UPDATE SET
  price_monthly_kzt    = EXCLUDED.price_monthly_kzt,
  max_branches         = EXCLUDED.max_branches,
  max_agents           = EXCLUDED.max_agents,
  max_leads_monthly    = EXCLUDED.max_leads_monthly,
  max_bookings_monthly = EXCLUDED.max_bookings_monthly;

-- ============================================================
-- 5. CLINIC SUBSCRIPTIONS TABLE
-- ============================================================

CREATE TABLE IF NOT EXISTS clinic_subscriptions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id       uuid NOT NULL UNIQUE REFERENCES clinics(id) ON DELETE CASCADE,
  plan_id         uuid REFERENCES tariff_plans(id),
  status          text NOT NULL DEFAULT 'trial'
                  CHECK (status IN ('trial','active','expired','blocked')),
  trial_ends_at   timestamptz,
  period_starts_at timestamptz DEFAULT now(),
  period_ends_at  timestamptz,
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);

ALTER TABLE clinic_subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "subscriptions_owner_access" ON clinic_subscriptions;
CREATE POLICY "subscriptions_owner_access" ON clinic_subscriptions
  USING (
    clinic_id IN (
      SELECT clinic_id FROM user_roles WHERE user_id = auth.uid() AND role IN ('owner','manager')
    )
  );

-- Auto-create trial subscription for existing clinics
INSERT INTO clinic_subscriptions (clinic_id, plan_id, status, trial_ends_at)
SELECT
  c.id,
  (SELECT id FROM tariff_plans WHERE slug = 'trial'),
  'trial',
  c.created_at + interval '7 days'
FROM clinics c
WHERE c.id NOT IN (SELECT clinic_id FROM clinic_subscriptions)
ON CONFLICT DO NOTHING;

-- ============================================================
-- 6. FIX sort_order ON booking_statuses and lead_statuses
-- Ensure sort_order column exists (in case it's missing)
-- ============================================================

ALTER TABLE booking_statuses ADD COLUMN IF NOT EXISTS sort_order integer DEFAULT 0;
ALTER TABLE lead_statuses    ADD COLUMN IF NOT EXISTS sort_order integer DEFAULT 0;

-- Backfill sort_order where it's 0/null using row number
UPDATE booking_statuses bs
SET sort_order = sub.rn
FROM (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY clinic_id ORDER BY created_at) - 1 AS rn
  FROM booking_statuses
  WHERE sort_order = 0 OR sort_order IS NULL
) sub
WHERE bs.id = sub.id;

UPDATE lead_statuses ls
SET sort_order = sub.rn
FROM (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY clinic_id ORDER BY created_at) - 1 AS rn
  FROM lead_statuses
  WHERE sort_order = 0 OR sort_order IS NULL
) sub
WHERE ls.id = sub.id;

-- ============================================================
-- Done. All changes are backward-compatible.
-- ============================================================
