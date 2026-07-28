-- Security-1B: remove browser-role access to the public Data API.
--
-- Verified architecture:
-- - browser clients use Supabase Auth;
-- - signed Storage uploads use the storage schema;
-- - no active frontend public-table, RPC, or Realtime access exists;
-- - customer data is accessed through service-role-backed server APIs.
--
-- Scope:
-- - public schema only;
-- - auth, storage, graphql_public and realtime are untouched.
--
-- Owner boundary:
-- - application migrations and current public application objects use postgres;
-- - the project postgres role cannot alter default privileges owned by
--   supabase_admin;
-- - supabase_admin defaults are a documented platform-owner residual and must
--   not be treated as application-migration authority.

begin;

-- Browser roles and PUBLIC must not create objects in the application schema.
revoke create on schema public from public;
revoke create on schema public from anon;
revoke create on schema public from authenticated;

-- Remove existing public table/view/materialized-view privileges from browser
-- roles. PostgreSQL's ALL TABLES form covers table-like relations in public.
revoke all privileges
on all tables in schema public
from anon, authenticated;

-- No browser sequence access is required.
revoke all privileges
on all sequences in schema public
from anon, authenticated;

-- No database RPC is intentionally browser-callable.
--
-- Trigger execution does not require the invoking user to hold EXECUTE on the
-- trigger function.
revoke all privileges
on all functions in schema public
from public, anon, authenticated;

-- Future application objects created by postgres must not be exposed.
alter default privileges
for role postgres
in schema public
revoke all on tables from anon, authenticated;

alter default privileges
for role postgres
in schema public
revoke all on sequences from anon, authenticated;

alter default privileges
for role postgres
in schema public
revoke execute on functions from public, anon, authenticated;

-- Keep server-side schema access intact.
grant usage on schema public to service_role;

commit;
