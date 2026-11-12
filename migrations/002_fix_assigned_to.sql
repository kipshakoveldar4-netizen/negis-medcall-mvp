-- ============================================================
-- NEGIS Migration 002 — Fix leads.assigned_to FK & data
-- Run in Supabase Dashboard → SQL Editor
-- Safe to run multiple times
-- ============================================================

-- Step 1: Where assigned_to stores a user_id (auth.users UUID) instead of
--         agents.id, convert it to the correct agents.id within the same clinic.
UPDATE leads l
SET assigned_to = a.id
FROM agents a
WHERE l.assigned_to = a.user_id
  AND a.clinic_id = l.clinic_id
  AND l.assigned_to IS NOT NULL;

-- Step 2: NULL out any remaining assigned_to values that still don't
--         reference a real agents.id (stale/deleted agents, cross-clinic refs, etc.)
UPDATE leads l
SET assigned_to = NULL
WHERE l.assigned_to IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM agents a WHERE a.id = l.assigned_to
  );

-- Step 3: Ensure the FK constraint exists and points to agents(id).
--         Drop and recreate so it's correct even if it was set up wrong.
ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_assigned_to_fkey;

ALTER TABLE leads
  ADD CONSTRAINT leads_assigned_to_fkey
  FOREIGN KEY (assigned_to)
  REFERENCES agents(id)
  ON DELETE SET NULL;

-- ============================================================
-- Done. All assigned_to values are now valid agents.id or NULL.
-- ============================================================
