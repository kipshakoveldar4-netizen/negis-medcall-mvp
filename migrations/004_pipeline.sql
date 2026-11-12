-- Migration 004: Add pipeline field to leads and lead_statuses
-- Run in Supabase SQL editor

-- 1. Add pipeline to leads
ALTER TABLE leads ADD COLUMN IF NOT EXISTS pipeline TEXT NOT NULL DEFAULT 'sales';

-- 2. Add pipeline to lead_statuses
ALTER TABLE lead_statuses ADD COLUMN IF NOT EXISTS pipeline TEXT NOT NULL DEFAULT 'sales';

-- 3. Indexes
CREATE INDEX IF NOT EXISTS leads_clinic_pipeline_created_idx
  ON leads (clinic_id, pipeline, created_at DESC);

CREATE INDEX IF NOT EXISTS lead_statuses_clinic_pipeline_idx
  ON lead_statuses (clinic_id, pipeline, sort_order);

-- 4. Check constraints (use DO block to avoid error if already exists)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'leads_pipeline_check'
  ) THEN
    ALTER TABLE leads ADD CONSTRAINT leads_pipeline_check
      CHECK (pipeline IN ('sales', 'booking'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'lead_statuses_pipeline_check'
  ) THEN
    ALTER TABLE lead_statuses ADD CONSTRAINT lead_statuses_pipeline_check
      CHECK (pipeline IN ('sales', 'booking'));
  END IF;
END $$;

-- 5. Seed booking pipeline statuses for every clinic that doesn't yet have them
INSERT INTO lead_statuses (clinic_id, name, color, sort_order, pipeline)
SELECT DISTINCT ON (ls.clinic_id, s.idx)
  ls.clinic_id, s.name, s.color, s.idx, 'booking'
FROM lead_statuses ls
CROSS JOIN (VALUES
  (0, 'Новый',          '#3B82F6'),
  (1, 'Нужно записать', '#F59E0B'),
  (2, 'Записан',        '#22C55E'),
  (3, 'Недозвон',       '#F97316'),
  (4, 'Отмена',         '#EF4444')
) AS s(idx, name, color)
WHERE NOT EXISTS (
  SELECT 1 FROM lead_statuses ls2
  WHERE ls2.clinic_id = ls.clinic_id AND ls2.pipeline = 'booking'
);
