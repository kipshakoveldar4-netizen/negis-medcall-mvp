-- Local foundation only. The server must obtain the registration intent from
-- its trusted first-entry flow, not a browser-selected partner/workspace list.
-- Owner decision 2026-10-27: seven days from the anonymous first entry; own
-- companies use the same rules. Capture never starts a new window at sign-in.
-- A future HTTP intake must mint a 256-bit visit capability, keep only its hash
-- here, and prove that cookie before claiming with a verified Auth actor.
begin;
set local lock_timeout='3s';
set local statement_timeout='30s';

do $$ declare relation text; dependency record; begin
  if current_user<>'postgres' or not exists(select 1 from pg_roles where rolname='service_role' and rolbypassrls and not rolsuper)
    or exists(select 1 from pg_roles where rolname in ('anon','authenticated') and (rolsuper or rolbypassrls))
    or exists(select 1 from pg_roles b cross join pg_roles p where b.rolname in ('anon','authenticated')
      and (p.rolsuper or p.rolbypassrls or p.rolname='postgres') and pg_has_role(b.oid,p.oid,'MEMBER'))
    then raise exception 'partner_source_dependencies_unconfirmed'; end if;
  foreach relation in array array['growth_contributor_profiles','growth_partners','growth_referrals','staff_users','workspaces','platform_subscription_payments'] loop
    if not exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public'
      and c.relname=relation and c.relkind='r' and c.relowner=to_regrole('postgres') and c.relrowsecurity)
      then raise exception 'partner_source_dependencies_unconfirmed'; end if;
  end loop;
  if not exists(select 1 from pg_proc p where p.oid=to_regprocedure('public.bind_growth_referral(uuid,text,text)')
    and p.proowner=to_regrole('postgres') and p.prosecdef and p.prorettype='uuid'::regtype and p.provolatile='v' and not p.proretset
    and 'search_path=""'=any(p.proconfig)
    and encode(sha256(convert_to(replace(p.prosrc,E'\r\n',E'\n'),'UTF8')),'hex')='21e83d9cf30090f24e1b7c1872528a91c160dfbba615131b915fbe4f0dab8a8a')
    then raise exception 'partner_source_dependencies_unconfirmed'; end if;
  for dependency in select * from (values
    ('public.apply_growth_contributor(uuid,text,boolean,boolean,text[])','a88222425af811b7667b56fbc172cb021c8669c13563bfa618fb6f83900b501d'),
    ('public.review_growth_contributor(uuid,uuid,uuid,text,text)','b08def2be56535257431253433b0cff8ebf10f55823ab33143f8a65d29d8d0ab')
  ) expected(signature,digest) loop
    if not exists(select 1 from pg_proc p where p.oid=to_regprocedure(dependency.signature)
      and p.proowner=to_regrole('postgres') and p.prosecdef and p.provolatile='v' and not p.proretset
      and encode(sha256(convert_to(replace(p.prosrc,E'\r\n',E'\n'),'UTF8')),'hex')=dependency.digest)
      then raise exception 'partner_source_dependencies_unconfirmed'; end if;
  end loop;
end $$;

create table if not exists public.growth_partner_sources (
  id uuid primary key,
  actor_auth_user_id uuid,
  capability_hash text not null check(capability_hash ~ '^[0-9a-f]{64}$'),
  partner_id uuid not null references public.growth_partners(id),
  source text not null check(source in ('link','promo_code')),
  captured_at timestamptz not null,
  expires_at timestamptz not null,
  policy_version text not null check(policy_version='2026-10-27-7d-self-v1'),
  workspace_id uuid unique references public.workspaces(id),
  bound_at timestamptz,
  check(expires_at=captured_at+interval '168 hours'),
  check((workspace_id is null)=(bound_at is null)),
  check(workspace_id is null or actor_auth_user_id is not null),
  check(bound_at is null or bound_at>=captured_at)
);
create index if not exists growth_partner_sources_actor_idx on public.growth_partner_sources(actor_auth_user_id,captured_at,id);
alter table public.growth_partner_sources enable row level security;
revoke all on table public.growth_partner_sources from public,anon,authenticated,service_role;
do $$ begin
  if not exists(select 1 from pg_class where oid='public.growth_partner_sources'::regclass
    and relkind='r' and relowner=to_regrole('postgres') and relrowsecurity)
    or (select count(*) from pg_attribute where attrelid='public.growth_partner_sources'::regclass and attnum>0 and not attisdropped)<>10
    then raise exception 'partner_source_schema_unconfirmed'; end if;
