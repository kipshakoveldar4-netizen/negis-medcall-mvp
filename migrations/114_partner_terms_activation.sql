-- Local candidate only. Initial partner activation, not payments or legacy adoption.
begin;
set local lock_timeout='3s';
set local statement_timeout='30s';

do $$ declare relation text; role_name text; begin
  if current_user<>'postgres'
    or not exists(select 1 from pg_roles where rolname='service_role' and rolbypassrls and not rolsuper)
    or exists(select 1 from pg_roles b cross join pg_roles p where b.rolname in ('anon','authenticated')
      and (p.rolsuper or p.rolbypassrls or p.rolname='postgres') and pg_has_role(b.oid,p.oid,'MEMBER'))
    then raise exception 'partner_terms_dependencies_unconfirmed'; end if;
  foreach relation in array array['growth_contributor_profiles','growth_partners','growth_referrals',
    'platform_subscription_payments','growth_partner_commissions','growth_partner_payouts'] loop
    if not exists(select 1 from pg_class c where c.oid=to_regclass('public.'||relation) and c.relowner=to_regrole('postgres')
      and c.relkind='r' and not c.relispartition and c.relrowsecurity)
      then raise exception 'partner_terms_dependencies_unconfirmed'; end if;
  end loop;
  foreach relation in array array['growth_partner_terms','growth_partner_term_commands'] loop
    if to_regclass('public.'||relation) is not null then
      if not exists(select 1 from pg_class where oid=to_regclass('public.'||relation) and relowner=to_regrole('postgres') and relrowsecurity)
        then raise exception 'partner_terms_shape_unconfirmed'; end if;
      foreach role_name in array array['anon','authenticated','service_role'] loop
        if has_table_privilege(role_name,'public.'||relation,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
          or has_any_column_privilege(role_name,'public.'||relation,'SELECT,INSERT,UPDATE,REFERENCES')
          then raise exception 'partner_terms_access_unconfirmed'; end if;
      end loop;
    end if;
  end loop;
  -- Detect unusual column grants before the coordinated table-level revocation.
  if exists(select 1 from pg_attribute a cross join lateral aclexplode(a.attacl) acl
    where a.attrelid='public.growth_partners'::regclass and acl.privilege_type in ('INSERT','UPDATE','REFERENCES')
      and (acl.grantee=0 or acl.grantee in (select oid from pg_roles where pg_has_role('service_role',oid,'USAGE'))))
    then raise exception 'partner_terms_legacy_writer_unconfirmed'; end if;
  if not exists(select 1 from pg_proc p where p.oid=to_regprocedure('public.review_growth_contributor(uuid,uuid,uuid,text,text)')
    and p.proowner=to_regrole('postgres') and p.prosecdef and p.provolatile='v'
    and encode(sha256(convert_to(replace(p.prosrc,E'\r\n',E'\n'),'UTF8')),'hex')='b08def2be56535257431253433b0cff8ebf10f55823ab33143f8a65d29d8d0ab')
    then raise exception 'partner_terms_dependencies_unconfirmed'; end if;
end $$;

create table if not exists public.growth_partner_terms (
  profile_id uuid primary key references public.growth_contributor_profiles(id),
  revision uuid not null default gen_random_uuid(),
  profile_auth_user_id uuid not null,
  profile_revision uuid not null,
  state text not null check(state in ('pending','accepted','declined','cancelled')),
  first_commission_bps integer not null check(first_commission_bps between 1000 and 5000),
  renewal_commission_bps integer not null check(renewal_commission_bps between 500 and 1000),
  terms_text text not null check(char_length(btrim(terms_text)) between 1 and 2000),
  offered_by uuid not null,
  offered_at timestamptz not null default clock_timestamp() check(isfinite(offered_at)),
  decided_by uuid,
  decided_at timestamptz check(isfinite(decided_at)),
  partner_id uuid unique references public.growth_partners(id),
  check((state='pending')=(decided_at is null)),
  check((decided_at is null)=(decided_by is null)),
  check((state='accepted')=(partner_id is not null)),
  check(decided_at is null or decided_at>=offered_at)
);
create table if not exists public.growth_partner_term_commands (
  actor_id uuid not null,
  request_key uuid not null,
  side text not null check(side in ('platform','partner')),
  profile_id uuid not null references public.growth_contributor_profiles(id),
  state text not null check(state in ('committed','abandoned')),
  intent jsonb not null check(jsonb_typeof(intent)='object'),
  result jsonb,
  created_at timestamptz not null default clock_timestamp() check(isfinite(created_at)),
  primary key(actor_id,request_key),
  check(((state='committed' and jsonb_typeof(result)='object') or (state='abandoned' and result is null)) is true)
);
alter table public.growth_partner_terms enable row level security;
alter table public.growth_partner_term_commands enable row level security;
revoke all on public.growth_partner_terms,public.growth_partner_term_commands from public,anon,authenticated,service_role;

do $$ declare relation text; begin
  foreach relation in array array['growth_partner_terms','growth_partner_term_commands'] loop
    if not exists(select 1 from pg_class c where c.oid=to_regclass('public.'||relation) and c.relowner=to_regrole('postgres')
      and c.relkind='r' and not c.relispartition and c.relrowsecurity
      and not exists(select 1 from pg_inherits i where i.inhrelid=c.oid or i.inhparent=c.oid)
      and not exists(select 1 from pg_trigger t where t.tgrelid=c.oid and not t.tgisinternal)
      and not exists(select 1 from pg_policy p where p.polrelid=c.oid))
      then raise exception 'partner_terms_shape_unconfirmed'; end if;
  end loop;
  if (select jsonb_agg(jsonb_build_array(attname,atttypid::regtype::text,attnotnull) order by attnum)
      from pg_attribute where attrelid='public.growth_partner_terms'::regclass and attnum>0 and not attisdropped)
    is distinct from '[["profile_id","uuid",true],["revision","uuid",true],["profile_auth_user_id","uuid",true],
      ["profile_revision","uuid",true],["state","text",true],["first_commission_bps","integer",true],["renewal_commission_bps","integer",true],
      ["terms_text","text",true],["offered_by","uuid",true],["offered_at","timestamp with time zone",true],
      ["decided_by","uuid",false],["decided_at","timestamp with time zone",false],["partner_id","uuid",false]]'::jsonb
    or (select md5(string_agg(pg_get_constraintdef(oid),E'\n' order by conname)) from pg_constraint where conrelid='public.growth_partner_terms'::regclass)
      is distinct from '0f90e651c571d3b44e3198bdcac6ec33'
    or (select jsonb_agg(jsonb_build_array(attname,atttypid::regtype::text,attnotnull) order by attnum)
      from pg_attribute where attrelid='public.growth_partner_term_commands'::regclass and attnum>0 and not attisdropped)
    is distinct from '[["actor_id","uuid",true],["request_key","uuid",true],["side","text",true],["profile_id","uuid",true],
      ["state","text",true],["intent","jsonb",true],["result","jsonb",false],["created_at","timestamp with time zone",true]]'::jsonb
    or (select md5(string_agg(pg_get_constraintdef(oid),E'\n' order by conname)) from pg_constraint where conrelid='public.growth_partner_term_commands'::regclass)
      is distinct from '6729541ef7f5c5fa7ea83db380ed40a5'
    then raise exception 'partner_terms_shape_unconfirmed'; end if;
