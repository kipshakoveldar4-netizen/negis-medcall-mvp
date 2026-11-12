-- NEGIS Migration 009 - MedCall MVP persistence
-- Stores demo workspaces, Targeting Agent campaign drafts, and campaign reports.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  owner_email text,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS targeting_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspaces(id),
  campaign_name text,
  niche text,
  city text,
  offer text,
  budget numeric,
  status text DEFAULT 'pending',
  raw_payload jsonb,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS targeting_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid REFERENCES targeting_campaigns(id),
  summary text,
  metrics jsonb,
  insights jsonb,
  recommendations jsonb,
  raw_payload jsonb,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS workspaces_owner_email_idx
  ON workspaces(owner_email);

CREATE INDEX IF NOT EXISTS targeting_campaigns_workspace_created_idx
  ON targeting_campaigns(workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS targeting_reports_campaign_created_idx
  ON targeting_reports(campaign_id, created_at DESC);
