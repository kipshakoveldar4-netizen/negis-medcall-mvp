-- Durable, workspace-scoped accounting for paid Content Studio generation.
-- Prompts, generated content, provider responses and credentials are never
-- stored here. One row is only a receipt for a reserved billable unit.
begin;

create table if not exists public.content_generation_usage (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  staff_user_id uuid references public.staff_users(id) on delete set null,
  request_key uuid not null,
  operation text not null check (
    operation in (
      'content_package',
      'ad_text_improvement',
      'video_script',
      'avatar_prompt',
      'tapnow_prompt',
      'generated_image',
      'generated_video'
    )
  ),
  kind text not null check (kind in ('text_request', 'image', 'video_seconds')),
  units integer not null check (units > 0 and units <= 3600),
  status text not null default 'reserved' check (status in ('reserved', 'succeeded', 'failed', 'unknown')),
  provider text check (provider is null or char_length(provider) between 1 and 40),
  model text check (model is null or char_length(model) between 1 and 120),
  error_code text check (
    error_code is null or error_code in (
      'provider_rejected',
      'provider_unavailable',
      'storage_failed',
      'request_unknown'
    )
  ),
  period_start date not null,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, request_key),
  check ((status = 'reserved') = (completed_at is null)),
  check ((status in ('failed', 'unknown')) = (error_code is not null))
);

create index if not exists content_generation_usage_workspace_period_idx
  on public.content_generation_usage (workspace_id, period_start, kind, status);
create index if not exists content_generation_usage_workspace_created_idx
  on public.content_generation_usage (workspace_id, created_at desc);

alter table public.content_generation_usage enable row level security;
revoke all on table public.content_generation_usage from public, anon, authenticated;
grant select, insert, update on table public.content_generation_usage to service_role;

-- A transaction-scoped advisory lock serializes reservations for one
-- workspace/kind/month. Parallel clicks therefore see each other's reserved
-- units before either request reaches the paid provider.
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

  select * into v_existing
  from public.content_generation_usage
  where workspace_id = p_workspace_id and request_key = p_request_key;

  select coalesce(sum(units), 0)::bigint into v_used
  from public.content_generation_usage
  where workspace_id = p_workspace_id
    and period_start = v_period_start
    and kind = p_kind
    and status in ('reserved', 'succeeded', 'unknown');

  if found and v_existing.id is not null then
    return query select
      false,
      true,
      v_existing.id,
      v_used,
      p_limit_units,
      case when p_limit_units is null then null else greatest(p_limit_units::bigint - v_used, 0) end,
      v_period_start;
    return;
  end if;

  if p_limit_units is not null and v_used + p_units > p_limit_units then
    return query select
      false,
      false,
      null::uuid,
      v_used,
      p_limit_units,
      greatest(p_limit_units::bigint - v_used, 0),
      v_period_start;
    return;
  end if;

  insert into public.content_generation_usage (
    workspace_id,
    staff_user_id,
    request_key,
    operation,
    kind,
    units,
    status,
    provider,
    model,
    period_start
  ) values (
    p_workspace_id,
    p_staff_user_id,
    p_request_key,
    p_operation,
    p_kind,
    p_units,
    'reserved',
    nullif(left(trim(coalesce(p_provider, '')), 40), ''),
    nullif(left(trim(coalesce(p_model, '')), 120), ''),
    v_period_start
  ) returning id into v_usage_id;

  v_used := v_used + p_units;
  return query select
    true,
    false,
    v_usage_id,
    v_used,
    p_limit_units,
    case when p_limit_units is null then null else greatest(p_limit_units::bigint - v_used, 0) end,
    v_period_start;
end;
$$;

create or replace function public.complete_content_generation_usage(
  p_workspace_id uuid,
  p_usage_id uuid,
  p_status text,
  p_error_code text default null,
  p_provider text default null,
  p_model text default null
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_updated integer := 0;
begin
  if p_status not in ('succeeded', 'failed', 'unknown') then
    raise exception 'invalid generation completion status';
  end if;
  if (p_status in ('failed', 'unknown')) <> (p_error_code is not null) then
    raise exception 'generation error code does not match status';
  end if;
  if p_error_code is not null and p_error_code not in (
    'provider_rejected', 'provider_unavailable', 'storage_failed', 'request_unknown'
  ) then
    raise exception 'invalid generation error code';
  end if;

  update public.content_generation_usage
  set status = p_status,
      error_code = p_error_code,
      provider = coalesce(nullif(left(trim(coalesce(p_provider, '')), 40), ''), provider),
      model = coalesce(nullif(left(trim(coalesce(p_model, '')), 120), ''), model),
      completed_at = now(),
      updated_at = now()
  where id = p_usage_id
    and workspace_id = p_workspace_id
    and status = 'reserved';

  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$$;

revoke all on function public.reserve_content_generation_usage(uuid, uuid, uuid, text, text, integer, integer, text, text)
  from public, anon, authenticated;
revoke all on function public.complete_content_generation_usage(uuid, uuid, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.reserve_content_generation_usage(uuid, uuid, uuid, text, text, integer, integer, text, text)
  to service_role;
grant execute on function public.complete_content_generation_usage(uuid, uuid, text, text, text, text)
  to service_role;

comment on table public.content_generation_usage is
  'Server-only billable-unit receipts for Content Studio. No prompts, content, URLs, provider responses or credentials.';

commit;
notify pgrst, 'reload schema';
