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

begin;

-- Browser roles and PUBLIC must not create objects in the application schema.
revoke create on schema public from public;
revoke create on schema public from anon;
revoke create on schema public from authenticated;

-- Remove existing public table/view/materialized-view privileges from browser
-- roles. PostgreSQL's ALL TABLES form covers table-like relations in the
-- selected schema.
revoke all privileges
on all tables in schema public
from anon, authenticated;

-- No browser sequence access is required. This is currently a no-op because
-- public contains no sequences, but it also protects objects that might be
-- present when the migration is replayed in another environment.
revoke all privileges
on all sequences in schema public
from anon, authenticated;

-- No database RPC is intentionally browser-callable.
--
-- This removes inherited EXECUTE exposure from maintenance and trigger helper
-- functions such as seed_default_lead_taxonomy*. Trigger execution does not
-- require the invoking user to hold EXECUTE on the trigger function.
revoke all privileges
on all functions in schema public
from public, anon, authenticated;

-- Future objects created by postgres must not be exposed automatically.
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

-- Future objects may also be created by supabase_admin. Its defaults must be
-- hardened independently.
alter default privileges
for role supabase_admin
in schema public
revoke all on tables from anon, authenticated;

alter default privileges
for role supabase_admin
in schema public
revoke all on sequences from anon, authenticated;

alter default privileges
for role supabase_admin
in schema public
revoke execute on functions from public, anon, authenticated;

-- Keep server-side access intact. This does not grant browser access.
grant usage on schema public to service_role;

commit;
