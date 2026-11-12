-- Negis CRM11e.1: Meta Insights scheduler state and completeness foundation.
-- This migration does not schedule work or call Meta. It adds only server-side
-- state, safe orchestration metadata, and an atomic claim primitive.

create table if not exists public.meta_insights_sync_state (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  meta_campaign_launch_id uuid not null references public.meta_campaign_launches(id) on delete cascade,
  next_sync_at timestamptz,
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  last_complete_date date,
  completeness_status text not null default 'never_synced'
    check (completeness_status in (
      'never_synced',
      'syncing',
      'zero_delivery',
      'partial',
      'current',
      'stale',
      'failed',
      'unavailable'
    )),
  consecutive_failure_count integer not null default 0
    check (consecutive_failure_count >= 0),
  lease_owner text,
  lease_expires_at timestamptz,
  last_error_code text,
  paused_until timestamptz,
  pause_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint meta_insights_sync_state_workspace_launch_key
    unique (workspace_id, meta_campaign_launch_id),
  constraint meta_insights_sync_state_lease_pair_check
    check (
      (lease_owner is null and lease_expires_at is null)
      or (lease_owner is not null and lease_expires_at is not null)
    ),
  constraint meta_insights_sync_state_lease_owner_length_check
    check (lease_owner is null or char_length(lease_owner) <= 200),
  constraint meta_insights_sync_state_error_code_length_check
    check (last_error_code is null or char_length(last_error_code) <= 100),
  constraint meta_insights_sync_state_pause_reason_length_check
    check (pause_reason is null or char_length(pause_reason) <= 500)
);

-- Scheduler state is server-owned. There are intentionally no client RLS
-- policies; service-role code is the only planned reader/writer.
alter table public.meta_insights_sync_state enable row level security;
revoke all on table public.meta_insights_sync_state from public;
revoke all on table public.meta_insights_sync_state from anon;
revoke all on table public.meta_insights_sync_state from authenticated;
grant all on table public.meta_insights_sync_state to service_role;

create index if not exists meta_insights_sync_state_workspace_next_sync_idx
  on public.meta_insights_sync_state(workspace_id, next_sync_at)
  where next_sync_at is not null;
create index if not exists meta_insights_sync_state_workspace_status_next_sync_idx
  on public.meta_insights_sync_state(workspace_id, completeness_status, next_sync_at);
create index if not exists meta_insights_sync_state_workspace_lease_expires_idx
  on public.meta_insights_sync_state(workspace_id, lease_expires_at)
  where lease_expires_at is not null;
-- The named unique constraint above is also the required
-- (workspace_id, meta_campaign_launch_id) index.
create index if not exists meta_insights_sync_state_workspace_paused_until_idx
  on public.meta_insights_sync_state(workspace_id, paused_until)
  where paused_until is not null;

alter table public.meta_insights_sync_runs
  add column if not exists "trigger" text not null default 'manual',
  add column if not exists request_key text,
  add column if not exists attempt integer not null default 1,
  add column if not exists pages_fetched integer not null default 0,
  add column if not exists coverage_complete boolean not null default false,
  add column if not exists heartbeat_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.meta_insights_sync_runs'::regclass
      and conname = 'meta_insights_sync_runs_trigger_check'
  ) then
    alter table public.meta_insights_sync_runs
      add constraint meta_insights_sync_runs_trigger_check
      check ("trigger" in ('manual', 'background', 'operator'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.meta_insights_sync_runs'::regclass
      and conname = 'meta_insights_sync_runs_attempt_check'
  ) then
    alter table public.meta_insights_sync_runs
      add constraint meta_insights_sync_runs_attempt_check check (attempt >= 1);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.meta_insights_sync_runs'::regclass
      and conname = 'meta_insights_sync_runs_pages_fetched_check'
  ) then
    alter table public.meta_insights_sync_runs
      add constraint meta_insights_sync_runs_pages_fetched_check check (pages_fetched >= 0);
  end if;
end;
$$;

-- Existing CRM11b manual runs reached succeeded only after pagination and the
-- daily-row upsert completed. Their requested ranges are therefore complete,
-- including successful zero-row ranges.
update public.meta_insights_sync_runs
set coverage_complete = true
where "trigger" = 'manual'
  and status = 'succeeded'
  and coverage_complete = false;

-- Keep future manual syncs backward-compatible without requiring the current
-- API handler to depend on migration-022 columns during deployment ordering.
create or replace function public.mark_manual_meta_insights_coverage_complete()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new."trigger" = 'manual' and new.status = 'succeeded' then
    new.coverage_complete := true;
  end if;
  return new;
end;
$$;

