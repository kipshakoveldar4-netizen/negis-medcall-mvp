-- Qualify the ledger columns that overlap RETURNS TABLE output variables.
-- Existing receipts, limits, locking and completion rules remain unchanged.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

do $dependency$
begin
  if to_regclass('public.content_generation_usage') is null
    or to_regprocedure('public.reserve_content_generation_usage(uuid,uuid,uuid,text,text,integer,integer,text,text)') is null then
    raise exception using errcode='P8101', message='content_usage_reservation_requires_051';
  end if;
end
$dependency$;

create or replace function public.reserve_content_generation_usage(
  p_workspace_id uuid,
  p_staff_user_id uuid,
  p_request_key uuid,
  p_operation text,
  p_kind text,
  p_units integer,
  p_limit_units integer,
  p_provider text default null,
  p_model text default null
)
returns table (
  allowed boolean,
  duplicate boolean,
  usage_id uuid,
  used_units bigint,
  limit_units integer,
  remaining_units bigint,
  period_start date
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_period_start date := date_trunc('month', now() at time zone 'UTC')::date;
  v_used bigint := 0;
  v_existing public.content_generation_usage%rowtype;
  v_usage_id uuid;
begin
  if p_operation not in (
    'content_package', 'ad_text_improvement', 'video_script',
    'avatar_prompt', 'tapnow_prompt', 'generated_image', 'generated_video'
  ) then
    raise exception 'invalid generation operation';
  end if;
  if p_kind not in ('text_request', 'image', 'video_seconds') then
    raise exception 'invalid generation kind';
  end if;
  if p_units is null or p_units <= 0 or p_units > 3600 then
    raise exception 'invalid generation units';
  end if;
  if p_limit_units is not null and p_limit_units < 0 then
    raise exception 'invalid generation limit';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(p_workspace_id::text || ':' || p_kind || ':' || v_period_start::text, 0)
  );

  select receipt.* into v_existing
  from public.content_generation_usage receipt
  where receipt.workspace_id = p_workspace_id and receipt.request_key = p_request_key;

  select coalesce(sum(receipt.units), 0)::bigint into v_used
  from public.content_generation_usage receipt
  where receipt.workspace_id = p_workspace_id
    and receipt.period_start = v_period_start
    and receipt.kind = p_kind
    and receipt.status in ('reserved', 'succeeded', 'unknown');

  if v_existing.id is not null then
    return query select
      false, true, v_existing.id, v_used, p_limit_units,
      case when p_limit_units is null then null else greatest(p_limit_units::bigint - v_used, 0) end,
      v_period_start;
    return;
  end if;

  if p_limit_units is not null and v_used + p_units > p_limit_units then
    return query select
      false, false, null::uuid, v_used, p_limit_units,
      greatest(p_limit_units::bigint - v_used, 0), v_period_start;
    return;
  end if;

  insert into public.content_generation_usage (
    workspace_id, staff_user_id, request_key, operation, kind, units,
    status, provider, model, period_start
  ) values (
    p_workspace_id, p_staff_user_id, p_request_key, p_operation, p_kind, p_units,
    'reserved',
    nullif(left(trim(coalesce(p_provider, '')), 40), ''),
    nullif(left(trim(coalesce(p_model, '')), 120), ''),
    v_period_start
  ) returning id into v_usage_id;

  v_used := v_used + p_units;
  return query select
    true, false, v_usage_id, v_used, p_limit_units,
    case when p_limit_units is null then null else greatest(p_limit_units::bigint - v_used, 0) end,
    v_period_start;
end;
$$;

revoke all on function public.reserve_content_generation_usage(uuid,uuid,uuid,text,text,integer,integer,text,text)
  from public, anon, authenticated;
grant execute on function public.reserve_content_generation_usage(uuid,uuid,uuid,text,text,integer,integer,text,text)
  to service_role;

commit;
notify pgrst, 'reload schema';
