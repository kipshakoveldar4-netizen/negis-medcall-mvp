-- Local candidate only. First actual subscription payment, not workspace
-- creation, must fall in the original 168-hour first-entry window. No backfill,
-- payment provider, public financial endpoint or existing-row rewrite.
begin;
set local lock_timeout='3s';
set local statement_timeout='30s';

do $$ declare dependency record; relation text; installing boolean; begin
  if current_user<>'postgres' or not exists(select 1 from pg_roles where rolname='service_role' and rolbypassrls and not rolsuper)
    or exists(select 1 from pg_roles where rolname in ('anon','authenticated') and (rolsuper or rolbypassrls))
    or exists(select 1 from pg_roles b cross join pg_roles p where b.rolname in ('anon','authenticated')
      and (p.rolsuper or p.rolbypassrls or p.rolname='postgres') and pg_has_role(b.oid,p.oid,'MEMBER'))
    then raise exception 'partner_payment_dependencies_unconfirmed'; end if;
  foreach relation in array array['growth_partner_sources','growth_referrals','growth_partners','growth_contributor_profiles',
    'platform_subscription_payments','platform_subscriptions','growth_partner_commissions','workspaces','staff_users'] loop
    if not exists(select 1 from pg_class where oid=to_regclass('public.'||relation) and relkind='r'
      and relowner=to_regrole('postgres') and relrowsecurity)
      then raise exception 'partner_payment_dependencies_unconfirmed'; end if;
  end loop;
  installing:=to_regclass('public.growth_partner_payment_windows') is null;
  if installing is distinct from (to_regprocedure('public.confirm_growth_subscription_payment_052(uuid,uuid,bigint,text,timestamptz,uuid,uuid)') is null)
    then raise exception 'partner_payment_dependencies_unconfirmed'; end if;
  for dependency in select * from (values
    ('public.partner_source_profile(uuid)','09c3adddbebc73f9251ca1cd25a1d295d669c4560be93fb9b658c76b4f0853b2'),
    ('public.partner_source_owner(uuid,uuid)','3f452d692e08f57a3c75207de741965355c38b9bcadb7bd59e87ac828aa4b7a8'),
    ('public.partner_source_result(public.growth_partner_sources)',case when installing then
      'bb5fea320dc455ca6e2324a32c39d21e3f27f783b25f84a918fbb56aa4dc337c' else 'eb608197f49139b80c3c348ee32bb09e99bad00dfa7bdfbb95c72bbc9ef6f4dd' end),
    ('public.bind_growth_partner_source(uuid,uuid,uuid)',case when installing then
      'aa3134ec3cb383b7be5d540a230cdcdd2cb0c1229d40de616246b8ed0f57c738' else '6be3c2e0636043a945fcbfe847a16e945f00f9374429a6ae2a7a2ce4843dfd3f' end),
    ('public.confirm_growth_subscription_payment(uuid,uuid,bigint,text,timestamptz,uuid,uuid)',case when installing then
      '1c23a77f6a93f9fc8b90a65fce9b0795875a823b792530f9838faee90c1ad602' else '273f43042c08231da06edce705cffbe6bf7be8a2c7c280acc83d992bd5853446' end)
  ) expected(signature,digest) loop
    if not exists(select 1 from pg_proc p where p.oid=to_regprocedure(dependency.signature) and p.proowner=to_regrole('postgres')
      and p.prosecdef and p.provolatile='v' and not p.proretset and 'search_path=""'=any(p.proconfig)
      and encode(sha256(convert_to(replace(p.prosrc,E'\r\n',E'\n'),'UTF8')),'hex')=dependency.digest)
      then raise exception 'partner_payment_dependencies_unconfirmed'; end if;
  end loop;
  -- Historical paid bindings are preserved. Unpaid legacy bindings need an
  -- explicit review, never an automatic new eligibility deadline or backfill.
  if installing and exists(select 1 from public.growth_referrals r where not exists(
    select 1 from public.platform_subscription_payments p where p.workspace_id=r.workspace_id and p.kind='first'))
    then raise exception 'partner_payment_legacy_review_required'; end if;
  if installing then
    alter function public.confirm_growth_subscription_payment(uuid,uuid,bigint,text,timestamptz,uuid,uuid)
      rename to confirm_growth_subscription_payment_052;
  end if;
  if not exists(select 1 from pg_proc p where p.oid=to_regprocedure('public.confirm_growth_subscription_payment_052(uuid,uuid,bigint,text,timestamptz,uuid,uuid)')
    and p.proowner=to_regrole('postgres') and p.prosecdef and p.provolatile='v' and p.prorettype='uuid'::regtype
    and not p.proretset and 'search_path=""'=any(p.proconfig)
    and encode(sha256(convert_to(replace(p.prosrc,E'\r\n',E'\n'),'UTF8')),'hex')='1c23a77f6a93f9fc8b90a65fce9b0795875a823b792530f9838faee90c1ad602')
    then raise exception 'partner_payment_dependencies_unconfirmed'; end if;
