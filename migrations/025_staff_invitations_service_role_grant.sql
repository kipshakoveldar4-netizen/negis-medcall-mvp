-- 025_staff_invitations_service_role_grant.sql
--
-- Forward repair for migration 024.
--
-- 024 created staff_invitations, enabled RLS and revoked the Data API roles, but
-- never granted the table to service_role. A table created by postgres does not
-- inherit one — migration 022 had to say so explicitly for
-- meta_insights_sync_state — so every invitation query failed after the route
-- had already authorized the caller. Production was repaired by hand once the
-- symptom appeared; this migration is what makes a fresh database arrive at the
-- same place from the migration chain alone.
--
-- 024 is left exactly as it was applied. Editing it would make the repository
-- describe a history that no environment actually ran, and would hide the
-- omission rather than correct it.
--
-- Scope is deliberately one table and one role:
--   * the owner stays postgres;
--   * RLS stays enabled, with no policies, which is deny-all for everyone the
--     service role is not;
--   * anon, authenticated and PUBLIC get nothing, here or anywhere;
--   * no default ACLs are touched, so this says nothing about future tables.
--
-- The privileges are the four the invitation handlers actually perform: select
-- for the list and the token lookup, insert for creation and for the membership
-- row's sibling write, update for revoke and for the single-use claim. Delete is
-- included because an invitation row is workspace data — a clinic that is
-- removed takes its invitations with it through the workspace cascade, and the
-- server must be able to execute that.
--
-- Idempotent: granting a privilege that is already held is a no-op, so this is
-- expected to change nothing in production and everything in a clean database.

begin;

grant select, insert, update, delete
  on table public.staff_invitations
  to service_role;

commit;
