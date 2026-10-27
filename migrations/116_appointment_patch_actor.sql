-- Local coordinated API/SQL candidate. Inventory the target and drain old writers.
begin;
set local lock_timeout='3s';
set local statement_timeout='30s';
do $$ declare item record; begin
  if current_user<>'postgres'
    or not exists(select 1 from pg_roles where rolname='service_role' and rolbypassrls and not rolsuper)
    or exists(select 1 from pg_roles b cross join pg_roles p where b.rolname in ('anon','authenticated')
      and (p.rolsuper or p.rolbypassrls or p.rolname='postgres') and pg_has_role(b.oid,p.oid,'MEMBER'))
    or not exists(select 1 from pg_class where oid=to_regclass('public.appointments') and relowner=to_regrole('postgres')
      and relkind='r' and not relispartition and relrowsecurity)
    or not has_table_privilege('service_role','public.appointments','SELECT')
    then raise exception 'appointment_patch_dependencies_unconfirmed'; end if;
  for item in select * from (values
    ('public.lock_crm_appointment_actor(uuid,uuid,uuid,text)','5ddd6ab57753045cbebc2c8494a03b11379bfffdfd7ff9c31a8076c97393973f',true,'v'),
    ('public.crm_appointment_targets_actor(jsonb,jsonb)','637235ede2ebb6c740d880ccc9a26a18717ff06d5391e882061655b7ea2438a8',false,'i'),
    ('public.guard_appointment_capacity()','73e57a6f89277b4fd543d709be37896c6876252d304be4c200ce0a1d56032a07',true,'v')
  )v(signature,digest,definer,volatility) loop
    if not exists(select 1 from pg_proc p where p.oid=to_regprocedure(item.signature) and p.proowner=to_regrole('postgres')
      and p.proconfig=array['search_path=""']::text[] and p.prosecdef=item.definer and p.provolatile::text=item.volatility
      and encode(sha256(convert_to(replace(p.prosrc,E'\r\n',E'\n'),'UTF8')),'hex')=item.digest)
      then raise exception 'appointment_patch_dependencies_unconfirmed'; end if;
  end loop;
  if to_regprocedure('public.patch_crm_appointment_as_actor(uuid,uuid,uuid,text,uuid,jsonb,jsonb)') is not null
    then raise exception 'appointment_patch_already_installed_requires_review'; end if;
end $$;

