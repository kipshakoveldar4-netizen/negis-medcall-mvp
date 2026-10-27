-- Coordinated local API/SQL candidate: a PATCH and its journal commit together.
begin;
set local lock_timeout='3s';
set local statement_timeout='30s';
lock table public.appointments,public.audit_logs in access share mode;
do $$ declare item record; begin
  if current_user<>'postgres'
    or not exists(select 1 from pg_class where oid=to_regclass('public.audit_logs') and relowner=to_regrole('postgres')
      and relkind='r' and not relispartition and relrowsecurity and not relforcerowsecurity)
    or exists(select 1 from pg_trigger where tgrelid=to_regclass('public.audit_logs') and not tgisinternal)
    or exists(select 1 from pg_policy where polrelid=to_regclass('public.audit_logs'))
    or exists(select 1 from pg_roles r where r.rolname in ('anon','authenticated') and
      (has_table_privilege(r.oid,'public.audit_logs','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        or has_any_column_privilege(r.oid,'public.audit_logs','SELECT,INSERT,UPDATE,REFERENCES')))
    or has_function_privilege('service_role','public.patch_crm_appointment_as_actor(uuid,uuid,uuid,text,uuid,jsonb,jsonb)','EXECUTE')
    or not has_function_privilege('service_role','public.patch_crm_appointment_v2(uuid,uuid,uuid,text,uuid,uuid,jsonb,jsonb)','EXECUTE')
    or has_table_privilege('service_role','public.appointments','INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER')
    or has_any_column_privilege('service_role','public.appointments','INSERT,UPDATE')
    then raise exception 'appointment_patch_journal_dependencies_unconfirmed'; end if;
  for item in select * from (values
    ('id','uuid'),('workspace_id','uuid'),('actor_name','text'),('actor_role','text'),('actor_staff_user_id','uuid'),
    ('actor_kind','text'),('action','text'),('entity_type','text'),('entity_id','text'),('metadata','jsonb'),('created_at','timestamp with time zone')
  )v(name,type_name) loop
    if not exists(select 1 from pg_attribute where attrelid='public.audit_logs'::regclass and attname=item.name
      and not attisdropped and atttypid=to_regtype(item.type_name))
      then raise exception 'appointment_patch_journal_dependencies_unconfirmed'; end if;
  end loop;
  if not exists(select 1 from pg_proc where oid=to_regprocedure('public.patch_crm_appointment_v2(uuid,uuid,uuid,text,uuid,uuid,jsonb,jsonb)')
    and proowner=to_regrole('postgres') and prosecdef and provolatile='v' and proconfig=array['search_path=""']::text[]
    and encode(sha256(convert_to(replace(prosrc,E'\r\n',E'\n'),'UTF8')),'hex')='d5f8355441890ab3bb910adcb34a0cd9e3211685431ffee7826e0eb283bb11a8')
    then raise exception 'appointment_patch_journal_dependencies_unconfirmed'; end if;
  if to_regprocedure('public.patch_crm_appointment_journaled(uuid,uuid,uuid,text,uuid,uuid,jsonb,jsonb,jsonb)') is not null
    then raise exception 'appointment_patch_journal_already_installed_requires_review'; end if;
end $$;

create function public.patch_crm_appointment_journaled(p_workspace_id uuid,p_staff_user_id uuid,p_auth_user_id uuid,p_actor_role text,
  p_appointment_id uuid,p_expected_edit_version uuid,p_before jsonb,p_patch jsonb,p_journal jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare saved jsonb; changes jsonb; entry jsonb; field_name text; labels jsonb;
  event text; events text[]:='{}'; metadata_value jsonb; audit_id uuid;
begin
  -- The verified server prepares the existing privacy-classified diff. Browser
  -- data cannot select the actor, event type, entity or audit destination.
  if jsonb_typeof(p_journal) is distinct from 'object' then
    raise exception using errcode='P1191',message='appointment_patch_journal_invalid'; end if;
  if (select count(*) from jsonb_object_keys(p_journal))<>3
    or not (p_journal ?& array['actorName','changes','outsideSchedule'])
    or jsonb_typeof(p_journal->'actorName') is distinct from 'string'
    or jsonb_typeof(p_journal->'outsideSchedule') is distinct from 'boolean'
    or jsonb_typeof(p_journal->'changes') is distinct from 'array' then
    raise exception using errcode='P1191',message='appointment_patch_journal_invalid'; end if;
  changes:=p_journal->'changes';
  labels:='{"client_id":"\u041a\u043b\u0438\u0435\u043d\u0442","status":"\u0421\u0442\u0430\u0442\u0443\u0441","service":"\u0423\u0441\u043b\u0443\u0433\u0430","starts_at":"\u0412\u0440\u0435\u043c\u044f","doctor_name":"\u0412\u0440\u0430\u0447","client_name":"\u041f\u0430\u0446\u0438\u0435\u043d\u0442","client_phone":"\u0422\u0435\u043b\u0435\u0444\u043e\u043d","notes":"\u0417\u0430\u043c\u0435\u0442\u043a\u0430"}'::jsonb;
  if jsonb_array_length(changes)>8 then
    raise exception using errcode='P1191',message='appointment_patch_journal_invalid'; end if;
  for entry in select value from jsonb_array_elements(changes) loop
    if jsonb_typeof(entry) is distinct from 'object' then
      raise exception using errcode='P1191',message='appointment_patch_journal_invalid'; end if;
    field_name:=entry->>'field';
    if (select count(*) from jsonb_object_keys(entry))<>4
      or not (entry ?& array['field','label','from','to']) or not coalesce(labels ? field_name,false)
      or not coalesce(p_patch ? field_name,false) or entry->'label' is distinct from labels->field_name
      or jsonb_typeof(entry->'from') not in ('string','null') or jsonb_typeof(entry->'to') not in ('string','null')
      or (select count(*) from jsonb_array_elements(changes) x where x->>'field'=field_name)<>1
      or (field_name='notes' and (entry->'from'<>'null'::jsonb or entry->'to'<>'null'::jsonb)) then
      raise exception using errcode='P1191',message='appointment_patch_journal_invalid'; end if;
    if field_name in ('client_name','client_phone') and exists(select 1 from (values(entry->>'from'),(entry->>'to')) v(value)
      where value is not null and value<>chr(8230) and value !~ ('^'||chr(8230)||'[0-9]{4}$')
        and not (field_name='client_name' and char_length(value)=2 and right(value,1)=chr(8230))) then
      raise exception using errcode='P1191',message='appointment_patch_journal_invalid'; end if;
  end loop;
  -- 118/116 keep original live authority and the frozen opening-version CAS.
  -- An audit failure below rolls their mutation and arrival side effects back.
  saved:=public.patch_crm_appointment_v2(p_workspace_id,p_staff_user_id,p_auth_user_id,p_actor_role,
    p_appointment_id,p_expected_edit_version,p_before,p_patch);
  if (p_journal->>'outsideSchedule')::boolean then events:=array_append(events,'booked_outside_schedule'); end if;
  if jsonb_array_length(changes)>0 then events:=array_append(events,'updated'); end if;
  foreach event in array events loop
    metadata_value:=jsonb_build_object('changes',case when event='updated' then changes else '[]'::jsonb end);
    insert into public.audit_logs(workspace_id,actor_name,actor_role,actor_staff_user_id,actor_kind,action,entity_type,entity_id,metadata)
      values(p_workspace_id,nullif(p_journal->>'actorName',''),p_actor_role,p_staff_user_id,'manual',event,'appointment',p_appointment_id::text,metadata_value)
      returning id into audit_id;
    if audit_id is null or not exists(select 1 from public.audit_logs where id=audit_id and workspace_id=p_workspace_id
      and actor_name is not distinct from nullif(p_journal->>'actorName','') and actor_role=p_actor_role
      and actor_staff_user_id=p_staff_user_id and actor_kind='manual' and action=event
      and entity_type='appointment' and entity_id=p_appointment_id::text and metadata=metadata_value) then
      raise exception using errcode='P1192',message='appointment_patch_journal_unconfirmed'; end if;
  end loop;
  return saved;
end $$;
revoke all on function public.patch_crm_appointment_journaled(uuid,uuid,uuid,text,uuid,uuid,jsonb,jsonb,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.patch_crm_appointment_journaled(uuid,uuid,uuid,text,uuid,uuid,jsonb,jsonb,jsonb) to service_role;
revoke all on function public.patch_crm_appointment_v2(uuid,uuid,uuid,text,uuid,uuid,jsonb,jsonb) from public,anon,authenticated,service_role;
do $$ declare role_name text; begin
  foreach role_name in array array['anon','authenticated','service_role'] loop
    if has_function_privilege(role_name,'public.patch_crm_appointment_v2(uuid,uuid,uuid,text,uuid,uuid,jsonb,jsonb)','EXECUTE')
      or has_function_privilege(role_name,'public.patch_crm_appointment_journaled(uuid,uuid,uuid,text,uuid,uuid,jsonb,jsonb,jsonb)','EXECUTE')<>(role_name='service_role') then
      raise exception 'appointment_patch_journal_legacy_access_unconfirmed'; end if;
  end loop;
end $$;
commit;
notify pgrst,'reload schema';