end $$;

-- Platform authority is supplied only by the verified platform HTTP boundary.
-- The shared profile lock serializes terms paths before any other row locks.
-- Partner calls also pin live commercial authority. No workspace/payment locks.
create or replace function public.partner_terms_actor(p_actor uuid,p_side text,p_profile uuid)
returns public.growth_contributor_profiles language plpgsql security definer set search_path='' as $$
declare profile public.growth_contributor_profiles; commercial_status text;
begin
  if current_setting('transaction_isolation')<>'read committed'
    then raise exception using errcode='P1144',message='partner_terms_snapshot_unconfirmed'; end if;
  if p_actor is null or p_profile is null or p_side is null or p_side not in ('platform','partner')
    then raise exception using errcode='P1141',message='partner_terms_access_denied'; end if;
  if p_side='partner' then
    select status into commercial_status from public.growth_partners where auth_user_id=p_actor for update;
    if found and commercial_status<>'active' then raise exception using errcode='P1141',message='partner_terms_access_denied'; end if;
  end if;
  select * into profile from public.growth_contributor_profiles where id=p_profile for update;
  if not found or profile.partner_status is null or (p_side='partner'
    and (profile.auth_user_id is distinct from p_actor or profile.partner_status<>'approved'))
    then raise exception using errcode='P1141',message='partner_terms_access_denied'; end if;
  return profile;
