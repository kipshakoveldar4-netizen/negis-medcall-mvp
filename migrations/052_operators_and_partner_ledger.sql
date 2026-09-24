-- Medina growth foundation. No traffic, onboarding or payment automation is enabled.
-- Server-only tables: browser access must go through verified application handlers.
begin;

create table if not exists public.growth_operator_profiles (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null unique,
  display_name text not null check (char_length(btrim(display_name)) between 1 and 120),
  status text not null default 'pending' check (status in ('pending', 'approved', 'suspended')),
  accepting_requests boolean not null default false,
  approved_by uuid,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  check ((approved_by is null) = (approved_at is null)),
  check (status <> 'approved' or approved_at is not null),
  check (not accepting_requests or status = 'approved')
);

create table if not exists public.growth_operator_requests (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id),
  operator_id uuid not null references public.growth_operator_profiles(id),
  requested_by_staff_user_id uuid not null references public.staff_users(id),
  -- A clinic brief, never patient information or credentials.
  clinic_brief text not null check (char_length(btrim(clinic_brief)) between 1 and 2000),
  status text not null default 'requested' check (status in ('requested', 'accepted', 'declined', 'ended')),
  price_per_arrival_minor bigint check (price_per_arrival_minor >= 0),
  currency text not null default 'KZT' check (currency ~ '^[A-Z]{3}$'),
  accepted_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  unique (id, workspace_id),
  check ((status in ('accepted', 'ended')) = (accepted_at is not null)),
  check (status not in ('accepted', 'ended') or price_per_arrival_minor is not null),
  check ((status = 'ended') = (ended_at is not null)),
  check (ended_at is null or ended_at >= accepted_at)
);

create unique index if not exists growth_operator_requests_live_idx
  on public.growth_operator_requests(workspace_id, operator_id)
  where status in ('requested', 'accepted');
create index if not exists growth_operator_requests_inbox_idx
  on public.growth_operator_requests(operator_id, status, created_at desc);

create table if not exists public.growth_operator_arrivals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id),
  operator_request_id uuid not null,
  appointment_id uuid not null references public.appointments(id),
  clinic_confirmed_by_staff_user_id uuid not null references public.staff_users(id),
  clinic_confirmed_at timestamptz not null default now(),
  price_minor bigint not null check (price_minor >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  operator_checked_at timestamptz,
  operator_check_result text check (operator_check_result in ('confirmed', 'unconfirmed')),
  unique (workspace_id, appointment_id),
  foreign key (operator_request_id, workspace_id)
    references public.growth_operator_requests(id, workspace_id),
  check ((operator_checked_at is null) = (operator_check_result is null))
);

create table if not exists public.growth_partners (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null unique,
  display_name text not null check (char_length(btrim(display_name)) between 1 and 120),
  referral_code text not null unique check (referral_code ~ '^[A-Z0-9_-]{4,40}$'),
  status text not null default 'active' check (status in ('active', 'suspended')),
  -- No automatic tier thresholds or invented individual rate.
  first_commission_bps integer check (first_commission_bps between 1000 and 5000),
  renewal_commission_bps integer check (renewal_commission_bps between 500 and 1000),
  created_at timestamptz not null default now()
);

create table if not exists public.growth_referrals (
  workspace_id uuid primary key references public.workspaces(id),
  partner_id uuid not null references public.growth_partners(id),
  source text not null check (source in ('link', 'promo_code')),
  registered_at timestamptz not null default now()
);
create index if not exists growth_referrals_partner_idx
  on public.growth_referrals(partner_id, registered_at desc);

-- A subscription's active flag or list price is not proof of a payment.
-- These append-only receipts represent manually confirmed incoming payments.
create table if not exists public.platform_subscription_payments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id),
  subscription_id uuid not null references public.platform_subscriptions(id),
  request_key uuid not null unique,
  kind text not null check (kind in ('first', 'renewal')),
  amount_minor bigint not null check (amount_minor > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  paid_at timestamptz not null,
  confirmed_by uuid not null,
  confirmed_at timestamptz not null default now()
);
create unique index if not exists platform_subscription_payments_first_idx
  on public.platform_subscription_payments(workspace_id) where kind = 'first';
create index if not exists platform_subscription_payments_workspace_idx
  on public.platform_subscription_payments(workspace_id, paid_at desc);

