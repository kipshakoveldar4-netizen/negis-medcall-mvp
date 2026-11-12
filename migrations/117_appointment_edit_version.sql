-- Coordinated local candidate: current API/UI require a frozen edit version.
begin;
set local lock_timeout='3s';
set local statement_timeout='30s';
lock table public.appointments in access exclusive mode;
do $$ begin
  if current_user<>'postgres'
    or not exists(select 1 from pg_class where oid=to_regclass('public.appointments') and relowner=to_regrole('postgres')
      and relkind='r' and not relispartition and relrowsecurity)
    or exists(select 1 from pg_inherits where inhrelid='public.appointments'::regclass or inhparent='public.appointments'::regclass)
    or not exists(select 1 from pg_roles where rolname='service_role' and rolbypassrls and not rolsuper)
    or not has_table_privilege('service_role','public.appointments','SELECT')
    or has_table_privilege('service_role','public.appointments','INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER')
    or has_any_column_privilege('service_role','public.appointments','INSERT,UPDATE')
    or not exists(select 1 from pg_proc where oid=to_regprocedure('public.patch_crm_appointment_as_actor(uuid,uuid,uuid,text,uuid,jsonb,jsonb)')
      and proowner=to_regrole('postgres') and prosecdef and provolatile='v' and proconfig=array['search_path=""']::text[]
      and encode(sha256(convert_to(replace(prosrc,E'\r\n',E'\n'),'UTF8')),'hex')='e6f4e113b5e77a8896ae0c72ef7c9b6ae0a7179e015b587bb3a32a8256c26d81')
    or exists(select 1 from pg_trigger where tgrelid='public.appointments'::regclass and not tgisinternal
      and (tgtype::int & 19)=19 and tgname not in ('guard_appointment_capacity','stamp_appointment_edit_version'))
    then raise exception 'appointment_edit_version_dependencies_unconfirmed'; end if;
  if exists(select 1 from pg_attribute where attrelid='public.appointments'::regclass and attname='edit_version' and not attisdropped)
    or to_regprocedure('public.stamp_appointment_edit_version()') is not null
    or exists(select 1 from pg_trigger where tgrelid='public.appointments'::regclass and tgname='stamp_appointment_edit_version')
    then raise exception 'appointment_edit_version_already_installed_requires_review'; end if;
end $$;
-- A constant fast default gives old rows a version without rewriting their
-- tuples. Future inserts get independent UUIDs, so delete/recreate is not ABA.
alter table public.appointments add column edit_version uuid not null default '00000000-0000-0000-0000-000000000000'::uuid;
alter table public.appointments alter column edit_version set default pg_catalog.gen_random_uuid();
create function public.stamp_appointment_edit_version() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
  new.edit_version:=pg_catalog.gen_random_uuid();
  return new;
end $$;
revoke all on function public.stamp_appointment_edit_version() from public,anon,authenticated,service_role;
create trigger stamp_appointment_edit_version before update on public.appointments
  for each row execute function public.stamp_appointment_edit_version();
commit;
notify pgrst,'reload schema';
