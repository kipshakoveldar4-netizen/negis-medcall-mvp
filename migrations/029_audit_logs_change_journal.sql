-- NEGIS Migration 029 — audit_logs becomes the change journal it was declared to be.
--
-- The table was created by 010 and has been empty and unreferenced ever since:
-- across the whole repository the name appears three times in DDL and once in a
-- document that calls it «база для будущего журнала действий». This migration
-- is that future, and it repairs the table forward instead of editing 010.
--
-- Three gaps in the original shape made it unusable as a journal:
--
--   1. Only a display snapshot of the actor (actor_name, actor_role). A snapshot
--      is right — a renamed employee must not rewrite last year's history — but
--      without an id the entries cannot be re-attributed, filtered by person, or
--      anonymised when a member leaves. actor_staff_user_id adds the id and
--      keeps the snapshot.
--   2. No way to tell a person's edit from a webhook's. Every CRM lead can also
--      arrive from WhatsApp, and a journal that shows «Ресепшн» for a message
--      Meta delivered is worse than no journal. actor_kind separates them.
--   3. Reading one record's history meant scanning the workspace by created_at.
--      The composite index is the access path the panel actually uses.
--
-- Privileges: 010 predates the 023 hardening and grants service_role nothing
-- explicitly. Its sibling tables from the same migration serve production every
-- day, so the grant below is very likely a no-op — but "very likely" is not a
-- basis for a write path, and stating it costs nothing and removes the doubt on
-- a fresh database. RLS follows the post-023 rule: on, with no policies, so
-- anon and authenticated are denied and service_role passes by bypass.

begin;

alter table public.audit_logs
  add column if not exists actor_staff_user_id uuid references public.staff_users(id) on delete set null;

-- manual      — a signed-in member changed the record through the CRM
-- integration — an inbound webhook (WhatsApp Cloud, Wazzup) wrote it
-- automation  — a scheduled job or AI action
-- system      — a migration or repair
alter table public.audit_logs
  add column if not exists actor_kind text;

-- The panel asks one question: what happened to THIS record, newest first.
create index if not exists audit_logs_entity_idx
  on public.audit_logs(workspace_id, entity_type, entity_id, created_at desc);

alter table public.audit_logs enable row level security;

grant select, insert
  on table public.audit_logs
  to service_role;

commit;