drop trigger if exists mark_manual_meta_insights_coverage_complete_on_run
  on public.meta_insights_sync_runs;
create trigger mark_manual_meta_insights_coverage_complete_on_run
  before insert or update of status, "trigger", coverage_complete
  on public.meta_insights_sync_runs
  for each row
  execute function public.mark_manual_meta_insights_coverage_complete();

revoke all on function public.mark_manual_meta_insights_coverage_complete() from public;
revoke all on function public.mark_manual_meta_insights_coverage_complete() from anon;
revoke all on function public.mark_manual_meta_insights_coverage_complete() from authenticated;
grant execute on function public.mark_manual_meta_insights_coverage_complete() to service_role;

create unique index if not exists meta_insights_sync_runs_workspace_request_key_idx
  on public.meta_insights_sync_runs(workspace_id, request_key)
  where request_key is not null;
create index if not exists meta_insights_sync_runs_workspace_trigger_created_idx
  on public.meta_insights_sync_runs(workspace_id, "trigger", created_at desc);
create index if not exists meta_insights_sync_runs_workspace_coverage_finished_idx
  on public.meta_insights_sync_runs(workspace_id, coverage_complete, finished_at desc);
create index if not exists meta_insights_sync_runs_workspace_heartbeat_idx
  on public.meta_insights_sync_runs(workspace_id, heartbeat_at)
  where heartbeat_at is not null;

-- Atomically claim due rows for a future server-side worker. The worker secret
-- is never stored here; callers must already be authenticated by server code.
create or replace function public.claim_due_meta_insights_sync_states(
  p_worker_id text,
  p_limit integer,
  p_lease_seconds integer,
  p_workspace_ids uuid[] default null
)
returns table (
  id uuid,
  workspace_id uuid,
  meta_campaign_launch_id uuid,
  next_sync_at timestamptz,
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  last_complete_date date,
  completeness_status text,
  consecutive_failure_count integer,
  lease_owner text,
  lease_expires_at timestamptz,
  paused_until timestamptz,
  last_error_code text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  safe_worker_id text := left(trim(coalesce(p_worker_id, '')), 200);
  safe_limit integer := least(greatest(coalesce(p_limit, 1), 1), 50);
  safe_lease_seconds integer := least(greatest(coalesce(p_lease_seconds, 120), 30), 3600);
begin
  if safe_worker_id = '' then
    raise exception 'worker id is required' using errcode = '22023';
  end if;

  return query
  with due as (
    select state.id
    from public.meta_insights_sync_state state
    where state.next_sync_at is not null
      and state.next_sync_at <= now()
      and (state.paused_until is null or state.paused_until <= now())
      and (state.lease_expires_at is null or state.lease_expires_at <= now())
      and (p_workspace_ids is null or state.workspace_id = any(p_workspace_ids))
    order by state.next_sync_at asc, state.created_at asc, state.id asc
    for update skip locked
    limit safe_limit
  ), claimed as (
    update public.meta_insights_sync_state state
    set lease_owner = safe_worker_id,
        lease_expires_at = now() + make_interval(secs => safe_lease_seconds),
        last_attempt_at = now(),
        completeness_status = 'syncing',
        updated_at = now()
    from due
    where state.id = due.id
    returning
      state.id,
      state.workspace_id,
      state.meta_campaign_launch_id,
      state.next_sync_at,
      state.last_attempt_at,
      state.last_success_at,
      state.last_complete_date,
      state.completeness_status,
      state.consecutive_failure_count,
      state.lease_owner,
      state.lease_expires_at,
      state.paused_until,
      state.last_error_code
  )
  select
    claimed.id,
    claimed.workspace_id,
    claimed.meta_campaign_launch_id,
    claimed.next_sync_at,
    claimed.last_attempt_at,
    claimed.last_success_at,
    claimed.last_complete_date,
    claimed.completeness_status,
    claimed.consecutive_failure_count,
    claimed.lease_owner,
    claimed.lease_expires_at,
    claimed.paused_until,
    claimed.last_error_code
  from claimed;
end;
$$;

comment on function public.claim_due_meta_insights_sync_states(text, integer, integer, uuid[])
  is 'Service-role-only atomic claim for future Meta Insights workers. Returns safe scheduler fields only.';

revoke all on function public.claim_due_meta_insights_sync_states(text, integer, integer, uuid[]) from public;
revoke all on function public.claim_due_meta_insights_sync_states(text, integer, integer, uuid[]) from anon;
revoke all on function public.claim_due_meta_insights_sync_states(text, integer, integer, uuid[]) from authenticated;
grant execute on function public.claim_due_meta_insights_sync_states(text, integer, integer, uuid[]) to service_role;