end $$;

create or replace function public.partner_terms_snapshot(p_profile public.growth_contributor_profiles)
returns jsonb language plpgsql security definer set search_path='' as $$
declare terms public.growth_partner_terms; partner public.growth_partners; agreement jsonb;
begin
  select * into terms from public.growth_partner_terms where profile_id=p_profile.id for update;
  if not found then
    return jsonb_build_object('profileId',p_profile.id,'profileRevision',p_profile.revision,
      'state',case when exists(select 1 from public.growth_partners where auth_user_id=p_profile.auth_user_id)
        then 'legacy_unmanaged' else 'not_offered' end,'agreement',null);
  end if;
  if terms.profile_auth_user_id is distinct from p_profile.auth_user_id
    then raise exception using errcode='P1144',message='partner_terms_identity_unconfirmed'; end if;
  if terms.state='accepted' then
    select * into partner from public.growth_partners where id=terms.partner_id for update;
    if not found or partner.auth_user_id is distinct from p_profile.auth_user_id
      or partner.first_commission_bps is distinct from terms.first_commission_bps
      or partner.renewal_commission_bps is distinct from terms.renewal_commission_bps
      then raise exception using errcode='P1144',message='partner_terms_activation_unconfirmed'; end if;
  elsif exists(select 1 from public.growth_partners where auth_user_id=p_profile.auth_user_id) then
    raise exception using errcode='P1144',message='partner_terms_legacy_unconfirmed';
  end if;
  agreement=jsonb_build_object('revision',terms.revision,'state',terms.state,
    'firstCommissionBps',terms.first_commission_bps,'renewalCommissionBps',terms.renewal_commission_bps,'terms',terms.terms_text,
    'offeredAt',to_char(terms.offered_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'decidedAt',case when terms.decided_at is not null then to_char(terms.decided_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end,
    'commercialStatus',partner.status,'referralCode',case when partner.status='active' then partner.referral_code end);
  return jsonb_build_object('profileId',p_profile.id,'profileRevision',p_profile.revision,'state','managed','agreement',agreement);
end $$;

create or replace function public.execute_growth_partner_terms(p_actor uuid,p_side text,p_profile uuid,p_request uuid,
  p_profile_revision uuid,p_revision uuid,p_action text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='3s' set statement_timeout='8s' as $$
declare profile public.growth_contributor_profiles; terms public.growth_partner_terms; command public.growth_partner_term_commands;
  intent jsonb; result jsonb; partner uuid; has_terms boolean; first_rate numeric; renewal_rate numeric;
begin
  profile=public.partner_terms_actor(p_actor,p_side,p_profile);
  if p_request is null or p_profile_revision is null or p_action is null or jsonb_typeof(p_payload) is distinct from 'object'
    or octet_length(p_payload::text)>16000
    or (p_side='platform' and p_action not in ('offer','cancel')) or (p_side='partner' and p_action not in ('accept','decline'))
    then raise exception using errcode='P1142',message='invalid_partner_terms_command'; end if;
  intent=jsonb_build_object('profileRevision',p_profile_revision,'revision',p_revision,'action',p_action,'payload',p_payload);
  perform pg_advisory_xact_lock(hashtextextended('partner-terms:'||p_actor::text||':'||p_request::text,0));
  select * into command from public.growth_partner_term_commands where actor_id=p_actor and request_key=p_request;
  if found then
    if command.side<>p_side or command.profile_id<>p_profile or command.intent->>'action' is distinct from p_action
      or (command.state='committed' and command.intent is distinct from intent)
      then raise exception using errcode='P1143',message='partner_terms_command_conflict'; end if;
    if command.state='abandoned' then return jsonb_build_object('state','abandoned','requestId',p_request,'profileId',p_profile,'action',p_action); end if;
    return command.result;
  end if;
  if profile.revision<>p_profile_revision then raise exception using errcode='P1145',message='partner_terms_changed'; end if;
  select * into terms from public.growth_partner_terms where profile_id=p_profile for update;has_terms=found;
  if (has_terms and terms.revision is distinct from p_revision) or (not has_terms and p_revision is not null)
    then raise exception using errcode='P1145',message='partner_terms_changed'; end if;
  if (has_terms and (terms.state='accepted' or terms.profile_auth_user_id is distinct from profile.auth_user_id))
    or exists(select 1 from public.growth_partners where auth_user_id=profile.auth_user_id)
    then raise exception using errcode='P1145',message='partner_terms_activation_exists'; end if;
  if p_action='offer' then
    if profile.partner_status<>'approved' or (has_terms and terms.state='pending')
      then raise exception using errcode='P1145',message='partner_terms_changed'; end if;
    if (p_payload-array['firstCommissionBps','renewalCommissionBps','terms'])<>'{}'::jsonb
      or not (p_payload ?& array['firstCommissionBps','renewalCommissionBps','terms'])
      or jsonb_typeof(p_payload->'firstCommissionBps') is distinct from 'number'
      or jsonb_typeof(p_payload->'renewalCommissionBps') is distinct from 'number'
      or jsonb_typeof(p_payload->'terms') is distinct from 'string'
      then raise exception using errcode='P1142',message='invalid_partner_terms'; end if;
    first_rate=(p_payload->>'firstCommissionBps')::numeric;renewal_rate=(p_payload->>'renewalCommissionBps')::numeric;
    if first_rate not between 1000 and 5000 or first_rate<>trunc(first_rate)
      or renewal_rate not between 500 and 1000 or renewal_rate<>trunc(renewal_rate)
      or char_length(btrim(p_payload->>'terms')) not between 1 and 2000
      or regexp_replace(p_payload->>'terms',E'[\n\r\t]','','g') ~ '[[:cntrl:]]'
      then raise exception using errcode='P1142',message='invalid_partner_terms'; end if;
    insert into public.growth_partner_terms(profile_id,profile_auth_user_id,profile_revision,state,first_commission_bps,
      renewal_commission_bps,terms_text,offered_by) values(p_profile,profile.auth_user_id,profile.revision,'pending',first_rate,renewal_rate,p_payload->>'terms',p_actor)
    on conflict(profile_id) do update set revision=gen_random_uuid(),profile_revision=excluded.profile_revision,state='pending',
      first_commission_bps=excluded.first_commission_bps,renewal_commission_bps=excluded.renewal_commission_bps,
      terms_text=excluded.terms_text,offered_by=excluded.offered_by,offered_at=clock_timestamp(),decided_by=null,decided_at=null;
  else
    if not has_terms or terms.state<>'pending' or (p_action='accept' and p_payload<>'{"accepted":true}'::jsonb)
      or (p_action<>'accept' and p_payload<>'{}'::jsonb)
      then raise exception using errcode='P1142',message='invalid_partner_terms_command'; end if;
    if p_action='accept' then
      insert into public.growth_partners(auth_user_id,display_name,referral_code,status,first_commission_bps,renewal_commission_bps)
        values(profile.auth_user_id,profile.display_name,upper(replace(gen_random_uuid()::text,'-','')),'active',terms.first_commission_bps,terms.renewal_commission_bps)
        returning id into partner;
    end if;
    update public.growth_partner_terms set state=case p_action when 'accept' then 'accepted' when 'decline' then 'declined' else 'cancelled' end,
      revision=gen_random_uuid(),decided_by=p_actor,decided_at=clock_timestamp(),partner_id=partner where profile_id=p_profile;
  end if;
  result=jsonb_build_object('state','committed','requestId',p_request,'profileId',p_profile,'action',p_action,'result',public.partner_terms_snapshot(profile));
  insert into public.growth_partner_term_commands(actor_id,request_key,side,profile_id,state,intent,result)
    values(p_actor,p_request,p_side,p_profile,'committed',intent,result);
  return result;
end $$;

create or replace function public.read_growth_partner_terms(p_actor uuid,p_side text,p_profile uuid,p_request uuid,p_close boolean,p_action text)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='3s' set statement_timeout='8s' as $$
declare profile public.growth_contributor_profiles; command public.growth_partner_term_commands;
begin
  profile=public.partner_terms_actor(p_actor,p_side,p_profile);
  if p_close is null or (p_request is null and (p_close or p_action is not null)) or (not p_close and p_action is not null)
    or (p_close and (p_action is null or (p_side='platform' and p_action not in ('offer','cancel'))
      or (p_side='partner' and p_action not in ('accept','decline'))))
    then raise exception using errcode='P1142',message='invalid_partner_terms_query'; end if;
  if p_request is null then return public.partner_terms_snapshot(profile); end if;
  perform pg_advisory_xact_lock(hashtextextended('partner-terms:'||p_actor::text||':'||p_request::text,0));
  select * into command from public.growth_partner_term_commands where actor_id=p_actor and request_key=p_request;
  if found then
    if command.side<>p_side or command.profile_id<>p_profile or (p_close and command.intent->>'action' is distinct from p_action)
      then raise exception using errcode='P1143',message='partner_terms_command_conflict'; end if;
    if command.state='committed' then return command.result; end if;
    return jsonb_build_object('state','abandoned','requestId',p_request,'profileId',p_profile,'action',command.intent->>'action');
  end if;
  if not p_close then return jsonb_build_object('state','unconfirmed','requestId',p_request,'profileId',p_profile); end if;
  insert into public.growth_partner_term_commands(actor_id,request_key,side,profile_id,state,intent)
    values(p_actor,p_request,p_side,p_profile,'abandoned',jsonb_build_object('action',p_action));
  return jsonb_build_object('state','abandoned','requestId',p_request,'profileId',p_profile,'action',p_action);
end $$;

revoke all on function public.partner_terms_actor(uuid,text,uuid),public.partner_terms_snapshot(public.growth_contributor_profiles),
  public.execute_growth_partner_terms(uuid,text,uuid,uuid,uuid,uuid,text,jsonb),public.read_growth_partner_terms(uuid,text,uuid,uuid,boolean,text)
  from public,anon,authenticated,service_role;
grant execute on function public.execute_growth_partner_terms(uuid,text,uuid,uuid,uuid,uuid,text,jsonb),
  public.read_growth_partner_terms(uuid,text,uuid,uuid,boolean,text) to service_role;
revoke insert,update,delete,truncate,references,trigger on public.growth_partners from service_role;
do $$ declare role_name text; relation text; begin
  foreach role_name in array array['anon','authenticated','service_role'] loop
    foreach relation in array array['growth_partner_terms','growth_partner_term_commands'] loop
      if has_table_privilege(role_name,'public.'||relation,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        or has_any_column_privilege(role_name,'public.'||relation,'SELECT,INSERT,UPDATE,REFERENCES')
        then raise exception 'partner_terms_access_unconfirmed'; end if;
    end loop;
    if has_function_privilege(role_name,'public.partner_terms_actor(uuid,text,uuid)','EXECUTE')
      or has_function_privilege(role_name,'public.partner_terms_snapshot(public.growth_contributor_profiles)','EXECUTE')
      or has_function_privilege(role_name,'public.execute_growth_partner_terms(uuid,text,uuid,uuid,uuid,uuid,text,jsonb)','EXECUTE') is distinct from (role_name='service_role')
      or has_function_privilege(role_name,'public.read_growth_partner_terms(uuid,text,uuid,uuid,boolean,text)','EXECUTE') is distinct from (role_name='service_role')
      then raise exception 'partner_terms_access_unconfirmed'; end if;
  end loop;
  if has_any_column_privilege('service_role','public.growth_partners','INSERT,UPDATE,REFERENCES')
    then raise exception 'partner_terms_legacy_writer_unconfirmed'; end if;
  foreach role_name in array array['anon','authenticated'] loop
    if has_table_privilege(role_name,'public.growth_partners','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      or has_any_column_privilege(role_name,'public.growth_partners','SELECT,INSERT,UPDATE,REFERENCES')
      then raise exception 'partner_terms_legacy_writer_unconfirmed'; end if;
  end loop;
end $$;
notify pgrst,'reload schema';
commit;
