// Current post-115/116/117/118/119 metadata contract. No environment, network, business reads,
// domain RPC execution or migration application belongs in this module.
const functions = [
  ['public.create_crm_appointment_with_new_client(uuid,jsonb,jsonb)','jsonb','v',true,false,'11bb49a22da2ff5367e4769dd67f1c6857434f765a5798d0666508cc8bca7584',['p_workspace_id','p_client','p_appointment']],
  ['public.read_crm_appointment_create_request(uuid,uuid,uuid,text)','jsonb','v',true,false,'b45a42ef82367c39b6b875e7806a919c3173547230083eb0bb3b4b3d9e6bbf9d',['p_workspace_id','p_staff_user_id','p_request_key','p_request_fingerprint']],
  ['public.create_crm_appointment_once(uuid,uuid,uuid,text,jsonb,jsonb,text)','jsonb','v',true,false,'1e022dfa25d8e091a472cf5c5c429fe8210bbd3d7faddbc1ca7db60e49561a7a',['p_workspace_id','p_staff_user_id','p_request_key','p_request_fingerprint','p_new_client','p_appointment','p_client_match']],
  ['public.guard_appointment_capacity()','trigger','v',true,false,'73e57a6f89277b4fd543d709be37896c6876252d304be4c200ce0a1d56032a07',[]],
  ['public.lock_crm_appointment_actor(uuid,uuid,uuid,text)','jsonb','v',true,false,'5ddd6ab57753045cbebc2c8494a03b11379bfffdfd7ff9c31a8076c97393973f',['p_workspace','p_staff','p_actor','p_role']],
  ['public.crm_appointment_targets_actor(jsonb,jsonb)','boolean','i',false,false,'637235ede2ebb6c740d880ccc9a26a18717ff06d5391e882061655b7ea2438a8',['p_identity','p_appointment']],
  ['public.read_crm_appointment_request_v2(uuid,uuid,uuid,text,uuid,text)','jsonb','v',true,true,'4e51e17f2c895b455fdee7bb761e59dece26c5f3a697a7e918a3a312ec5c1c72',['p_workspace_id','p_staff_user_id','p_auth_user_id','p_actor_role','p_request_key','p_request_fingerprint']],
  ['public.create_crm_appointment_v2(uuid,uuid,uuid,text,uuid,text,jsonb,jsonb,text)','jsonb','v',true,true,'f50bb91918c8675fa94750cff9f8e486166412d5bbf4dcc4dbc23fba00520400',['p_workspace_id','p_staff_user_id','p_auth_user_id','p_actor_role','p_request_key','p_request_fingerprint','p_new_client','p_appointment','p_client_match']],
  ['public.patch_crm_appointment_as_actor(uuid,uuid,uuid,text,uuid,jsonb,jsonb)','jsonb','v',true,false,'e6f4e113b5e77a8896ae0c72ef7c9b6ae0a7179e015b587bb3a32a8256c26d81',['p_workspace_id','p_staff_user_id','p_auth_user_id','p_actor_role','p_appointment_id','p_before','p_patch']],
  ['public.stamp_appointment_edit_version()','trigger','v',false,false,'33b58671e0af76e5a11b6654ab305a78c0baefebf8dda29a61f7db9dcc380e6b',[]],
  ['public.patch_crm_appointment_v2(uuid,uuid,uuid,text,uuid,uuid,jsonb,jsonb)','jsonb','v',true,true,'d5f8355441890ab3bb910adcb34a0cd9e3211685431ffee7826e0eb283bb11a8',['p_workspace_id','p_staff_user_id','p_auth_user_id','p_actor_role','p_appointment_id','p_expected_edit_version','p_before','p_patch']],
];
const columns = {
  workspaces: {id:'uuid'},
  staff_users: {id:'uuid',workspace_id:'uuid',auth_user_id:'uuid',role:'text',status:'text',full_name:'text'},
  clinic_doctors: {id:'uuid',workspace_id:'uuid',staff_user_id:'uuid',full_name:'text',capacity:'smallint',is_active:'boolean'},
  clinic_services: {id:'uuid',workspace_id:'uuid',doctor_id:'uuid',is_active:'boolean'},
  clients: {id:'uuid',workspace_id:'uuid',full_name:'text',phone:'text',whatsapp:'text',source:'text',status:'text',notes:'text',last_visit_at:'timestamp with time zone',updated_at:'timestamp with time zone'},
  appointments: {id:'uuid',workspace_id:'uuid',client_id:'uuid',client_name:'text',client_phone:'text',whatsapp:'text',service:'text',doctor_name:'text',starts_at:'timestamp with time zone',duration_minutes:'integer',price_minor:'bigint',status:'text',notes:'text',source:'text',updated_at:'timestamp with time zone',created_at:'timestamp with time zone',arrival_sale_id:'uuid',created_by_staff_user_id:'uuid',doctor_id:'uuid',service_id:'uuid',service_items:'jsonb',edit_version:'uuid'},
};
const receiptColumns = {
  crm_appointment_create_requests: [['workspace_id','uuid',true],['staff_user_id','uuid',true],['request_key','uuid',true],['request_fingerprint','text',true],['appointment_id','uuid',false],['client_created','boolean',true],['client_match','text',true],['created_at','timestamp with time zone',true]],
  crm_appointment_request_actors: [['workspace_id','uuid',true],['staff_user_id','uuid',true],['request_key','uuid',true],['auth_user_id','uuid',true]],
};
const literal = value => "'"+String(value).replaceAll("'","''")+"'";
const textArray = values => 'array['+values.map(literal).join(',')+']::text[]';
const tuple = values => '('+values.map(v=>typeof v==='boolean'?String(v):literal(v)).join(',')+')';