create function public.patch_crm_appointment_as_actor(p_workspace_id uuid,p_staff_user_id uuid,p_auth_user_id uuid,p_actor_role text,
  p_appointment_id uuid,p_before jsonb,p_patch jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare staff public.staff_users; current_row public.appointments; expected_row public.appointments;
  next_row public.appointments; identity jsonb; assignments text;
begin
  if current_setting('transaction_isolation')<>'read committed'
    then raise exception using errcode='P1165',message='appointment_patch_snapshot_unconfirmed'; end if;
  if p_workspace_id is null or p_staff_user_id is null or p_auth_user_id is null
    or p_actor_role is null or p_actor_role not in ('owner','admin','receptionist','manager','doctor')
    then raise exception using errcode='P1162',message='appointment_patch_access_denied'; end if;
  -- Match the original HTTP authority, not just any currently authorized role.
  select * into staff from public.staff_users where id=p_staff_user_id for share;
  if not found or staff.workspace_id is distinct from p_workspace_id or staff.auth_user_id is distinct from p_auth_user_id
    or staff.status is distinct from 'active' or staff.role is distinct from p_actor_role
    then raise exception using errcode='P1162',message='appointment_patch_access_denied'; end if;
  if p_appointment_id is null or jsonb_typeof(p_patch) is distinct from 'object' or p_patch='{}'::jsonb
    or exists(select 1 from jsonb_object_keys(p_patch) k where k<>all(array[
      'client_id','client_name','client_phone','whatsapp','service','service_id','service_items','doctor_id','doctor_name',
      'starts_at','duration_minutes','price_minor','status','notes','source','updated_at']))
    or (p_actor_role='doctor' and p_patch ?| array['client_phone','whatsapp'])
    then raise exception using errcode='P1161',message='appointment_patch_invalid'; end if;
  select * into current_row from public.appointments where workspace_id=p_workspace_id and id=p_appointment_id for update;
  if not found then raise exception using errcode='P1163',message='appointment_patch_unavailable'; end if;
  -- Editors take appointment -> doctor locks, matching the capacity trigger.
  -- The create/replay protocol takes no exclusive lock on an existing visit.
  identity:=public.lock_crm_appointment_actor(p_workspace_id,p_staff_user_id,p_auth_user_id,p_actor_role);
  if public.crm_appointment_targets_actor(identity,to_jsonb(current_row)) is distinct from true
    then raise exception using errcode='P1163',message='appointment_patch_unavailable'; end if;
  if jsonb_typeof(p_before) is distinct from 'object' or p_before->>'id' is distinct from p_appointment_id::text
    or p_before->>'workspace_id' is distinct from p_workspace_id::text
    then raise exception using errcode='P1164',message='appointment_patch_conflict'; end if;
  -- Compare typed rows, not timestamp strings or only updated_at. This also
  -- catches writers which reuse a version while changing a field.
  expected_row:=jsonb_populate_record(null::public.appointments,p_before);
  if expected_row is distinct from current_row
    then raise exception using errcode='P1164',message='appointment_patch_conflict'; end if;
  next_row:=jsonb_populate_record(current_row,p_patch);
  if public.crm_appointment_targets_actor(identity,to_jsonb(next_row)) is distinct from true
    then raise exception using errcode='P1162',message='appointment_patch_access_denied'; end if;
  if next_row.client_id is not null then
    perform 1 from public.clients where workspace_id=p_workspace_id and id=next_row.client_id;
    if not found then raise exception using errcode='P1161',message='appointment_patch_invalid'; end if;
  end if;
  if next_row.service_id is not null then
    perform 1 from public.clinic_services where workspace_id=p_workspace_id and id=next_row.service_id;
    if not found then raise exception using errcode='P1161',message='appointment_patch_invalid'; end if;
  end if;
  if next_row.doctor_id is not null then
    perform 1 from public.clinic_doctors where workspace_id=p_workspace_id and id=next_row.doctor_id;
    if not found then raise exception using errcode='P1161',message='appointment_patch_invalid'; end if;
  end if;
  next_row.updated_at:=clock_timestamp();
  -- Only offered columns fire UPDATE OF triggers. Names come solely from the
  -- whitelist above; values and both tenant keys remain bound SQL parameters.
  select string_agg(format('%1$I=($1).%1$I',k),',' order by k) into assignments
    from jsonb_object_keys(p_patch||'{"updated_at":null}'::jsonb) k;
  execute 'update public.appointments set '||assignments||' where workspace_id=$2 and id=$3'
    using next_row,p_workspace_id,p_appointment_id;
  -- AFTER triggers may set arrival_sale_id through their own UPDATE. Read it
  -- inside this transaction, not through an unguarded post-commit service read.
  select * into current_row from public.appointments where workspace_id=p_workspace_id and id=p_appointment_id;
  return to_jsonb(current_row);
end $$;
revoke all on function public.patch_crm_appointment_as_actor(uuid,uuid,uuid,text,uuid,jsonb,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.patch_crm_appointment_as_actor(uuid,uuid,uuid,text,uuid,jsonb,jsonb) to service_role;
-- Old API addresses must not bypass actor RPCs through direct service DML.
revoke insert,update,delete on public.appointments from service_role;
do $$ begin
  if has_table_privilege('service_role','public.appointments','INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER')
    or has_any_column_privilege('service_role','public.appointments','INSERT,UPDATE')
    then raise exception 'appointment_patch_legacy_write_access_unconfirmed'; end if;
end $$;
commit;
notify pgrst,'reload schema';
