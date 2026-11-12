-- Replace a manually assigned platform subscription in one database transaction.
-- This function does not confirm bank payments or activate paid access from a
-- provider callback. It only prevents the platform owner UI from cancelling the
-- current row when creation of its replacement fails.

begin;

create or replace function public.replace_platform_subscription(
  p_workspace_id uuid,
  p_plan text,
  p_price_minor bigint,
  p_currency text,
  p_billing_period text,
  p_note text default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := statement_timestamp();
  v_item public.platform_subscriptions%rowtype;
begin
  if p_workspace_id is null
    or p_plan is null
    or p_plan not in ('basic', 'standard', 'pro')
    or p_price_minor is null
    or p_price_minor < 0
    or p_currency is null
    or p_currency !~ '^[A-Z]{3}$'
    or p_billing_period is null
    or p_billing_period not in ('monthly', 'yearly')
    or char_length(coalesce(p_note, '')) > 2000 then
    raise exception 'platform_subscription_invalid';
  end if;

  -- One lock per clinic serializes simultaneous replacements before the partial
  -- unique index is reached. A different clinic remains independent.
  perform 1
  from public.workspaces
  where id = p_workspace_id
  for update;
  if not found then
    raise exception 'platform_workspace_unavailable';
  end if;

  update public.platform_subscriptions
  set status = 'cancelled', ended_at = v_now, updated_at = v_now
  where workspace_id = p_workspace_id and status = 'active';

  insert into public.platform_subscriptions (
    workspace_id,
    plan,
    status,
    price_minor,
    currency,
    billing_period,
    started_at,
    note,
    updated_at
  ) values (
    p_workspace_id,
    p_plan,
    'active',
    p_price_minor,
    p_currency,
    p_billing_period,
    v_now,
    nullif(btrim(p_note), ''),
    v_now
  )
  returning * into v_item;

  return to_jsonb(v_item);
end;
$$;

revoke all on function public.replace_platform_subscription(uuid, text, bigint, text, text, text)
  from public, anon, authenticated;
grant execute on function public.replace_platform_subscription(uuid, text, bigint, text, text, text)
  to service_role;

commit;