function metadataQuery(functions,columns,extraChecks='') { return `with
required_columns(relation,column_name,type_name) as (values
${Object.entries(columns).flatMap(([table,names])=>Object.entries(names).map(([name,type])=>tuple([table,name,type]))).join(',\n')}
), routines(signature,return_type,volatility,definer,service_entry,body_hash,arg_names) as (values
${functions.map(([sig,result,volatility,definer,service,hash,args])=>'('+[literal(sig),literal(result),literal(volatility),definer,service,literal(hash),textArray(args)].join(',')+')').join(',\n')}
), roles(name) as (values ('anon'),('authenticated'),('service_role')),
receipts(relation,shape) as (values
${Object.entries(receiptColumns).map(([table,shape])=>'('+literal(table)+','+literal(JSON.stringify(shape))+'::jsonb)').join(',\n')}
), checks as (
  select 'inspector:postgres' check_name,current_user='postgres' ready
  union all select 'appointments:server_access',case when pg_catalog.to_regclass('public.appointments') is null
    or pg_catalog.to_regrole('service_role') is null then false else
      pg_catalog.has_table_privilege('service_role','public.appointments','SELECT')
      and not pg_catalog.has_table_privilege('service_role','public.appointments','INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER')
      and not pg_catalog.has_any_column_privilege('service_role','public.appointments','INSERT,UPDATE') end
  union all select 'roles:service_boundary',exists(select 1 from pg_catalog.pg_roles where rolname='service_role' and rolbypassrls and not rolsuper)
  union all select 'roles:browser_boundary',(select count(*)=2 from pg_catalog.pg_roles where rolname in ('anon','authenticated'))
    and not exists(select 1 from pg_catalog.pg_roles b cross join pg_catalog.pg_roles p where b.rolname in ('anon','authenticated')
      and (p.rolsuper or p.rolbypassrls or p.rolname='postgres') and pg_catalog.pg_has_role(b.oid,p.oid,'MEMBER'))
  union all select 'column:'||r.relation||'.'||r.column_name,exists(select 1 from pg_catalog.pg_attribute a
    where a.attrelid=pg_catalog.to_regclass('public.'||r.relation) and a.attname=r.column_name and a.attnum>0 and not a.attisdropped
    and a.atttypid=pg_catalog.to_regtype(r.type_name)) from required_columns r
  union all select 'routine:'||r.signature,exists(select 1 from pg_catalog.pg_proc p where p.oid=pg_catalog.to_regprocedure(r.signature)
    and p.proowner=pg_catalog.to_regrole('postgres') and p.prokind='f' and p.prorettype=pg_catalog.to_regtype(r.return_type)
    and p.provolatile::text=r.volatility and p.prosecdef=r.definer and not p.proretset and not p.proleakproof and p.pronargdefaults=0
    and p.proargmodes is null and coalesce(p.proargnames,'{}'::text[])=r.arg_names and p.proconfig=array['search_path=""']::text[]
    and not exists(select 1 from pg_catalog.aclexplode(p.proacl) where is_grantable)
    and pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.replace(p.prosrc,E'\\r\\n',E'\\n'),'UTF8')),'hex')=r.body_hash) from routines r
  union all select 'execute:'||roles.name||':'||r.signature,
    case when pg_catalog.to_regrole(roles.name) is null or pg_catalog.to_regprocedure(r.signature) is null then false else
      pg_catalog.has_function_privilege(roles.name,r.signature,'EXECUTE')=(roles.name='service_role' and r.service_entry) end
    from routines r cross join roles
  union all select 'receipt:shape:'||r.relation,exists(select 1 from pg_catalog.pg_class c where c.oid=pg_catalog.to_regclass('public.'||r.relation)
    and c.relowner=pg_catalog.to_regrole('postgres') and c.relkind='r' and not c.relispartition and c.relrowsecurity and not c.relforcerowsecurity
    and not exists(select 1 from pg_catalog.pg_inherits where inhrelid=c.oid or inhparent=c.oid)
    and not exists(select 1 from pg_catalog.pg_policy where polrelid=c.oid)
    and not exists(select 1 from pg_catalog.pg_trigger where tgrelid=c.oid and not tgisinternal)
    and (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(a.attname,a.atttypid::regtype::text,a.attnotnull) order by a.attnum)
      from pg_catalog.pg_attribute a where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped)=r.shape) from receipts r
  union all select 'receipt:closed:'||r.relation||':'||roles.name,
    case when pg_catalog.to_regrole(roles.name) is null or pg_catalog.to_regclass('public.'||r.relation) is null then false else
      not pg_catalog.has_table_privilege(roles.name,'public.'||r.relation,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      and not pg_catalog.has_any_column_privilege(roles.name,'public.'||r.relation,'SELECT,INSERT,UPDATE,REFERENCES') end from receipts r cross join roles
  union all select 'receipt:origin_key',exists(select 1 from pg_catalog.pg_constraint c where c.conrelid=pg_catalog.to_regclass('public.crm_appointment_request_actors')
    and c.contype='p' and c.convalidated and not c.condeferrable
    and array(select a.attname::text from pg_catalog.unnest(c.conkey) with ordinality k(num,ord)
      join pg_catalog.pg_attribute a on a.attrelid=c.conrelid and a.attnum=k.num order by k.ord)=array['workspace_id','staff_user_id','request_key']::text[])
  union all select 'receipt:origin_fk',exists(select 1 from pg_catalog.pg_constraint c where c.conrelid=pg_catalog.to_regclass('public.crm_appointment_request_actors')
    and c.confrelid=pg_catalog.to_regclass('public.crm_appointment_create_requests') and c.contype='f' and c.convalidated and not c.condeferrable and c.confdeltype='c'
    and array(select a.attname::text from pg_catalog.unnest(c.conkey) with ordinality k(num,ord)
      join pg_catalog.pg_attribute a on a.attrelid=c.conrelid and a.attnum=k.num order by k.ord)=array['workspace_id','staff_user_id','request_key']::text[]
    and array(select a.attname::text from pg_catalog.unnest(c.confkey) with ordinality k(num,ord)
      join pg_catalog.pg_attribute a on a.attrelid=c.confrelid and a.attnum=k.num order by k.ord)=array['workspace_id','staff_user_id','request_key']::text[])
  union all select 'identity:unique_staff_doctor',exists(select 1 from pg_catalog.pg_index where indexrelid=pg_catalog.to_regclass('public.clinic_doctors_workspace_staff_user_idx')
    and indrelid=pg_catalog.to_regclass('public.clinic_doctors') and indisunique and indisvalid and indisready and indnkeyatts=2
    and pg_catalog.pg_get_indexdef(indexrelid,1,true)='workspace_id' and pg_catalog.pg_get_indexdef(indexrelid,2,true)='staff_user_id'
    and pg_catalog.pg_get_expr(indpred,indrelid)='(staff_user_id IS NOT NULL)')
  union all select 'capacity:trigger',exists(select 1 from pg_catalog.pg_trigger t where t.tgrelid=pg_catalog.to_regclass('public.appointments')
    and t.tgname='guard_appointment_capacity' and not t.tgisinternal and t.tgfoid=pg_catalog.to_regprocedure('public.guard_appointment_capacity()')
    and t.tgenabled='O' and t.tgtype=31 and t.tgqual is null
    and array(select a.attname::text from pg_catalog.pg_attribute a where a.attrelid=t.tgrelid and a.attnum=any(t.tgattr::smallint[]) order by a.attname)
      =array['doctor_id','doctor_name','duration_minutes','starts_at','status','workspace_id']::text[])
  union all select 'appointments:edit_version_shape',exists(select 1 from pg_catalog.pg_attribute a
    join pg_catalog.pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
    where a.attrelid=pg_catalog.to_regclass('public.appointments') and a.attname='edit_version' and not a.attisdropped
      and a.attnotnull and a.attgenerated='' and a.attidentity=''
      and pg_catalog.pg_get_expr(d.adbin,d.adrelid) in ('gen_random_uuid()','pg_catalog.gen_random_uuid()')
      and not exists(select 1 from pg_catalog.pg_depend dep where dep.classid='pg_catalog.pg_attrdef'::regclass
        and dep.objid=d.oid and dep.refclassid='pg_catalog.pg_proc'::regclass))
  union all select 'appointments:edit_version_trigger',exists(select 1 from pg_catalog.pg_trigger t
    where t.tgrelid=pg_catalog.to_regclass('public.appointments') and t.tgname='stamp_appointment_edit_version'
      and not t.tgisinternal and t.tgfoid=pg_catalog.to_regprocedure('public.stamp_appointment_edit_version()')
      and t.tgenabled='O' and t.tgtype=19 and t.tgqual is null and t.tgattr=''::pg_catalog.int2vector)
  union all select 'appointments:before_update_triggers',coalesce((select pg_catalog.array_agg(t.tgname::text order by t.tgname)
    from pg_catalog.pg_trigger t where t.tgrelid=pg_catalog.to_regclass('public.appointments') and not t.tgisinternal
      and (t.tgtype::int & 19)=19),'{}'::text[])=array['guard_appointment_capacity','stamp_appointment_edit_version']::text[]
${extraChecks})
select check_name,coalesce(ready,false) ready from checks order by check_name;`;
}