create table if not exists public.growth_partner_commissions (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null unique references public.platform_subscription_payments(id),
  partner_id uuid not null references public.growth_partners(id),
  rate_bps integer not null check (rate_bps between 500 and 5000),
  amount_minor bigint not null check (amount_minor >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  created_at timestamptz not null default now()
);
create index if not exists growth_partner_commissions_balance_idx
  on public.growth_partner_commissions(partner_id, currency);

create table if not exists public.growth_partner_payouts (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid not null references public.growth_partners(id),
  request_key uuid not null unique,
  amount_minor bigint not null check (amount_minor > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  paid_at timestamptz not null,
  confirmed_by uuid not null,
  confirmed_at timestamptz not null default now()
);
create index if not exists growth_partner_payouts_balance_idx
  on public.growth_partner_payouts(partner_id, currency);

alter table public.growth_operator_profiles enable row level security;
alter table public.growth_operator_requests enable row level security;
alter table public.growth_operator_arrivals enable row level security;
alter table public.growth_partners enable row level security;
alter table public.growth_referrals enable row level security;
alter table public.platform_subscription_payments enable row level security;
alter table public.growth_partner_commissions enable row level security;
alter table public.growth_partner_payouts enable row level security;

revoke all on table public.growth_operator_profiles, public.growth_operator_requests,
  public.growth_operator_arrivals, public.growth_partners, public.growth_referrals,
  public.platform_subscription_payments, public.growth_partner_commissions,
  public.growth_partner_payouts from public, anon, authenticated, service_role;
grant select on table public.growth_operator_profiles, public.growth_operator_requests,
  public.growth_operator_arrivals, public.growth_partners, public.growth_referrals,
  public.platform_subscription_payments, public.growth_partner_commissions,
  public.growth_partner_payouts to service_role;
grant insert, update on table public.growth_operator_profiles,
  public.growth_operator_requests, public.growth_partners to service_role;

-- The requested staff record must belong to this clinic. Accepting a request
-- does not grant membership or launch ads; those remain separate guarded flows.
create or replace function public.check_growth_operator_request()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'requested' then raise exception 'operator_request_must_start_requested'; end if;
    if not exists (select 1 from public.growth_operator_profiles
      where id = new.operator_id and status = 'approved' and accepting_requests)
    then raise exception 'operator_not_accepting_requests'; end if;
  end if;
  if not exists (
    select 1 from public.staff_users s
    where s.id = new.requested_by_staff_user_id and s.workspace_id = new.workspace_id
      and s.status = 'active' and s.role in ('owner', 'admin', 'manager')
  ) then raise exception 'clinic_requester_required'; end if;
  if tg_op = 'UPDATE' then
    if new.workspace_id is distinct from old.workspace_id
      or new.operator_id is distinct from old.operator_id
      or new.requested_by_staff_user_id is distinct from old.requested_by_staff_user_id
    then raise exception 'operator_request_identity_immutable'; end if;
    if old.status in ('accepted', 'ended') and (
      new.price_per_arrival_minor is distinct from old.price_per_arrival_minor
      or new.currency is distinct from old.currency
      or new.accepted_at is distinct from old.accepted_at
    ) then raise exception 'accepted_terms_immutable'; end if;
    if new.status <> old.status and not (
      (old.status = 'requested' and new.status in ('accepted', 'declined'))
      or (old.status = 'accepted' and new.status = 'ended')
    ) then raise exception 'operator_request_transition_invalid'; end if;
  end if;
  return new;
end;
$$;
drop trigger if exists growth_operator_request_guard on public.growth_operator_requests;
create trigger growth_operator_request_guard before insert or update
  on public.growth_operator_requests for each row execute function public.check_growth_operator_request();

create or replace function public.accept_growth_operator_request(p_request_id uuid, p_operator_user_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare r public.growth_operator_requests%rowtype;
begin
  select * into r from public.growth_operator_requests where id = p_request_id for update;
  if not found then raise exception 'operator_request_unavailable'; end if;
  perform 1 from public.growth_operator_profiles
    where id = r.operator_id and auth_user_id = p_operator_user_id
      and status = 'approved' for update;
  if not found then raise exception 'approved_operator_required'; end if;
  if r.status = 'accepted' then return r.id; end if;
  if r.status <> 'requested' or r.price_per_arrival_minor is null
  then raise exception 'agreed_terms_required'; end if;
  update public.growth_operator_requests set status = 'accepted', accepted_at = now()
    where id = r.id;
  return r.id;
end;
$$;

create or replace function public.confirm_growth_operator_arrival(
  p_request_id uuid, p_appointment_id uuid, p_clinic_staff_id uuid
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare r public.growth_operator_requests%rowtype;
  a public.growth_operator_arrivals%rowtype;
  result_id uuid;
begin
  select * into r from public.growth_operator_requests where id = p_request_id for update;
  if not found or r.status <> 'accepted' then raise exception 'accepted_assignment_required'; end if;
  perform 1 from public.staff_users s
    where s.id = p_clinic_staff_id and s.workspace_id = r.workspace_id
      and s.status = 'active' and s.role in ('owner', 'admin', 'manager', 'receptionist')
      and s.auth_user_id is not null
      and s.auth_user_id <> (select auth_user_id from public.growth_operator_profiles where id = r.operator_id);
  if not found then raise exception 'clinic_confirmation_required'; end if;
  perform 1 from public.appointments where id = p_appointment_id and workspace_id = r.workspace_id for update;
  if not found then raise exception 'appointment_unavailable'; end if;
  select * into a from public.growth_operator_arrivals
    where workspace_id = r.workspace_id and appointment_id = p_appointment_id;
  if found then
    if a.operator_request_id <> r.id then raise exception 'arrival_already_assigned'; end if;
    return a.id;
  end if;
  insert into public.growth_operator_arrivals (
    workspace_id, operator_request_id, appointment_id, clinic_confirmed_by_staff_user_id,
    price_minor, currency
  ) values (r.workspace_id, r.id, p_appointment_id, p_clinic_staff_id, r.price_per_arrival_minor, r.currency)
    returning id into result_id;
  return result_id;
end;
$$;

create or replace function public.record_growth_operator_check(
  p_arrival_id uuid, p_operator_user_id uuid, p_result text
)
returns uuid language plpgsql security definer set search_path = '' as $$
begin
  if p_result is null or p_result not in ('confirmed', 'unconfirmed')
  then raise exception 'operator_check_invalid'; end if;
  -- Supplemental call verification never substitutes for clinic confirmation.
  perform 1 from public.growth_operator_arrivals a
    join public.growth_operator_requests r on r.id = a.operator_request_id
    join public.growth_operator_profiles o on o.id = r.operator_id
    where a.id = p_arrival_id and o.auth_user_id = p_operator_user_id and o.status = 'approved'
    for update of a;
  if not found then raise exception 'arrival_unavailable'; end if;
  update public.growth_operator_arrivals set operator_checked_at = now(), operator_check_result = p_result
    where id = p_arrival_id;
  return p_arrival_id;
end;
$$;

create or replace function public.bind_growth_referral(p_workspace_id uuid, p_code text, p_source text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare result_id uuid;
begin
  perform 1 from public.workspaces where id = p_workspace_id for update;
  if not found then raise exception 'workspace_unavailable'; end if;
  select partner_id into result_id from public.growth_referrals where workspace_id = p_workspace_id;
  -- First binding wins, including when a later link names another partner.
  if found then return result_id; end if;
  if p_source is null or p_source not in ('link', 'promo_code')
  then raise exception 'referral_source_invalid'; end if;
  if exists (select 1 from public.platform_subscription_payments where workspace_id = p_workspace_id)
  then raise exception 'referral_after_payment'; end if;
  select id into result_id from public.growth_partners
    where referral_code = upper(btrim(p_code)) and status = 'active' for update;
  if not found then raise exception 'partner_unavailable'; end if;
  insert into public.growth_referrals(workspace_id, partner_id, source)
    values (p_workspace_id, result_id, p_source);
  return result_id;
end;
$$;

create or replace function public.confirm_growth_subscription_payment(
  p_workspace_id uuid, p_subscription_id uuid, p_amount_minor bigint, p_currency text,
  p_paid_at timestamptz, p_request_key uuid, p_confirmed_by uuid
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare receipt public.platform_subscription_payments%rowtype;
  partner public.growth_partners%rowtype;
  bound_partner_id uuid;
  rate integer;
  payment_kind text;
  result_id uuid;
begin
  if p_workspace_id is null or p_subscription_id is null
    or p_amount_minor is null or p_amount_minor <= 0 or p_currency is null or p_currency !~ '^[A-Z]{3}$'
    or p_paid_at is null or p_paid_at > now() or p_request_key is null or p_confirmed_by is null
  then raise exception 'payment_invalid'; end if;
  perform 1 from public.workspaces where id = p_workspace_id for update;
  if not found then raise exception 'workspace_unavailable'; end if;
  select * into receipt from public.platform_subscription_payments where request_key = p_request_key;
  if found then
    if receipt.workspace_id <> p_workspace_id or receipt.subscription_id <> p_subscription_id
      or receipt.amount_minor <> p_amount_minor or receipt.currency <> p_currency or receipt.paid_at <> p_paid_at
    then raise exception 'payment_request_conflict'; end if;
    return receipt.id;
  end if;
  perform 1 from public.platform_subscriptions
    where id = p_subscription_id and workspace_id = p_workspace_id and currency = p_currency;
  if not found then raise exception 'subscription_unavailable'; end if;
  if exists (select 1 from public.platform_subscription_payments
    where workspace_id = p_workspace_id and paid_at > p_paid_at)
  then raise exception 'payment_chronology_required'; end if;
  payment_kind := case when exists (
    select 1 from public.platform_subscription_payments where workspace_id = p_workspace_id
  ) then 'renewal' else 'first' end;
  select partner_id into bound_partner_id from public.growth_referrals where workspace_id = p_workspace_id;
  if found then
    select * into partner from public.growth_partners where id = bound_partner_id for update;
    rate := case when payment_kind = 'first' then partner.first_commission_bps else partner.renewal_commission_bps end;
    if partner.status <> 'active' or rate is null then raise exception 'partner_terms_required'; end if;
  end if;
  insert into public.platform_subscription_payments (
    workspace_id, subscription_id, request_key, kind, amount_minor, currency, paid_at, confirmed_by
  ) values (p_workspace_id, p_subscription_id, p_request_key, payment_kind, p_amount_minor, p_currency, p_paid_at, p_confirmed_by)
    returning id into result_id;
  if bound_partner_id is not null then
    insert into public.growth_partner_commissions(payment_id, partner_id, rate_bps, amount_minor, currency)
      values (result_id, bound_partner_id, rate, floor(p_amount_minor::numeric * rate / 10000)::bigint, p_currency);
  end if;
  return result_id;
end;
$$;

create or replace function public.confirm_growth_partner_payout(
  p_partner_id uuid, p_amount_minor bigint, p_currency text, p_paid_at timestamptz,
  p_request_key uuid, p_confirmed_by uuid
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare payout public.growth_partner_payouts%rowtype;
  earned numeric;
  paid numeric;
  result_id uuid;
begin
  if p_amount_minor is null or p_amount_minor <= 0 or p_currency is null or p_currency !~ '^[A-Z]{3}$'
    or p_paid_at is null or p_paid_at > now() or p_request_key is null or p_confirmed_by is null
  then raise exception 'payout_invalid'; end if;
  perform 1 from public.growth_partners where id = p_partner_id for update;
  if not found then raise exception 'partner_unavailable'; end if;
  select * into payout from public.growth_partner_payouts where request_key = p_request_key;
  if found then
    if payout.partner_id <> p_partner_id or payout.amount_minor <> p_amount_minor
      or payout.currency <> p_currency or payout.paid_at <> p_paid_at
    then raise exception 'payout_request_conflict'; end if;
    return payout.id;
  end if;
  select coalesce(sum(amount_minor), 0) into earned from public.growth_partner_commissions
    where partner_id = p_partner_id and currency = p_currency;
  select coalesce(sum(amount_minor), 0) into paid from public.growth_partner_payouts
    where partner_id = p_partner_id and currency = p_currency;
  if p_amount_minor > earned - paid then raise exception 'insufficient_partner_balance'; end if;
  insert into public.growth_partner_payouts(partner_id, request_key, amount_minor, currency, paid_at, confirmed_by)
    values (p_partner_id, p_request_key, p_amount_minor, p_currency, p_paid_at, p_confirmed_by)
    returning id into result_id;
  return result_id;
end;
$$;

revoke all on function public.check_growth_operator_request() from public, anon, authenticated;
revoke all on function public.accept_growth_operator_request(uuid, uuid) from public, anon, authenticated;
revoke all on function public.confirm_growth_operator_arrival(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.record_growth_operator_check(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.bind_growth_referral(uuid, text, text) from public, anon, authenticated;
revoke all on function public.confirm_growth_subscription_payment(uuid, uuid, bigint, text, timestamptz, uuid, uuid) from public, anon, authenticated;
revoke all on function public.confirm_growth_partner_payout(uuid, bigint, text, timestamptz, uuid, uuid) from public, anon, authenticated;

grant execute on function public.accept_growth_operator_request(uuid, uuid) to service_role;
grant execute on function public.confirm_growth_operator_arrival(uuid, uuid, uuid) to service_role;
grant execute on function public.record_growth_operator_check(uuid, uuid, text) to service_role;
grant execute on function public.bind_growth_referral(uuid, text, text) to service_role;
grant execute on function public.confirm_growth_subscription_payment(uuid, uuid, bigint, text, timestamptz, uuid, uuid) to service_role;
grant execute on function public.confirm_growth_partner_payout(uuid, bigint, text, timestamptz, uuid, uuid) to service_role;

comment on table public.growth_operator_arrivals is 'Clinic-confirmed arrivals and supplemental operator calls. Not payment receipts.';
comment on table public.platform_subscription_payments is 'Confirmed subscription payments only; no ad spend, patient sales or operator fees.';
comment on table public.growth_partner_commissions is 'Immutable commission rate and amount snapshot per confirmed subscription payment.';
comment on table public.growth_partner_payouts is 'Manual confirmation of a completed external transfer; does not transfer money.';

commit;
notify pgrst, 'reload schema';
