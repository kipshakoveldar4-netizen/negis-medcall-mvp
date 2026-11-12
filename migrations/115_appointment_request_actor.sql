-- Local candidate. Deploy with the v2 appointment API after draining old writers.
-- Never backfill ambiguous legacy receipts to the current staff account.
begin;
set local lock_timeout='3s';
set local statement_timeout='30s';

do $$ declare item record; relation text; begin
  if current_user<>'postgres'
    or not exists(select 1 from pg_roles where rolname='service_role' and rolbypassrls and not rolsuper)
    or exists(select 1 from pg_roles b cross join pg_roles p where b.rolname in ('anon','authenticated')
      and (p.rolsuper or p.rolbypassrls or p.rolname='postgres') and pg_has_role(b.oid,p.oid,'MEMBER'))
    then raise exception 'appointment_actor_dependencies_unconfirmed'; end if;
  foreach relation in array array['staff_users','clinic_doctors','appointments','crm_appointment_create_requests'] loop
    if not exists(select 1 from pg_class where oid=to_regclass('public.'||relation) and relowner=to_regrole('postgres') and relkind='r' and not relispartition)
      then raise exception 'appointment_actor_dependencies_unconfirmed'; end if;
  end loop;
  if not exists(select 1 from pg_class c where c.oid='public.crm_appointment_create_requests'::regclass and c.relrowsecurity
    and not exists(select 1 from pg_policy where polrelid=c.oid)
    and not exists(select 1 from pg_trigger where tgrelid=c.oid and not tgisinternal)
    and not exists(select 1 from pg_inherits where inhrelid=c.oid or inhparent=c.oid))
    or exists(select 1 from pg_roles where rolname in ('anon','authenticated','service_role') and
      (has_table_privilege(oid,'public.crm_appointment_create_requests','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      or has_any_column_privilege(oid,'public.crm_appointment_create_requests','SELECT,INSERT,UPDATE,REFERENCES')))
    then raise exception 'appointment_actor_receipt_access_unconfirmed'; end if;
  if not exists(select 1 from pg_index where indexrelid=to_regclass('public.clinic_doctors_workspace_staff_user_idx')
    and indrelid='public.clinic_doctors'::regclass and indisunique and indisvalid and indisready and indnkeyatts=2
    and pg_get_indexdef(indexrelid,1,true)='workspace_id' and pg_get_indexdef(indexrelid,2,true)='staff_user_id'
    and pg_get_expr(indpred,indrelid)='(staff_user_id IS NOT NULL)')
    then raise exception 'appointment_actor_doctor_identity_unconfirmed'; end if;
  for item in select * from (values
    ('public.create_crm_appointment_with_new_client(uuid,jsonb,jsonb)','11bb49a22da2ff5367e4769dd67f1c6857434f765a5798d0666508cc8bca7584'),
    ('public.read_crm_appointment_create_request(uuid,uuid,uuid,text)','b45a42ef82367c39b6b875e7806a919c3173547230083eb0bb3b4b3d9e6bbf9d'),
    ('public.create_crm_appointment_once(uuid,uuid,uuid,text,jsonb,jsonb,text)','1e022dfa25d8e091a472cf5c5c429fe8210bbd3d7faddbc1ca7db60e49561a7a')
  )v(signature,digest) loop
    if not exists(select 1 from pg_proc p where p.oid=to_regprocedure(item.signature) and p.proowner=to_regrole('postgres')
      and p.prosecdef and p.provolatile='v' and p.proconfig=array['search_path=""']::text[]
      and encode(sha256(convert_to(replace(p.prosrc,E'\r\n',E'\n'),'UTF8')),'hex')=item.digest)
      then raise exception 'appointment_actor_dependencies_unconfirmed'; end if;
  end loop;
  if to_regclass('public.crm_appointment_request_actors') is not null
    then raise exception 'appointment_actor_already_installed_requires_review'; end if;
end $$;

create table public.crm_appointment_request_actors (
  workspace_id uuid not null,
  staff_user_id uuid not null,
  request_key uuid not null,
  auth_user_id uuid not null,
  primary key(workspace_id,staff_user_id,request_key),
  foreign key(workspace_id,staff_user_id,request_key)
    references public.crm_appointment_create_requests(workspace_id,staff_user_id,request_key) on delete cascade
);
alter table public.crm_appointment_request_actors enable row level security;
revoke all on public.crm_appointment_request_actors from public,anon,authenticated,service_role;

-- Pin current authority through the domain transaction, including a change from
-- one allowed role to another: HTTP privacy decisions must not use a stale role.
-- Doctor locks precede appointment locks, matching the capacity trigger order.
create function public.lock_crm_appointment_actor(p_workspace uuid,p_staff uuid,p_actor uuid,p_role text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare staff public.staff_users; doctor public.clinic_doctors; names text[];
begin
  if current_setting('transaction_isolation')<>'read committed'
    then raise exception using errcode='P6405',message='appointment_actor_snapshot_unconfirmed'; end if;
  if p_workspace is null or p_staff is null or p_actor is null or p_role is null
    or p_role not in ('owner','admin','receptionist','manager','doctor')
    then raise exception using errcode='P6404',message='appointment_request_access_denied'; end if;
  select * into staff from public.staff_users where id=p_staff for share;
  if not found or staff.workspace_id is distinct from p_workspace or staff.auth_user_id is distinct from p_actor
    or staff.status is distinct from 'active' or staff.role is distinct from p_role
    then raise exception using errcode='P6404',message='appointment_request_access_denied'; end if;
  if p_role<>'doctor' then return jsonb_build_object('role',p_role); end if;
  select * into doctor from public.clinic_doctors where workspace_id=p_workspace and staff_user_id=p_staff for update;
  select array_agg(distinct normalized) into names from (
    select lower(btrim(staff.full_name)) normalized union all select lower(btrim(doctor.full_name)) union all
    select lower(btrim(doctor_name)) from (select doctor_name from public.appointments
      where workspace_id=p_workspace and doctor_id=doctor.id limit 200) history
  ) candidate where normalized is not null and normalized<>'';
  if doctor.id is null and coalesce(cardinality(names),0)=0
    then raise exception using errcode='P6404',message='appointment_request_access_denied'; end if;
  return jsonb_build_object('role',p_role,'doctorId',doctor.id,'names',coalesce(to_jsonb(names),'[]'::jsonb));
end $$;

create function public.crm_appointment_targets_actor(p_identity jsonb,p_appointment jsonb)
returns boolean language sql immutable set search_path='' as $$
  select case when p_identity->>'role'<>'doctor' then true else
    (coalesce(p_appointment->>'doctor_id','')='' or p_appointment->>'doctor_id'=p_identity->>'doctorId')
    and (coalesce(btrim(p_appointment->>'doctor_name'),'')='' or
      (p_identity->'names') ? lower(btrim(p_appointment->>'doctor_name')))
    and (coalesce(p_appointment->>'doctor_id','')<>'' or coalesce(btrim(p_appointment->>'doctor_name'),'')<>'') end
$$;

create function public.read_crm_appointment_request_v2(p_workspace_id uuid,p_staff_user_id uuid,p_auth_user_id uuid,p_actor_role text,
  p_request_key uuid,p_request_fingerprint text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare identity jsonb; receipt jsonb; origin uuid; saved public.appointments;
begin
  if p_workspace_id is null or p_staff_user_id is null or p_request_key is null
    or p_request_fingerprint is null or p_request_fingerprint !~ '^[0-9a-f]{64}$'
    then raise exception using errcode='P6401',message='appointment_request_invalid'; end if;
  perform pg_advisory_xact_lock(hashtextextended('crm-appointment:'||p_workspace_id::text||':'||p_staff_user_id::text||':'||p_request_key::text,0));
  identity:=public.lock_crm_appointment_actor(p_workspace_id,p_staff_user_id,p_auth_user_id,p_actor_role);
  select a.auth_user_id into origin from public.crm_appointment_create_requests r
    left join public.crm_appointment_request_actors a using(workspace_id,staff_user_id,request_key)
    where r.workspace_id=p_workspace_id and r.staff_user_id=p_staff_user_id and r.request_key=p_request_key;
  if not found then return null; end if;
  if origin is null then raise exception using errcode='P6403',message='appointment_request_origin_unconfirmed'; end if;
  if origin is distinct from p_auth_user_id
    then raise exception using errcode='P6404',message='appointment_request_access_denied'; end if;
  receipt:=public.read_crm_appointment_create_request(p_workspace_id,p_staff_user_id,p_request_key,p_request_fingerprint);
  -- One fresh MVCC row is sufficient for readback. A row lock here would invert
  -- the editor's appointment -> capacity-doctor lock order and can deadlock.
  select * into saved from public.appointments where workspace_id=p_workspace_id and id=(receipt->'appointment'->>'id')::uuid;
  if not found then raise exception using errcode='P6403',message='appointment_request_unavailable'; end if;
  if public.crm_appointment_targets_actor(identity,to_jsonb(saved)) is distinct from true
    then raise exception using errcode='P6406',message='appointment_request_access_denied'; end if;
  return jsonb_set(receipt,'{appointment}',to_jsonb(saved));
end $$;

create function public.create_crm_appointment_v2(p_workspace_id uuid,p_staff_user_id uuid,p_auth_user_id uuid,p_actor_role text,
  p_request_key uuid,p_request_fingerprint text,p_new_client jsonb,p_appointment jsonb,p_client_match text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare identity jsonb; result jsonb;
begin
  result:=public.read_crm_appointment_request_v2(p_workspace_id,p_staff_user_id,p_auth_user_id,p_actor_role,p_request_key,p_request_fingerprint);
  if result is not null then return result; end if;
  identity:=public.lock_crm_appointment_actor(p_workspace_id,p_staff_user_id,p_auth_user_id,p_actor_role);
  if public.crm_appointment_targets_actor(identity,p_appointment) is distinct from true
    then raise exception using errcode='P6404',message='appointment_request_access_denied'; end if;
  result:=public.create_crm_appointment_once(p_workspace_id,p_staff_user_id,p_request_key,p_request_fingerprint,p_new_client,p_appointment,p_client_match);
  if result->>'replayed' is distinct from 'false'
    then raise exception using errcode='P6403',message='appointment_request_origin_unconfirmed'; end if;
  insert into public.crm_appointment_request_actors(workspace_id,staff_user_id,request_key,auth_user_id)
    values(p_workspace_id,p_staff_user_id,p_request_key,p_auth_user_id);
  return result;
end $$;

revoke all on function public.lock_crm_appointment_actor(uuid,uuid,uuid,text),
  public.crm_appointment_targets_actor(jsonb,jsonb),
  public.read_crm_appointment_request_v2(uuid,uuid,uuid,text,uuid,text),
  public.create_crm_appointment_v2(uuid,uuid,uuid,text,uuid,text,jsonb,jsonb,text),
  public.read_crm_appointment_create_request(uuid,uuid,uuid,text),
  public.create_crm_appointment_once(uuid,uuid,uuid,text,jsonb,jsonb,text),
  public.create_crm_appointment_with_new_client(uuid,jsonb,jsonb)
  from public,anon,authenticated,service_role;
grant execute on function public.read_crm_appointment_request_v2(uuid,uuid,uuid,text,uuid,text),
  public.create_crm_appointment_v2(uuid,uuid,uuid,text,uuid,text,jsonb,jsonb,text) to service_role;
comment on table public.crm_appointment_request_actors is 'Immutable creation actor provenance, no payloads or contacts. Legacy receipts are not adopted.';
commit;
notify pgrst,'reload schema';
