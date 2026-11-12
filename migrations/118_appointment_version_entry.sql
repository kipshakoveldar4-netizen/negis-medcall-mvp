-- Local coordinated cutover only: close the precondition-free service entry.
begin;
set local lock_timeout='3s';
set local statement_timeout='30s';
lock table public.appointments in access share mode;
do $$ declare item record; begin
  if current_user<>'postgres'
    or not exists(select 1 from pg_roles where rolname='service_role' and rolbypassrls and not rolsuper)
    or not exists(select 1 from pg_class where oid=to_regclass('public.appointments') and relowner=to_regrole('postgres')
      and relkind='r' and not relispartition and relrowsecurity)
    or has_table_privilege('service_role','public.appointments','INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER')
    or has_any_column_privilege('service_role','public.appointments','INSERT,UPDATE')
    or not has_table_privilege('service_role','public.appointments','SELECT')
    or not exists(select 1 from pg_attribute where attrelid='public.appointments'::regclass and attname='edit_version'
      and not attisdropped and attnotnull and atttypid='uuid'::regtype)
    or not exists(select 1 from pg_trigger where tgrelid='public.appointments'::regclass and tgname='stamp_appointment_edit_version'
      and not tgisinternal and tgenabled='O' and tgtype=19 and tgqual is null and tgattr=''::int2vector
      and tgfoid=to_regprocedure('public.stamp_appointment_edit_version()'))
    then raise exception 'appointment_version_entry_dependencies_unconfirmed'; end if;
  for item in select * from (values
    ('public.patch_crm_appointment_as_actor(uuid,uuid,uuid,text,uuid,jsonb,jsonb)','e6f4e113b5e77a8896ae0c72ef7c9b6ae0a7179e015b587bb3a32a8256c26d81',true),
    ('public.stamp_appointment_edit_version()','33b58671e0af76e5a11b6654ab305a78c0baefebf8dda29a61f7db9dcc380e6b',false)
  )v(signature,digest,definer) loop
    if not exists(select 1 from pg_proc where oid=to_regprocedure(item.signature) and proowner=to_regrole('postgres')
      and prosecdef=item.definer and provolatile='v' and proconfig=array['search_path=""']::text[]
      and encode(sha256(convert_to(replace(prosrc,E'\r\n',E'\n'),'UTF8')),'hex')=item.digest)
      then raise exception 'appointment_version_entry_dependencies_unconfirmed'; end if;
  end loop;
  if to_regprocedure('public.patch_crm_appointment_v2(uuid,uuid,uuid,text,uuid,uuid,jsonb,jsonb)') is not null
    then raise exception 'appointment_version_entry_already_installed_requires_review'; end if;
end $$;
create function public.patch_crm_appointment_v2(p_workspace_id uuid,p_staff_user_id uuid,p_auth_user_id uuid,p_actor_role text,
  p_appointment_id uuid,p_expected_edit_version uuid,p_before jsonb,p_patch jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  if p_expected_edit_version is null then raise exception using errcode='P1181',message='appointment_edit_version_required'; end if;
  -- The original live actor/own-work checks precede CAS, even with a stale token.
  return public.patch_crm_appointment_as_actor(p_workspace_id,p_staff_user_id,p_auth_user_id,p_actor_role,p_appointment_id,
    p_before||jsonb_build_object('edit_version',p_expected_edit_version),p_patch);
end $$;
revoke all on function public.patch_crm_appointment_v2(uuid,uuid,uuid,text,uuid,uuid,jsonb,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.patch_crm_appointment_v2(uuid,uuid,uuid,text,uuid,uuid,jsonb,jsonb) to service_role;
revoke all on function public.patch_crm_appointment_as_actor(uuid,uuid,uuid,text,uuid,jsonb,jsonb) from public,anon,authenticated,service_role;
do $$ declare role_name text; begin
  foreach role_name in array array['anon','authenticated','service_role'] loop
    if has_function_privilege(role_name,'public.patch_crm_appointment_as_actor(uuid,uuid,uuid,text,uuid,jsonb,jsonb)','EXECUTE')
      or has_function_privilege(role_name,'public.patch_crm_appointment_v2(uuid,uuid,uuid,text,uuid,uuid,jsonb,jsonb)','EXECUTE')<>(role_name='service_role')
      then raise exception 'appointment_version_entry_legacy_access_unconfirmed'; end if;
  end loop;
end $$;
commit;
notify pgrst,'reload schema';
