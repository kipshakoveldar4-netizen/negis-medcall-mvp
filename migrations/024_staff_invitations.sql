-- 024_staff_invitations.sql
--
-- Commercial-3B — the enrollment flow the staff endpoint has been refusing.
--
-- POST /api/crm/staff answers 409 staff_invitation_required because there was no
-- verified way to tie an email to a Supabase Auth user: accepting an
-- auth_user_id from the browser would let any authorized administrator mint a
-- membership for any account. An invitation closes that gap — the workspace
-- names an email and a role, and the person who proves control of that email
-- through Supabase Auth is the one who becomes a member.
--
-- Only the hash of the token is stored. A leaked database row cannot be
-- redeemed, and the plaintext exists exactly once, in the response to the
-- administrator who created it.

begin;

create table if not exists staff_invitations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  email text not null,
  role text not null,
  token_hash text not null unique,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  accepted_staff_user_id uuid references staff_users(id) on delete set null,
  revoked_at timestamptz,
  invited_by_staff_user_id uuid references staff_users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_staff_invitations_workspace
  on staff_invitations(workspace_id);

create index if not exists idx_staff_invitations_email
  on staff_invitations(workspace_id, lower(email));

-- One live invitation per email per workspace. Re-inviting is allowed once the
-- previous one has been accepted, revoked or has expired, which keeps the list
-- an accurate picture of who is currently pending.
create unique index if not exists idx_staff_invitations_pending_unique
  on staff_invitations(workspace_id, lower(email))
  where accepted_at is null and revoked_at is null;

-- Same posture as migration 023: the Data API roles get nothing. Every read and
-- write goes through the serverless routes on the service-role client, after the
-- caller has been authorized.
revoke all on table staff_invitations from anon;
revoke all on table staff_invitations from authenticated;

-- RLS with no policies, which is deny-all for anyone who is not service_role.
-- The grants above already stop the Data API roles; this is the second lock, so
-- a future grant cannot quietly open the table on its own.
alter table staff_invitations enable row level security;

commit;
