-- Local read-only partner report; intake approval never creates commercial terms.
begin;
set local lock_timeout='3s';
set local statement_timeout='30s';

do $$ declare dependency record; relation text; begin
  if current_user<>'postgres'
    or not exists(select 1 from pg_roles where rolname='service_role' and rolbypassrls and not rolsuper)
    or exists(select 1 from pg_roles where rolname in ('anon','authenticated') and (rolsuper or rolbypassrls))
    or exists(select 1 from pg_roles b cross join pg_roles p where b.rolname in ('anon','authenticated')
      and (p.rolsuper or p.rolbypassrls or p.rolname='postgres') and pg_has_role(b.oid,p.oid,'MEMBER'))
    then raise exception 'partner_report_dependencies_unconfirmed'; end if;
  foreach relation in array array['growth_contributor_profiles','growth_partners','growth_referrals',
    'platform_subscription_payments','growth_partner_commissions','growth_partner_payouts'] loop
    if not exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public'
      and c.relname=relation and c.relkind='r' and c.relowner=to_regrole('postgres') and c.relrowsecurity)
      then raise exception 'partner_report_dependencies_unconfirmed'; end if;
  end loop;
  -- All three existing writers serialize on the partner row. Pin that protocol;
  -- a statement after the lock wait then observes one coherent committed ledger.
  for dependency in select * from (values
    ('public.bind_growth_referral(uuid,text,text)','21e83d9cf30090f24e1b7c1872528a91c160dfbba615131b915fbe4f0dab8a8a'),
    ('public.confirm_growth_subscription_payment(uuid,uuid,bigint,text,timestamptz,uuid,uuid)','1c23a77f6a93f9fc8b90a65fce9b0795875a823b792530f9838faee90c1ad602'),
    ('public.confirm_growth_partner_payout(uuid,bigint,text,timestamptz,uuid,uuid)','ceb1a9f8089592c12887ee5f1e022a24674f5c956e5e2563f8ff183075fbe429')
  ) expected(signature,digest) loop
    if not exists(select 1 from pg_proc p where p.oid=to_regprocedure(dependency.signature)
      and p.proowner=to_regrole('postgres') and p.prosecdef and p.provolatile='v'
      and p.prorettype='uuid'::regtype and not p.proretset and 'search_path=""'=any(p.proconfig)
      and encode(sha256(convert_to(replace(p.prosrc,E'\r\n',E'\n'),'UTF8')),'hex')=dependency.digest)
      then raise exception 'partner_report_dependencies_unconfirmed'; end if;
  end loop;
end $$;

create or replace function public.read_growth_partner_ledger(p_actor uuid)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='3s' set statement_timeout='8s' as $$
declare partner public.growth_partners%rowtype; result jsonb;
begin
  if p_actor is null then raise exception using errcode='P1091',message='partner_report_access_denied'; end if;
  if current_setting('transaction_isolation')<>'read committed'
    then raise exception using errcode='P1092',message='partner_report_snapshot_unconfirmed'; end if;
  perform 1 from public.growth_contributor_profiles where auth_user_id=p_actor and partner_status='approved' for update;
  if not found then raise exception using errcode='P1091',message='partner_report_access_denied'; end if;
  select * into partner from public.growth_partners where auth_user_id=p_actor for update;
  if not found then return jsonb_build_object('state','not_activated'); end if;
  if partner.status='suspended' then return jsonb_build_object('state','suspended'); end if;
  if partner.status<>'active' then raise exception using errcode='P1092',message='partner_report_inconsistent'; end if;

  if exists(select 1 from public.growth_partner_commissions c
    left join public.platform_subscription_payments p on p.id=c.payment_id
    left join public.growth_referrals r on r.workspace_id=p.workspace_id
    where c.partner_id=partner.id and (p.id is null or r.partner_id is distinct from partner.id
      or c.currency<>p.currency or c.amount_minor<>floor(p.amount_minor::numeric*c.rate_bps/10000)
      or (p.kind='first' and c.rate_bps not between 1000 and 5000)
      or (p.kind='renewal' and c.rate_bps not between 500 and 1000)))
    or exists(select 1 from public.platform_subscription_payments p
      join public.growth_referrals r on r.workspace_id=p.workspace_id
      left join public.growth_partner_commissions c on c.payment_id=p.id
      where r.partner_id=partner.id and (c.id is null or c.partner_id is distinct from partner.id))
    then raise exception using errcode='P1092',message='partner_report_inconsistent'; end if;

  with referred as (select workspace_id from public.growth_referrals where partner_id=partner.id),
  receipts as (select p.workspace_id,p.kind from public.platform_subscription_payments p join referred r using(workspace_id)),
  earned as (select currency,sum(amount_minor) amount from public.growth_partner_commissions where partner_id=partner.id group by currency),
  paid as (select currency,sum(amount_minor) amount from public.growth_partner_payouts where partner_id=partner.id group by currency),
  balances as (select coalesce(e.currency,p.currency) currency,coalesce(e.amount,0) earned,coalesce(p.amount,0) paid
    from earned e full join paid p using(currency))
  select jsonb_build_object('state','ready',
    'generatedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'firstCommissionBps',partner.first_commission_bps,'renewalCommissionBps',partner.renewal_commission_bps,
    'registrations',(select count(*)::text from referred),
    'paidCompanies',(select count(distinct workspace_id)::text from receipts),
    'firstPayments',(select count(*)::text from receipts where kind='first'),
    'renewals',(select count(*)::text from receipts where kind='renewal'),
    'balances',coalesce((select jsonb_agg(jsonb_build_object('currency',currency,'earnedMinor',earned::text,
      'paidMinor',paid::text,'availableMinor',(earned-paid)::text) order by currency) from balances),'[]'::jsonb)) into result;
  if jsonb_array_length(result->'balances')>256 or exists(select 1 from jsonb_array_elements(result->'balances') b
    where (b->>'availableMinor')::numeric<0)
    then raise exception using errcode='P1092',message='partner_report_inconsistent'; end if;
  return result;
end $$;

revoke all on function public.read_growth_partner_ledger(uuid) from public,anon,authenticated,service_role;
grant execute on function public.read_growth_partner_ledger(uuid) to service_role;
do $$ declare role_name text; begin
  foreach role_name in array array['anon','authenticated','service_role'] loop
    if has_function_privilege(role_name,'public.read_growth_partner_ledger(uuid)','EXECUTE') is distinct from (role_name='service_role')
      then raise exception 'partner_report_executor_unconfirmed'; end if;
  end loop;
end $$;
notify pgrst,'reload schema';
commit;