// Preserve the exact historical query for the read-only 112-check receipt.
export const appointmentVersionEntryReadinessQuery=metadataQuery(functions,columns);
const journalSignature='public.patch_crm_appointment_journaled(uuid,uuid,uuid,text,uuid,uuid,jsonb,jsonb,jsonb)';
const journalBodyHash='d9e7877ab5f1c0b30db564ac961ed3ef6b686c0743d544279d03925b5672d9ae';
export const appointmentActorReadinessQuery=metadataQuery([
  ...functions.map(row=>row[0].startsWith('public.patch_crm_appointment_v2(')?[...row.slice(0,4),false,...row.slice(5)]:row),
  [journalSignature,'jsonb','v',true,true,journalBodyHash,['p_workspace_id','p_staff_user_id','p_auth_user_id','p_actor_role','p_appointment_id','p_expected_edit_version','p_before','p_patch','p_journal']],
],{...columns,audit_logs:{id:'uuid',workspace_id:'uuid',actor_name:'text',actor_role:'text',actor_staff_user_id:'uuid',actor_kind:'text',
  action:'text',entity_type:'text',entity_id:'text',metadata:'jsonb',created_at:'timestamp with time zone'}},`
  union all select 'audit:shape',exists(select 1 from pg_catalog.pg_class c where c.oid=pg_catalog.to_regclass('public.audit_logs')
    and c.relowner=pg_catalog.to_regrole('postgres') and c.relkind='r' and not c.relispartition and c.relrowsecurity and not c.relforcerowsecurity
    and not exists(select 1 from pg_catalog.pg_policy where polrelid=c.oid)
    and not exists(select 1 from pg_catalog.pg_trigger where tgrelid=c.oid and not tgisinternal))
  union all select 'audit:closed:'||r.name,case when pg_catalog.to_regclass('public.audit_logs') is null or pg_catalog.to_regrole(r.name) is null
    then false else not pg_catalog.has_table_privilege(r.name,'public.audit_logs','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      and not pg_catalog.has_any_column_privilege(r.name,'public.audit_logs','SELECT,INSERT,UPDATE,REFERENCES') end
    from roles r where r.name<>'service_role'
`);

export function buildAppointmentActorReadiness() {
  return `-- Current appointment API: v2 create/replay + journaled version-bound PATCH, post-115/116/117/118/119 read-only gate.
-- Run only in the approved test database after verifying its separate identity.
-- All checks must be true; legacy RPCs closed, only current server entries open.
-- NOT end-to-end, concurrency or payment acceptance. No business rows are read.
-- This does not attest API/build binding, real Auth or legacy receipt recovery.
begin read only;
set local statement_timeout='10s';
${appointmentActorReadinessQuery}
commit;
`;
}
