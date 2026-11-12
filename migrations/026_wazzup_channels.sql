-- NEGIS Migration 026 — Wazzup inbound channel mapping and idempotency ledger.
--
-- Phase 1 of the Wazzup integration: an inbound WhatsApp message becomes a
-- lead in the workspace that owns the channel. Two tables:
--
--   wazzup_channels         maps a Wazzup channelId to a workspace. The webhook
--                           trusts nothing in the payload about tenancy: the
--                           channel row is the only authority, and an unknown
--                           channel is ignored without disclosure.
--   wazzup_inbound_messages ledger keyed by Wazzup messageId. Wazzup retries
--                           delivery until it sees 200, so a replayed webhook
--                           must be a no-op; the unique index is the guarantee.
--
-- Same rules as every post-023 migration: owner postgres, RLS on with no
-- policies (deny-all for anon/authenticated), explicit service_role grants —
-- a table created by postgres grants service_role nothing (the 024 lesson,
-- repaired forward in 025, enforced chain-wide by test:security1b 26).

begin;

create table if not exists public.wazzup_channels (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  channel_id text not null unique,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists wazzup_channels_workspace_idx
  on public.wazzup_channels(workspace_id);

create table if not exists public.wazzup_inbound_messages (
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

create index if not exists wazzup_inbound_messages_workspace_idx
  on public.wazzup_inbound_messages(workspace_id);

alter table public.wazzup_channels enable row level security;
alter table public.wazzup_inbound_messages enable row level security;

revoke all on table public.wazzup_channels from anon, authenticated;
revoke all on table public.wazzup_inbound_messages from anon, authenticated;

grant select, insert, update, delete
  on table public.wazzup_channels
  to service_role;

grant select, insert, update, delete
  on table public.wazzup_inbound_messages
  to service_role;

commit;
