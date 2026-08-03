-- NEGIS Migration 027 — WhatsApp Cloud API inbound: number mapping and ledger.
--
-- Phase 2 of the WhatsApp integration (§14): the same inbound pipeline as
-- Wazzup — an inbound message becomes a lead in the workspace that owns the
-- channel — fed by Meta's official Cloud API instead of an intermediary.
-- The mirror of migration 026, one table pair per provider:
--
--   whatsapp_cloud_numbers           maps a Cloud API phone_number_id (the
--                                    value Meta sends in metadata.phone_number_id
--                                    of every webhook) to a workspace. The
--                                    webhook trusts nothing in the payload
--                                    about tenancy: this row is the only
--                                    authority, and an unknown number is
--                                    ignored without disclosure.
--   whatsapp_cloud_inbound_messages  ledger keyed by the message id (wamid).
--                                    Meta retries delivery until it sees 200,
--                                    so a replayed webhook must be a no-op;
--                                    the unique index is the guarantee.
--                                    channel_id stores the phone_number_id the
--                                    message arrived through — the column name
--                                    matches the wazzup ledger so both feed
--                                    one processing core.
--
-- Same rules as every post-023 migration: owner postgres, RLS on with no
-- policies (deny-all for anon/authenticated), explicit service_role grants —
-- a table created by postgres grants service_role nothing (the 024 lesson,
-- repaired forward in 025, enforced chain-wide by test:security1b).

begin;

create table if not exists public.whatsapp_cloud_numbers (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  phone_number_id text not null unique,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists whatsapp_cloud_numbers_workspace_idx
  on public.whatsapp_cloud_numbers(workspace_id);

create table if not exists public.whatsapp_cloud_inbound_messages (
  id uuid primary key default gen_random_uuid(),
  message_id text not null unique,
  channel_id text not null,
  workspace_id uuid references public.workspaces(id) on delete cascade,
  lead_id uuid references public.leads(id) on delete set null,
  -- 'created'  — a new lead was filed for this message
  -- 'repeat'   — an open lead with the same phone already existed
  kind text not null default 'created',
  received_at timestamptz not null default now()
);

create index if not exists whatsapp_cloud_inbound_messages_workspace_idx
  on public.whatsapp_cloud_inbound_messages(workspace_id);

alter table public.whatsapp_cloud_numbers enable row level security;
alter table public.whatsapp_cloud_inbound_messages enable row level security;

revoke all on table public.whatsapp_cloud_numbers from anon, authenticated;
revoke all on table public.whatsapp_cloud_inbound_messages from anon, authenticated;

grant select, insert, update, delete
  on table public.whatsapp_cloud_numbers
  to service_role;

grant select, insert, update, delete
  on table public.whatsapp_cloud_inbound_messages
  to service_role;

commit;