end $$;

-- Profile first, workspace/staff (when binding), then commercial partner. This
-- composes with 109 readers and the existing workspace -> partner payment locks.
create or replace function public.partner_source_profile(p_partner uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare actor uuid;
begin
  select auth_user_id into actor from public.growth_partners where id=p_partner;
  if actor is null then raise exception using errcode='P1121',message='partner_source_unavailable'; end if;
  perform 1 from public.growth_contributor_profiles where auth_user_id=actor and partner_status='approved' for update;
  if not found then raise exception using errcode='P1121',message='partner_source_unavailable'; end if;
  return actor;
end $$;

create or replace function public.partner_source_result(p_source public.growth_partner_sources)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
begin
  if p_source.workspace_id is not null and not exists(select 1 from public.growth_referrals r
    where r.workspace_id=p_source.workspace_id and r.partner_id=p_source.partner_id and r.source=p_source.source)
    then raise exception using errcode='P1122',message='partner_source_inconsistent'; end if;
  return jsonb_build_object('id',p_source.id,
    'state',case when p_source.workspace_id is not null then 'bound' when p_source.expires_at<=clock_timestamp() then 'expired' else 'captured' end,
    'source',p_source.source,
    'capturedAt',to_char(p_source.captured_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'expiresAt',to_char(p_source.expires_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'policyVersion',p_source.policy_version,
    'workspaceId',p_source.workspace_id);
end;
$$;

create or replace function public.partner_source_owner(p_actor uuid,p_workspace uuid)
returns timestamptz language plpgsql security definer set search_path='' as $$
declare created timestamptz;
begin
  select created_at into created from public.workspaces where id=p_workspace for update;
  if not found then raise exception using errcode='P1121',message='partner_source_unavailable'; end if;
  perform 1 from public.staff_users where workspace_id=p_workspace and auth_user_id=p_actor and role='owner' and status='active' for update;
  if not found then raise exception using errcode='P1121',message='partner_source_unavailable'; end if;
  if created is null or not isfinite(created) or created>clock_timestamp()
    then raise exception using errcode='P1122',message='partner_source_creation_unconfirmed'; end if;
  return created;
end $$;

create or replace function public.capture_growth_partner_source(
  p_intent uuid,p_capability_hash text,p_code text,p_source text
) returns jsonb language plpgsql security definer set search_path='' set lock_timeout='3s' set statement_timeout='8s' as $$
declare saved public.growth_partner_sources; partner public.growth_partners; partner_actor uuid; captured timestamptz;
begin
  if current_setting('transaction_isolation')<>'read committed'
    then raise exception using errcode='P1122',message='partner_source_snapshot_unconfirmed'; end if;
  if p_intent is null or p_capability_hash is null or p_capability_hash !~ '^[0-9a-f]{64}$'
    or p_code is null or p_code !~ '^[A-Z0-9_-]{4,40}$'
    or p_source is null or p_source not in ('link','promo_code')
    then raise exception using errcode='P1122',message='invalid_partner_source'; end if;
  perform pg_advisory_xact_lock(hashtextextended('partner-source:'||p_intent::text,0));
  select * into saved from public.growth_partner_sources where id=p_intent;
  if found and saved.capability_hash<>p_capability_hash
    then raise exception using errcode='P1121',message='partner_source_unavailable'; end if;
  if saved.id is null then
    select * into partner from public.growth_partners where referral_code=p_code;
    if not found then raise exception using errcode='P1121',message='partner_source_unavailable'; end if;
  else
    select * into partner from public.growth_partners where id=saved.partner_id;
  end if;
  partner_actor:=public.partner_source_profile(partner.id);
  select * into partner from public.growth_partners where id=partner.id and auth_user_id=partner_actor and status='active' for update;
  if not found
    then raise exception using errcode='P1121',message='partner_source_unavailable'; end if;
  if saved.id is null then
    captured:=clock_timestamp();
    insert into public.growth_partner_sources(id,capability_hash,partner_id,source,captured_at,expires_at,policy_version)
      values(p_intent,p_capability_hash,partner.id,p_source,captured,captured+interval '168 hours','2026-10-27-7d-self-v1') returning * into saved;
  end if;
  -- Possession of a visit cookie is not current account/workspace authority.
  return public.partner_source_result(saved)-'workspaceId'-'state'-'source';
end $$;

create or replace function public.claim_growth_partner_source(p_actor uuid,p_intent uuid,p_capability_hash text)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='3s' set statement_timeout='8s' as $$
declare saved public.growth_partner_sources; partner_actor uuid;
begin
  if current_setting('transaction_isolation')<>'read committed'
    then raise exception using errcode='P1122',message='partner_source_snapshot_unconfirmed'; end if;
  if p_actor is null or p_intent is null or p_capability_hash is null or p_capability_hash !~ '^[0-9a-f]{64}$'
    then raise exception using errcode='P1121',message='partner_source_unavailable'; end if;
  perform pg_advisory_xact_lock(hashtextextended('partner-source:'||p_intent::text,0));
  select * into saved from public.growth_partner_sources where id=p_intent and capability_hash=p_capability_hash;
  if not found or (saved.actor_auth_user_id is not null and saved.actor_auth_user_id<>p_actor)
    then raise exception using errcode='P1121',message='partner_source_unavailable'; end if;
  partner_actor:=public.partner_source_profile(saved.partner_id);
  if saved.workspace_id is not null then perform public.partner_source_owner(p_actor,saved.workspace_id); end if;
  perform 1 from public.growth_partners where id=saved.partner_id and auth_user_id=partner_actor and status='active' for update;
  if not found then raise exception using errcode='P1121',message='partner_source_unavailable'; end if;
  if saved.actor_auth_user_id is null and saved.expires_at>clock_timestamp() then
    update public.growth_partner_sources set actor_auth_user_id=p_actor where id=saved.id returning * into saved;
  end if;
  return public.partner_source_result(saved);
end $$;

create or replace function public.read_growth_partner_source(p_actor uuid,p_intent uuid)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='3s' set statement_timeout='8s' as $$
declare saved public.growth_partner_sources; partner_actor uuid;
begin
  if current_setting('transaction_isolation')<>'read committed'
    then raise exception using errcode='P1122',message='partner_source_snapshot_unconfirmed'; end if;
  if p_actor is null or p_intent is null then raise exception using errcode='P1121',message='partner_source_unavailable'; end if;
  perform pg_advisory_xact_lock(hashtextextended('partner-source:'||p_intent::text,0));
  select * into saved from public.growth_partner_sources where id=p_intent;
  if not found then return jsonb_build_object('state','unconfirmed'); end if;
  if saved.actor_auth_user_id is distinct from p_actor then raise exception using errcode='P1121',message='partner_source_unavailable'; end if;
  partner_actor:=public.partner_source_profile(saved.partner_id);
  if saved.workspace_id is not null then perform public.partner_source_owner(p_actor,saved.workspace_id); end if;
  perform 1 from public.growth_partners where id=saved.partner_id and auth_user_id=partner_actor and status='active' for update;
  if not found then raise exception using errcode='P1121',message='partner_source_unavailable'; end if;
  return public.partner_source_result(saved);
end $$;

create or replace function public.bind_growth_partner_source(p_actor uuid,p_intent uuid,p_workspace uuid)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='3s' set statement_timeout='8s' as $$
declare saved public.growth_partner_sources; partner_actor uuid; partner public.growth_partners;
  created timestamptz; bound_partner uuid;
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
  select * into partner from public.growth_partners where id=saved.partner_id and auth_user_id=partner_actor and status='active' for update;
  if not found then raise exception using errcode='P1121',message='partner_source_unavailable'; end if;
  if saved.workspace_id is not null then
    if saved.workspace_id<>p_workspace then raise exception using errcode='P1123',message='partner_source_conflict'; end if;
    if not exists(select 1 from public.growth_referrals where workspace_id=p_workspace and partner_id=saved.partner_id and source=saved.source)
      then raise exception using errcode='P1122',message='partner_source_inconsistent'; end if;
    return public.partner_source_result(saved);
  end if;
  -- An absent new ledger is not proof that a legacy company never paid. The
  -- source must predate creation, not merely its first payment in table 052.
  if created<saved.captured_at or saved.expires_at<=clock_timestamp()
    or exists(select 1 from public.growth_referrals where workspace_id=p_workspace)
    or exists(select 1 from public.platform_subscription_payments where workspace_id=p_workspace)
    then raise exception using errcode='P1123',message='partner_source_conflict'; end if;
  bound_partner:=public.bind_growth_referral(p_workspace,partner.referral_code,saved.source);
  if bound_partner is distinct from saved.partner_id then raise exception using errcode='P1122',message='partner_source_inconsistent'; end if;
  update public.growth_partner_sources set workspace_id=p_workspace,bound_at=clock_timestamp() where id=saved.id returning * into saved;
  return public.partner_source_result(saved);
end $$;

revoke all on function public.partner_source_profile(uuid) from public,anon,authenticated,service_role;
revoke all on function public.partner_source_result(public.growth_partner_sources) from public,anon,authenticated,service_role;
revoke all on function public.partner_source_owner(uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function public.capture_growth_partner_source(uuid,text,text,text) from public,anon,authenticated,service_role;
revoke all on function public.claim_growth_partner_source(uuid,uuid,text) from public,anon,authenticated,service_role;
revoke all on function public.read_growth_partner_source(uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function public.bind_growth_partner_source(uuid,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.capture_growth_partner_source(uuid,text,text,text) to service_role;
grant execute on function public.claim_growth_partner_source(uuid,uuid,text) to service_role;
grant execute on function public.read_growth_partner_source(uuid,uuid) to service_role;
grant execute on function public.bind_growth_partner_source(uuid,uuid,uuid) to service_role;
-- Coordinate the caller cutover; never leave a second, unfenced service writer.
revoke all on function public.bind_growth_referral(uuid,text,text) from public,anon,authenticated,service_role;
do $$ declare role_name text; signature text; begin
  foreach role_name in array array['anon','authenticated','service_role'] loop
    if has_table_privilege(role_name,'public.growth_partner_sources','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      or has_any_column_privilege(role_name,'public.growth_partner_sources','SELECT,INSERT,UPDATE,REFERENCES')
      then raise exception 'partner_source_executors_unconfirmed'; end if;
    foreach signature in array array['public.partner_source_profile(uuid)','public.partner_source_result(public.growth_partner_sources)',
      'public.partner_source_owner(uuid,uuid)','public.bind_growth_referral(uuid,text,text)'] loop
      if has_function_privilege(role_name,signature,'EXECUTE') then raise exception 'partner_source_executors_unconfirmed'; end if;
    end loop;
    foreach signature in array array['public.capture_growth_partner_source(uuid,text,text,text)','public.claim_growth_partner_source(uuid,uuid,text)',
      'public.read_growth_partner_source(uuid,uuid)','public.bind_growth_partner_source(uuid,uuid,uuid)'] loop
      if has_function_privilege(role_name,signature,'EXECUTE') is distinct from (role_name='service_role')
        then raise exception 'partner_source_executors_unconfirmed'; end if;
    end loop;
  end loop;
end $$;
notify pgrst,'reload schema';
commit;
