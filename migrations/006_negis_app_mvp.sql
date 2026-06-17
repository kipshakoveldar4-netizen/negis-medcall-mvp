-- NEGIS Migration 006 — Negis App CRM MVP fields and tables
-- Run in Supabase SQL editor after migrations 001-005.

-- 1. Booking / appointment bridge fields.
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'crm',
  ADD COLUMN IF NOT EXISTS app_appointment_id text,
  ADD COLUMN IF NOT EXISTS app_client_id text,
  ADD COLUMN IF NOT EXISTS qr_status text NOT NULL DEFAULT 'created',
  ADD COLUMN IF NOT EXISTS bonus_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS arrived_at timestamptz,
  ADD COLUMN IF NOT EXISTS arrival_confirmed_by uuid REFERENCES agents(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS bookings_clinic_source_date_idx
  ON bookings(clinic_id, source, date);

CREATE UNIQUE INDEX IF NOT EXISTS bookings_clinic_app_appointment_uidx
  ON bookings(clinic_id, app_appointment_id)
  WHERE app_appointment_id IS NOT NULL;

-- 2. Client / lead link fields.
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS app_client_id text,
  ADD COLUMN IF NOT EXISTS bonus_balance_cached integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS phone_normalized text;

UPDATE leads
SET phone_normalized = regexp_replace(coalesce(phone, ''), '\D', '', 'g')
WHERE phone_normalized IS NULL;

CREATE INDEX IF NOT EXISTS leads_clinic_phone_normalized_idx
  ON leads(clinic_id, phone_normalized);

-- 3. App-ready service/staff/branch settings.
ALTER TABLE services
  ADD COLUMN IF NOT EXISTS visible_in_app boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS app_booking_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS duration_minutes integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS app_description text,
  ADD COLUMN IF NOT EXISTS app_image_url text,
  ADD COLUMN IF NOT EXISTS bonus_payment_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS max_bonus_percent integer NOT NULL DEFAULT 50;

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS visible_in_app boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS app_booking_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS app_services jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS app_working_hours jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS app_breaks jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS app_booking_limit integer;

ALTER TABLE branches
  ADD COLUMN IF NOT EXISTS visible_in_app boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS app_booking_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS address text,
  ADD COLUMN IF NOT EXISTS phone text,
  ADD COLUMN IF NOT EXISTS latitude numeric,
  ADD COLUMN IF NOT EXISTS longitude numeric,
  ADD COLUMN IF NOT EXISTS working_hours jsonb NOT NULL DEFAULT '{}'::jsonb;

-- 4. Clinic loyalty settings.
CREATE TABLE IF NOT EXISTS clinic_app_settings (
  clinic_id uuid PRIMARY KEY REFERENCES clinics(id) ON DELETE CASCADE,
  app_enabled boolean NOT NULL DEFAULT false,
  app_booking_enabled boolean NOT NULL DEFAULT false,
  loyalty_enabled boolean NOT NULL DEFAULT false,
  bonus_spend_enabled boolean NOT NULL DEFAULT false,
  max_bonus_percent integer NOT NULL DEFAULT 50,
  bonus_per_visit integer NOT NULL DEFAULT 0,
  bonus_first_visit integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO clinic_app_settings (clinic_id)
SELECT id FROM clinics
ON CONFLICT (clinic_id) DO NOTHING;

-- 5. Promotions, local app tasks, QR check-ins and audit logs.
CREATE TABLE IF NOT EXISTS promotions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text,
  image_url text,
  service_id uuid REFERENCES services(id) ON DELETE SET NULL,
  discount_type text,
  discount_value numeric,
  bonus_reward integer,
  starts_at timestamptz,
  ends_at timestamptz,
  city text,
  branch_id uuid REFERENCES branches(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'draft',
  moderation_status text NOT NULL DEFAULT 'draft',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text,
  type text NOT NULL DEFAULT 'custom',
  bonus_reward integer NOT NULL DEFAULT 0,
  starts_at timestamptz,
  ends_at timestamptz,
  status text NOT NULL DEFAULT 'draft',
  moderation_status text NOT NULL DEFAULT 'draft',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS qr_checkins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  appointment_id uuid REFERENCES bookings(id) ON DELETE CASCADE,
  client_id uuid REFERENCES leads(id) ON DELETE SET NULL,
  token_hash text NOT NULL,
  status text NOT NULL DEFAULT 'created',
  scanned_by uuid REFERENCES agents(id) ON DELETE SET NULL,
  scanned_at timestamptz,
  confirmed_at timestamptz,
  device_info text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  actor_agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  entity_type text,
  entity_id text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS promotions_clinic_status_idx ON promotions(clinic_id, status, moderation_status);
CREATE INDEX IF NOT EXISTS app_tasks_clinic_status_idx ON app_tasks(clinic_id, status, moderation_status);
CREATE INDEX IF NOT EXISTS qr_checkins_clinic_appointment_idx ON qr_checkins(clinic_id, appointment_id);
CREATE INDEX IF NOT EXISTS app_audit_logs_clinic_created_idx ON app_audit_logs(clinic_id, created_at DESC);

-- 6. Row-level security for new tables.
ALTER TABLE clinic_app_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE promotions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE qr_checkins ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_audit_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "clinic_app_settings_clinic_access" ON clinic_app_settings;
CREATE POLICY "clinic_app_settings_clinic_access" ON clinic_app_settings
  FOR ALL USING (clinic_id IN (SELECT clinic_id FROM user_roles WHERE user_id = auth.uid()))
  WITH CHECK (clinic_id IN (SELECT clinic_id FROM user_roles WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS "promotions_clinic_access" ON promotions;
CREATE POLICY "promotions_clinic_access" ON promotions
  FOR ALL USING (clinic_id IN (SELECT clinic_id FROM user_roles WHERE user_id = auth.uid()))
  WITH CHECK (clinic_id IN (SELECT clinic_id FROM user_roles WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS "app_tasks_clinic_access" ON app_tasks;
CREATE POLICY "app_tasks_clinic_access" ON app_tasks
  FOR ALL USING (clinic_id IN (SELECT clinic_id FROM user_roles WHERE user_id = auth.uid()))
  WITH CHECK (clinic_id IN (SELECT clinic_id FROM user_roles WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS "qr_checkins_clinic_access" ON qr_checkins;
CREATE POLICY "qr_checkins_clinic_access" ON qr_checkins
  FOR ALL USING (clinic_id IN (SELECT clinic_id FROM user_roles WHERE user_id = auth.uid()))
  WITH CHECK (clinic_id IN (SELECT clinic_id FROM user_roles WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS "app_audit_logs_clinic_access" ON app_audit_logs;
CREATE POLICY "app_audit_logs_clinic_access" ON app_audit_logs
  FOR ALL USING (clinic_id IN (SELECT clinic_id FROM user_roles WHERE user_id = auth.uid()))
  WITH CHECK (clinic_id IN (SELECT clinic_id FROM user_roles WHERE user_id = auth.uid()));
