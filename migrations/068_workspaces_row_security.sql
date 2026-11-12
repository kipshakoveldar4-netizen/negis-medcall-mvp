-- Explicitly reproduce the workspace boundary on a fresh database too.
-- Browser clients use Auth only; workspace data is served by authorized APIs.
begin;

alter table public.workspaces enable row level security;
revoke all on table public.workspaces from public, anon, authenticated;
grant select, insert, update, delete on table public.workspaces to service_role;

commit;
