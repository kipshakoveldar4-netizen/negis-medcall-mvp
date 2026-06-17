-- ============================================================
-- NEGIS Migration 003 — Fix FK constraints to ON DELETE SET NULL
-- Run in Supabase Dashboard → SQL Editor
-- Safe to run multiple times
-- Fixes: cannot delete lead_statuses, booking_statuses, services, agents
-- ============================================================

-- leads.status_id → lead_statuses(id)
ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_status_id_fkey;
ALTER TABLE leads
  ADD CONSTRAINT leads_status_id_fkey
  FOREIGN KEY (status_id) REFERENCES lead_statuses(id) ON DELETE SET NULL;

-- leads.assigned_to → agents(id)
ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_assigned_to_fkey;
ALTER TABLE leads
  ADD CONSTRAINT leads_assigned_to_fkey
  FOREIGN KEY (assigned_to) REFERENCES agents(id) ON DELETE SET NULL;

-- bookings.status_id → booking_statuses(id)
ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_status_id_fkey;
ALTER TABLE bookings
  ADD CONSTRAINT bookings_status_id_fkey
  FOREIGN KEY (status_id) REFERENCES booking_statuses(id) ON DELETE SET NULL;

-- bookings.service_id → services(id)
ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_service_id_fkey;
ALTER TABLE bookings
  ADD CONSTRAINT bookings_service_id_fkey
  FOREIGN KEY (service_id) REFERENCES services(id) ON DELETE SET NULL;

-- bookings.agent_id → agents(id)
ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_agent_id_fkey;
ALTER TABLE bookings
  ADD CONSTRAINT bookings_agent_id_fkey
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE SET NULL;

-- ============================================================
-- Done. Deleting a status/service/agent will now automatically
-- set the reference to NULL instead of throwing an error.
-- ============================================================