end $$;

create table if not exists public.growth_partner_payment_windows (
  workspace_id uuid primary key references public.workspaces(id),
  source_id uuid not null unique references public.growth_partner_sources(id),
  policy_version text not null check(policy_version='2026-10-28-first-paid-7d-self-v2'),
  qualified_payment_id uuid unique references public.platform_subscription_payments(id)
);
alter table public.growth_partner_payment_windows enable row level security;
revoke all on table public.growth_partner_payment_windows from public,anon,authenticated,service_role;
do $$ begin
  if not exists(select 1 from pg_class where oid='public.growth_partner_payment_windows'::regclass and relkind='r'
      and relowner=to_regrole('postgres') and relrowsecurity)
    or (select jsonb_agg(jsonb_build_array(attname,format_type(atttypid,atttypmod),attnotnull) order by attnum)
      from pg_attribute where attrelid='public.growth_partner_payment_windows'::regclass and attnum>0 and not attisdropped)
      is distinct from '[["workspace_id","uuid",true],["source_id","uuid",true],["policy_version","text",true],["qualified_payment_id","uuid",false]]'::jsonb
    then raise exception 'partner_payment_schema_unconfirmed'; end if;
end $$;

create or replace function public.partner_source_result(p_source public.growth_partner_sources)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare window_row public.growth_partner_payment_windows; source_state text;
begin
  if p_source.workspace_id is null then
    source_state:=case when p_source.expires_at<=clock_timestamp() then 'expired' else 'captured' end;
  else
    select * into window_row from public.growth_partner_payment_windows where source_id=p_source.id;
    if found then
      if window_row.workspace_id<>p_source.workspace_id
        or (window_row.qualified_payment_id is null and exists(select 1 from public.growth_referrals where workspace_id=p_source.workspace_id))
        or (window_row.qualified_payment_id is not null and not exists(select 1 from public.platform_subscription_payments p
          join public.growth_referrals r using(workspace_id) where p.id=window_row.qualified_payment_id
          and p.workspace_id=p_source.workspace_id and p.kind='first' and p.paid_at>=p_source.captured_at and p.paid_at<p_source.expires_at
          and r.partner_id=p_source.partner_id and r.source=p_source.source))
        then raise exception using errcode='P1202',message='partner_payment_inconsistent'; end if;
      source_state:=case when window_row.qualified_payment_id is not null then 'bound'
        when p_source.expires_at<=clock_timestamp() or exists(select 1 from public.platform_subscription_payments where workspace_id=p_source.workspace_id)
        then 'expired' else 'pending_payment' end;
    else
      if not exists(select 1 from public.growth_referrals r where r.workspace_id=p_source.workspace_id
        and r.partner_id=p_source.partner_id and r.source=p_source.source)
        then raise exception using errcode='P1122',message='partner_source_inconsistent'; end if;
      source_state:='bound';
    end if;
  end if;
  return jsonb_build_object('id',p_source.id,'state',source_state,'source',p_source.source,
    'capturedAt',to_char(p_source.captured_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'expiresAt',to_char(p_source.expires_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'policyVersion',p_source.policy_version,'workspaceId',p_source.workspace_id);
end $$;

create or replace function public.bind_growth_partner_source(p_actor uuid,p_intent uuid,p_workspace uuid)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='3s' set statement_timeout='8s' as $$
declare saved public.growth_partner_sources; partner_actor uuid; created timestamptz;
begin
  if current_setting('transaction_isolation')<>'read committed'
    then raise exception using errcode='P1122',message='partner_source_snapshot_unconfirmed'; end if;
  if p_actor is null or p_intent is null or p_workspace is null
    then raise exception using errcode='P1121',message='partner_source_unavailable'; end if;
  perform pg_advisory_xact_lock(hashtextextended('partner-source:'||p_intent::text,0));
  select * into saved from public.growth_partner_sources where id=p_intent and actor_auth_user_id=p_actor;
  if not found then raise exception using errcode='P1121',message='partner_source_unavailable'; end if;
  partner_actor:=public.partner_source_profile(saved.partner_id);
  created:=public.partner_source_owner(p_actor,p_workspace);
  perform 1 from public.growth_partners where id=saved.partner_id and auth_user_id=partner_actor and status='active' for update;
  if not found then raise exception using errcode='P1121',message='partner_source_unavailable'; end if;
  if saved.workspace_id is not null then
    if saved.workspace_id<>p_workspace then raise exception using errcode='P1123',message='partner_source_conflict'; end if;
    return public.partner_source_result(saved);
  end if;
  if created<saved.captured_at or saved.expires_at<=clock_timestamp()
    or exists(select 1 from public.growth_referrals where workspace_id=p_workspace)
    or exists(select 1 from public.growth_partner_payment_windows where workspace_id=p_workspace)
    or exists(select 1 from public.platform_subscription_payments where workspace_id=p_workspace)
    then raise exception using errcode='P1123',message='partner_source_conflict'; end if;
  -- Workspace registration reserves the original source, not a paid referral.
  update public.growth_partner_sources set workspace_id=p_workspace,bound_at=clock_timestamp() where id=saved.id returning * into saved;
  insert into public.growth_partner_payment_windows(workspace_id,source_id,policy_version)
    values(p_workspace,saved.id,'2026-10-28-first-paid-7d-self-v2');
  return public.partner_source_result(saved);
end $$;

create or replace function public.confirm_growth_subscription_payment(
  p_workspace_id uuid,p_subscription_id uuid,p_amount_minor bigint,p_currency text,
  p_paid_at timestamptz,p_request_key uuid,p_confirmed_by uuid
) returns uuid language plpgsql security definer set search_path='' set lock_timeout='3s' set statement_timeout='8s' as $$
declare window_row public.growth_partner_payment_windows; saved public.growth_partner_sources;
  payment uuid; created timestamptz; first_payment public.platform_subscription_payments; eligible boolean:=false;
begin
  if current_setting('transaction_isolation')<>'read committed' or p_workspace_id is null or p_subscription_id is null
    or p_amount_minor is null or p_amount_minor<=0 or p_currency is null or p_currency!~'^[A-Z]{3}$'
    or p_paid_at is null or not isfinite(p_paid_at) or p_paid_at>now() or p_request_key is null or p_confirmed_by is null
    then raise exception using errcode='P1202',message='partner_payment_unconfirmed'; end if;
  select created_at into created from public.workspaces where id=p_workspace_id for update;
  if not found then raise exception 'workspace_unavailable'; end if;
  -- Exact retries keep the original outcome, including an expired first payment.
  if exists(select 1 from public.platform_subscription_payments where request_key=p_request_key) then
    return public.confirm_growth_subscription_payment_052(p_workspace_id,p_subscription_id,p_amount_minor,p_currency,p_paid_at,p_request_key,p_confirmed_by);
  end if;
  select * into window_row from public.growth_partner_payment_windows where workspace_id=p_workspace_id for update;
  if found then
    select * into saved from public.growth_partner_sources where id=window_row.source_id;
    if not found or saved.workspace_id is distinct from p_workspace_id or saved.bound_at is null
      or saved.captured_at>created or not isfinite(created)
      or saved.expires_at is distinct from saved.captured_at+interval '168 hours'
      then raise exception using errcode='P1202',message='partner_payment_inconsistent'; end if;
    -- Same workspace -> partner order as the immutable 052 payment/payout ledger.
    perform 1 from public.growth_partners where id=saved.partner_id for update;
    if not found then raise exception using errcode='P1202',message='partner_payment_inconsistent'; end if;
    select * into first_payment from public.platform_subscription_payments where workspace_id=p_workspace_id and kind='first';
    if window_row.qualified_payment_id is not null then
      if first_payment.id is distinct from window_row.qualified_payment_id
        or first_payment.paid_at<saved.captured_at or first_payment.paid_at>=saved.expires_at
        or not exists(select 1 from public.growth_referrals r where r.workspace_id=p_workspace_id
          and r.partner_id=saved.partner_id and r.source=saved.source)
        then raise exception using errcode='P1202',message='partner_payment_inconsistent'; end if;
    else
      if exists(select 1 from public.growth_referrals where workspace_id=p_workspace_id)
        or (first_payment.id is not null and exists(select 1 from public.growth_partner_commissions where payment_id=first_payment.id))
        then raise exception using errcode='P1202',message='partner_payment_inconsistent'; end if;
      eligible:=first_payment.id is null and p_paid_at>=saved.captured_at and p_paid_at>=created and p_paid_at<saved.expires_at;
      if eligible then
        insert into public.growth_referrals(workspace_id,partner_id,source,registered_at)
          values(p_workspace_id,saved.partner_id,saved.source,p_paid_at);
      end if;
    end if;
  end if;
  payment:=public.confirm_growth_subscription_payment_052(p_workspace_id,p_subscription_id,p_amount_minor,p_currency,p_paid_at,p_request_key,p_confirmed_by);
  if eligible then
    update public.growth_partner_payment_windows set qualified_payment_id=payment where workspace_id=p_workspace_id;
  end if;
  return payment;
end $$;

revoke all on function public.confirm_growth_subscription_payment_052(uuid,uuid,bigint,text,timestamptz,uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function public.partner_source_result(public.growth_partner_sources) from public,anon,authenticated,service_role;
revoke all on function public.bind_growth_partner_source(uuid,uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function public.confirm_growth_subscription_payment(uuid,uuid,bigint,text,timestamptz,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.bind_growth_partner_source(uuid,uuid,uuid) to service_role;
grant execute on function public.confirm_growth_subscription_payment(uuid,uuid,bigint,text,timestamptz,uuid,uuid) to service_role;
do $$ declare role_name text; signature text; begin
  foreach role_name in array array['anon','authenticated','service_role'] loop
    if has_table_privilege(role_name,'public.growth_partner_payment_windows','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      or has_any_column_privilege(role_name,'public.growth_partner_payment_windows','SELECT,INSERT,UPDATE,REFERENCES')
      then raise exception 'partner_payment_executors_unconfirmed'; end if;
    foreach signature in array array['public.confirm_growth_subscription_payment_052(uuid,uuid,bigint,text,timestamptz,uuid,uuid)',
      'public.partner_source_result(public.growth_partner_sources)','public.bind_growth_referral(uuid,text,text)'] loop
      if has_function_privilege(role_name,signature,'EXECUTE') then raise exception 'partner_payment_executors_unconfirmed'; end if;
    end loop;
    foreach signature in array array['public.bind_growth_partner_source(uuid,uuid,uuid)',
      'public.confirm_growth_subscription_payment(uuid,uuid,bigint,text,timestamptz,uuid,uuid)'] loop
      if has_function_privilege(role_name,signature,'EXECUTE') is distinct from (role_name='service_role')
        then raise exception 'partner_payment_executors_unconfirmed'; end if;
    end loop;
  end loop;
end $$;
notify pgrst,'reload schema';
commit;
