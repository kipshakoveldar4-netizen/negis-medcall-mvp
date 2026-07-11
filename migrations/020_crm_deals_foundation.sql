-- Negis CRM9: clinic sales/deals foundation.
-- Apply after 019_crm_lead_pipeline_foundation.sql. New table only — no backfill,
-- no changes to existing leads/clients/appointments rows, no RLS changes.
-- UI term is «Продажи»; the table is named `deals` because it stores the full
-- lifecycle (pending → paid/cancelled/refunded), not only completed sales.
-- amount_minor holds money in minor units (KZT tiyn), matching budget_*_minor.
-- Revenue is counted only from status = 'paid' deals by paid_at.

create table if not exists public.deals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  client_id uuid references public.clients(id) on delete set null,
  lead_id uuid references public.leads(id) on delete set null,
  appointment_id uuid references public.appointments(id) on delete set null,
  meta_campaign_launch_id uuid references public.meta_campaign_launches(id) on delete set null,
  title text not null,
  amount_minor bigint not null default 0 check (amount_minor >= 0),
  currency text not null default 'KZT',
  status text not null default 'pending' check (status in ('pending', 'paid', 'cancelled', 'refunded')),
  paid_at timestamptz,
  closed_at timestamptz,
  payment_method text,
  responsible_user_id uuid references public.staff_users(id) on delete set null,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists deals_workspace_status_idx
  on public.deals(workspace_id, status);
create index if not exists deals_workspace_paid_at_idx
  on public.deals(workspace_id, paid_at desc);
create index if not exists deals_workspace_client_idx
  on public.deals(workspace_id, client_id);
create index if not exists deals_workspace_lead_idx
  on public.deals(workspace_id, lead_id);
create index if not exists deals_workspace_appointment_idx
  on public.deals(workspace_id, appointment_id);
create index if not exists deals_workspace_meta_campaign_launch_idx
  on public.deals(workspace_id, meta_campaign_launch_id);
create index if not exists deals_workspace_created_at_idx
  on public.deals(workspace_id, created_at desc);
