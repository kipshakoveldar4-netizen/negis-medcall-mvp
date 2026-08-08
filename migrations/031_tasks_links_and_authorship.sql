-- NEGIS Migration 031 — a task belongs to something, and someone put it there.
--
-- `tasks` was created by 010 with six usable columns and has not been touched
-- since. Three things a CRM task needs are missing from it entirely, and one
-- that is present has been dead the whole time:
--
--   * no link to anything. A task cannot say which lead or which patient it is
--     about, so «what do I do next about this заявка» has nowhere to live —
--     the question the clinic actually opens the card to answer.
--   * no author. updated_at is overwritten on every touch, so who created a
--     task, who reassigned it and when it was closed cannot be recovered.
--   * no closing time, so «done today» and «overdue» are not computable.
--   * assignee_user_id EXISTS (010:81, a real FK to staff_users) and is written
--     by nothing: the server stores only the free-text assignee_name
--     (lib/crm/server.ts). «My tasks» is therefore not merely unimplemented,
--     it is unexpressible — there is no id to compare against. leads and deals
--     both settled this years ago with responsible_user_id; tasks is the last
--     entity where the assignee degraded into a string.
--
-- Shape follows deals (020), not audit_logs (029): three nullable foreign keys
-- rather than an entity_type/entity_id pair. The polymorphic form is right for
-- the journal, which describes rows it does not own and must accept kinds it
-- has never heard of. A task is not that — it is about at most one lead and at
-- most one patient (both, once the lead converts), and real foreign keys give
-- ON DELETE SET NULL, referential integrity and an index per link for free.
--
-- created_by_kind reuses the vocabulary the change journal already defines —
-- manual | integration | automation | system — because the product already
-- promises tasks nobody typed («Medina AI передаёт задачи ресепшну»), and a
-- list where an auto-generated follow-up is indistinguishable from one the
-- head nurse assigned is a list people stop trusting.
--
-- Privileges and RLS: 010 predates the 023 hardening. Its text says RLS is
-- deliberately off, while this repository's own security suite records the
-- opposite about production ("every one of them already has RLS enabled").
-- Both statements cannot be checked from here, so this migration is written to
-- be correct under either: enabling RLS on a table that already has it is a
-- no-op, and granting service_role privileges it may already hold is a no-op
-- too. Doing neither is the only option that is wrong under one of them.
-- No policies are added, so anon and authenticated stay denied — the post-023
-- rule, and 023 already revoked their table privileges anyway.
--
-- Nothing here is destructive: every column is additive and nullable, every
-- index and grant is idempotent, and no existing value is rewritten.

begin;

-- What the task is about. All nullable: a task can be standalone («заказать
-- расходники»), and a task from a lead card carries the lead, gaining the
-- client as well once that lead converts.
alter table public.tasks
  add column if not exists lead_id uuid references public.leads(id) on delete set null;

alter table public.tasks
  add column if not exists client_id uuid references public.clients(id) on delete set null;

alter table public.tasks
  add column if not exists appointment_id uuid references public.appointments(id) on delete set null;

-- Who put it there, and of what kind. The id is the verified membership; the
-- kind separates a person from an automation.
alter table public.tasks
  add column if not exists created_by_staff_user_id uuid references public.staff_users(id) on delete set null;

alter table public.tasks
  add column if not exists created_by_kind text;

-- When it stopped being work. Distinct from updated_at, which any edit moves.
alter table public.tasks
  add column if not exists completed_at timestamptz;

-- The queries this table is actually asked: what is open for me, what is
-- overdue, and what is attached to this record. 010 left only single-column
-- indexes on workspace_id, status and created_at.
create index if not exists tasks_workspace_assignee_idx
  on public.tasks(workspace_id, assignee_user_id);

create index if not exists tasks_workspace_due_at_idx
  on public.tasks(workspace_id, due_at);

create index if not exists tasks_workspace_lead_idx
  on public.tasks(workspace_id, lead_id)
  where lead_id is not null;

create index if not exists tasks_workspace_client_idx
  on public.tasks(workspace_id, client_id)
  where client_id is not null;

create index if not exists tasks_workspace_appointment_idx
  on public.tasks(workspace_id, appointment_id)
  where appointment_id is not null;

alter table public.tasks enable row level security;

grant select, insert, update
  on table public.tasks
  to service_role;

commit;
