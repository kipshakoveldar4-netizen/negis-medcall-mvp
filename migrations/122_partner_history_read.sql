-- Local read-only journal. Does not create payments, commissions or transfers.
begin;
set local lock_timeout='3s';
set local statement_timeout='30s';

do $$ declare relation text; dependency record; begin
  if current_user<>'postgres'
    or not exists(select 1 from pg_roles where rolname='service_role' and rolbypassrls and not rolsuper)
    or exists(select 1 from pg_roles where rolname in ('anon','authenticated') and (rolsuper or rolbypassrls))
    or exists(select 1 from pg_roles b cross join pg_roles p where b.rolname in ('anon','authenticated')
      and (p.rolsuper or p.rolbypassrls or p.rolname='postgres') and pg_has_role(b.oid,p.oid,'MEMBER'))
    then raise exception 'partner_history_dependencies_unconfirmed'; end if;
  foreach relation in array array['growth_contributor_profiles','growth_partners','growth_referrals',
    'platform_subscription_payments','growth_partner_commissions','growth_partner_payouts'] loop
    if not exists(select 1 from pg_class where oid=to_regclass('public.'||relation) and relkind='r'
      and relowner=to_regrole('postgres') and relrowsecurity)
      then raise exception 'partner_history_dependencies_unconfirmed'; end if;
  end loop;
  -- The pinned ledger checks authority, consistency and the common partner lock.
  -- Keep both the current payment wrapper and original serialized writer pinned.
  for dependency in select * from (values
    ('public.read_growth_partner_ledger(uuid)','f02046655e943995eaa119ec2fbd69bff813372037d0257b3db429930b183141','jsonb'),
    ('public.confirm_growth_subscription_payment(uuid,uuid,bigint,text,timestamptz,uuid,uuid)','273f43042c08231da06edce705cffbe6bf7be8a2c7c280acc83d992bd5853446','uuid'),
    ('public.confirm_growth_subscription_payment_052(uuid,uuid,bigint,text,timestamptz,uuid,uuid)','1c23a77f6a93f9fc8b90a65fce9b0795875a823b792530f9838faee90c1ad602','uuid'),
    ('public.confirm_growth_partner_payout(uuid,bigint,text,timestamptz,uuid,uuid)','ceb1a9f8089592c12887ee5f1e022a24674f5c956e5e2563f8ff183075fbe429','uuid')
  ) expected(signature,digest,result_type) loop
    if not exists(select 1 from pg_proc p where p.oid=to_regprocedure(dependency.signature) and p.proowner=to_regrole('postgres')
      and p.prosecdef and p.provolatile='v' and not p.proretset and p.prorettype=to_regtype(dependency.result_type)
      and 'search_path=""'=any(p.proconfig)
      and encode(sha256(convert_to(replace(p.prosrc,E'\r\n',E'\n'),'UTF8')),'hex')=dependency.digest)
      then raise exception 'partner_history_dependencies_unconfirmed'; end if;
  end loop;
end $$;

create index if not exists growth_partner_commissions_history_idx
  on public.growth_partner_commissions(partner_id,created_at desc,id);
create index if not exists growth_partner_payouts_history_idx
  on public.growth_partner_payouts(partner_id,confirmed_at desc,id);

create or replace function public.read_growth_partner_history(p_actor uuid,p_offset integer default 0,p_month text default null)
returns jsonb language plpgsql volatile security definer set search_path='' set lock_timeout='3s' set statement_timeout='8s' as $$
declare authority jsonb; partner uuid; starts timestamptz; ends timestamptz; page jsonb; more boolean;
begin
  if p_offset is null or p_offset<0 or p_offset>1000000
    or (p_month is not null and (p_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' or left(p_month,4)='0000'))
    then raise exception using errcode='P1222',message='partner_history_query_invalid'; end if;
  authority:=public.read_growth_partner_ledger(p_actor);
  if authority->>'state' in ('not_activated','suspended') then return authority; end if;
  if authority->>'state' is distinct from 'ready' then
    raise exception using errcode='P1092',message='partner_report_inconsistent'; end if;
  select id into partner from public.growth_partners where auth_user_id=p_actor;
  if partner is null then raise exception using errcode='P1091',message='partner_report_access_denied'; end if;
  if exists(select 1 from public.growth_partner_commissions where partner_id=partner and not isfinite(created_at))
    or exists(select 1 from public.growth_partner_payouts where partner_id=partner and not isfinite(confirmed_at))
    then raise exception using errcode='P1092',message='partner_report_inconsistent'; end if;
  if p_month is not null then
    starts:=(p_month||'-01')::date::timestamp at time zone 'UTC';
    ends:=((p_month||'-01')::date+interval '1 month') at time zone 'UTC';
  end if;
  -- Occurrence is posting/confirmation time, not a bank-paid timestamp.
  -- Locks acquired by read_growth_partner_ledger stay held throughout this RPC.
  with events as (
    select c.id,case p.kind when 'first' then 'first_payment' else 'renewal' end kind,
      c.created_at occurred_at,c.amount_minor,c.currency
      from public.growth_partner_commissions c join public.platform_subscription_payments p on p.id=c.payment_id
      where c.partner_id=partner
    union all
    select id,'payout',confirmed_at,amount_minor,currency from public.growth_partner_payouts where partner_id=partner
  ), selected as (
    select * from events where p_month is null or (occurred_at>=starts and occurred_at<ends)
    order by occurred_at desc,kind collate "C",id offset p_offset limit 21
  ), numbered as (
    select *,row_number() over(order by occurred_at desc,kind collate "C",id) position from selected
  ) select coalesce(jsonb_agg(jsonb_build_object('id',id,'kind',kind,
    'occurredAt',to_char(occurred_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'amountMinor',amount_minor::text,'currency',currency) order by position) filter(where position<=20),'[]'::jsonb),
    coalesce(max(position)>20,false) into page,more from numbered;
  return jsonb_build_object('state','ready','generatedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'offset',p_offset,'month',p_month,'items',page,'hasMore',more);
end $$;

revoke all on function public.read_growth_partner_history(uuid,integer,text) from public,anon,authenticated,service_role;
grant execute on function public.read_growth_partner_history(uuid,integer,text) to service_role;
do $$ declare role_name text; begin
  foreach role_name in array array['anon','authenticated','service_role'] loop
    if has_function_privilege(role_name,'public.read_growth_partner_history(uuid,integer,text)','EXECUTE') is distinct from (role_name='service_role')
      then raise exception 'partner_history_executor_unconfirmed'; end if;
  end loop;
end $$;
notify pgrst,'reload schema';
commit;
