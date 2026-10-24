-- Local candidate: manual administrative operations, never bank/payment proof.
begin;

do $$ begin
  if to_regprocedure('public.replace_platform_subscription(uuid,text,bigint,text,text,text)') is null then
    raise exception 'platform_subscription_operations_dependencies_missing';
  end if;
end; $$;

create table if not exists public.platform_subscription_operations (
  actor_auth_user_id uuid not null,
  request_id uuid not null,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  kind text,
  payload jsonb,
  state text not null,
  result jsonb,
  created_at timestamptz not null default clock_timestamp(),
  primary key(actor_auth_user_id,request_id),
  check (((state='abandoned' and kind is null and payload is null and result is null)
    or (state in ('pending','committed') and kind in ('replace','status') and jsonb_typeof(payload)='object'
      and ((state='pending' and result is null) or (state='committed' and jsonb_typeof(result)='object')))) is true)
);
alter table public.platform_subscription_operations enable row level security;
revoke all on public.platform_subscription_operations from public,anon,authenticated,service_role;

create or replace function public.platform_subscription_operation_receipt(
  p_operation public.platform_subscription_operations,p_replayed boolean
) returns jsonb language sql immutable set search_path='' as $$
  select jsonb_build_object('requestKey',p_operation.request_id,'workspaceId',p_operation.workspace_id,
    'actorId',p_operation.actor_auth_user_id,'kind',p_operation.kind,'state',p_operation.state,
    'replayed',p_replayed,'item',p_operation.result);
$$;
revoke all on function public.platform_subscription_operation_receipt(public.platform_subscription_operations,boolean)
  from public,anon,authenticated,service_role;

create or replace function public.apply_platform_subscription_operation(
  p_actor_auth_user_id uuid,p_request_id uuid,p_workspace_id uuid,p_kind text,p_payload jsonb
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_operation public.platform_subscription_operations%rowtype;
  v_item public.platform_subscriptions%rowtype;
  v_active uuid; v_expected uuid; v_target uuid; v_version timestamptz;
  v_price bigint; v_now timestamptz; v_result jsonb;
begin
  if p_actor_auth_user_id is null or p_request_id is null or p_workspace_id is null
    or p_kind is null or p_kind not in ('replace','status') or jsonb_typeof(p_payload) is distinct from 'object' then
    raise exception using errcode='P8403',message='subscription_operation_invalid';
  end if;
  if p_kind='replace' then
    if not (p_payload ? 'expectedActiveId') or jsonb_typeof(p_payload->'expectedActiveId') not in ('string','null')
      or p_payload->>'plan' is null or p_payload->>'plan' not in ('basic','standard','pro')
      or jsonb_typeof(p_payload->'priceMinor') is distinct from 'number'
      or p_payload->>'priceMinor' !~ '^[0-9]+$'
      or p_payload->>'currency' is null or p_payload->>'currency' !~ '^[A-Z]{3}$'
      or p_payload->>'billingPeriod' is null or p_payload->>'billingPeriod' not in ('monthly','yearly')
      or (p_payload ? 'note' and jsonb_typeof(p_payload->'note') not in ('string','null'))
      or char_length(coalesce(p_payload->>'note',''))>2000
      or p_payload-array['expectedActiveId','plan','priceMinor','currency','billingPeriod','note']<>'{}'::jsonb then
      raise exception using errcode='P8403',message='subscription_operation_invalid';
    end if;
    begin
      v_expected:=(p_payload->>'expectedActiveId')::uuid;
      v_price:=(p_payload->>'priceMinor')::bigint;
    exception when invalid_text_representation or numeric_value_out_of_range then
      raise exception using errcode='P8403',message='subscription_operation_invalid';
    end;
    if v_price>9007199254740991 then raise exception using errcode='P8403',message='subscription_operation_invalid'; end if;
  else
    if jsonb_typeof(p_payload->'subscriptionId') is distinct from 'string'
      or jsonb_typeof(p_payload->'expectedUpdatedAt') is distinct from 'string'
      or p_payload->>'expectedUpdatedAt' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$'
      or p_payload->>'expectedStatus' is null or p_payload->>'expectedStatus' not in ('active','paused','cancelled')
      or p_payload->>'status' is null or p_payload->>'status' not in ('active','paused','cancelled')
      or p_payload-array['subscriptionId','expectedUpdatedAt','expectedStatus','status']<>'{}'::jsonb then
      raise exception using errcode='P8403',message='subscription_operation_invalid';
    end if;
    begin
      v_target:=(p_payload->>'subscriptionId')::uuid;
      v_version:=(p_payload->>'expectedUpdatedAt')::timestamptz;
    exception when invalid_text_representation or datetime_field_overflow or invalid_datetime_format then
      raise exception using errcode='P8403',message='subscription_operation_invalid';
    end;
  end if;

  -- Shares 067's workspace lock. No mutation or receipt may cross clinics.
  perform 1 from public.workspaces where id=p_workspace_id for update;
  if not found then raise exception using errcode='P8402',message='workspace_not_found'; end if;
  insert into public.platform_subscription_operations(actor_auth_user_id,request_id,workspace_id,kind,payload,state)
    values(p_actor_auth_user_id,p_request_id,p_workspace_id,p_kind,p_payload,'pending')
    on conflict(actor_auth_user_id,request_id) do nothing returning * into v_operation;
  if not found then
    select * into v_operation from public.platform_subscription_operations
      where actor_auth_user_id=p_actor_auth_user_id and request_id=p_request_id for update;
    if v_operation.workspace_id is distinct from p_workspace_id then
      raise exception using errcode='P8407',message='subscription_request_conflict'; end if;
    if v_operation.state='abandoned' then raise exception using errcode='P8409',message='subscription_request_abandoned'; end if;
    if v_operation.kind is distinct from p_kind or v_operation.payload is distinct from p_payload then
      raise exception using errcode='P8407',message='subscription_request_conflict'; end if;
    if v_operation.state<>'committed' then raise exception using errcode='P8408',message='subscription_operation_unavailable'; end if;
    return public.platform_subscription_operation_receipt(v_operation,true);
  end if;

  select id into v_active from public.platform_subscriptions where workspace_id=p_workspace_id and status='active';
  if p_kind='replace' then
    if v_active is distinct from v_expected then raise exception using errcode='P8404',message='subscription_conflict'; end if;
    v_result:=public.replace_platform_subscription(p_workspace_id,p_payload->>'plan',v_price,
      p_payload->>'currency',p_payload->>'billingPeriod',p_payload->>'note');
  else
    select * into v_item from public.platform_subscriptions where workspace_id=p_workspace_id and id=v_target for update;
    if not found or v_item.updated_at is distinct from v_version or v_item.status is distinct from p_payload->>'expectedStatus'
      or (v_item.status='cancelled' and p_payload->>'status'<>'cancelled')
      or (p_payload->>'status'='active' and v_active is not null and v_active<>v_target) then
      raise exception using errcode='P8404',message='subscription_conflict';
    end if;
    if v_item.price_minor>9007199254740991 or v_item.currency !~ '^[A-Z]{3}$' then
      raise exception using errcode='P8403',message='subscription_operation_invalid'; end if;
    if v_item.status<>p_payload->>'status' then
      v_now:=greatest(clock_timestamp(),v_item.updated_at+interval '1 microsecond',v_item.started_at);
      update public.platform_subscriptions set status=p_payload->>'status',
        ended_at=case when p_payload->>'status'='cancelled' then v_now else null end,updated_at=v_now
        where id=v_target and workspace_id=p_workspace_id returning * into v_item;
    end if;
    v_result:=to_jsonb(v_item);
  end if;
  update public.platform_subscription_operations set state='committed',result=v_result
    where actor_auth_user_id=p_actor_auth_user_id and request_id=p_request_id returning * into v_operation;
  return public.platform_subscription_operation_receipt(v_operation,false);
end; $$;

create or replace function public.read_platform_subscription_operation(
  p_actor_auth_user_id uuid,p_request_id uuid,p_workspace_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_operation public.platform_subscription_operations%rowtype;
begin
  if p_actor_auth_user_id is null or p_request_id is null or p_workspace_id is null then
    raise exception using errcode='P8403',message='subscription_operation_invalid'; end if;
  select * into v_operation from public.platform_subscription_operations
    where actor_auth_user_id=p_actor_auth_user_id and request_id=p_request_id and workspace_id=p_workspace_id;
  -- Absence is not proof of non-execution: a first request may still arrive later.
  if not found then return null; end if;
  if v_operation.state='pending' then raise exception using errcode='P8408',message='subscription_operation_unavailable'; end if;
  return public.platform_subscription_operation_receipt(v_operation,true);
end; $$;

create or replace function public.abandon_platform_subscription_operation(
  p_actor_auth_user_id uuid,p_request_id uuid,p_workspace_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_operation public.platform_subscription_operations%rowtype; v_new boolean;
begin
  if p_actor_auth_user_id is null or p_request_id is null or p_workspace_id is null then
    raise exception using errcode='P8403',message='subscription_operation_invalid'; end if;
  perform 1 from public.workspaces where id=p_workspace_id for update;
  if not found then raise exception using errcode='P8402',message='workspace_not_found'; end if;
  insert into public.platform_subscription_operations(actor_auth_user_id,request_id,workspace_id,state)
    values(p_actor_auth_user_id,p_request_id,p_workspace_id,'abandoned')
    on conflict(actor_auth_user_id,request_id) do nothing returning * into v_operation;
  v_new:=found;
  if not v_new then
    select * into v_operation from public.platform_subscription_operations
      where actor_auth_user_id=p_actor_auth_user_id and request_id=p_request_id for update;
    if v_operation.workspace_id is distinct from p_workspace_id then
      raise exception using errcode='P8407',message='subscription_request_conflict'; end if;
    if v_operation.state='pending' then raise exception using errcode='P8408',message='subscription_operation_unavailable'; end if;
  end if;
  -- If apply won the lock, report its committed result instead of pretending
  -- to undo it. If abandon won, late apply can never execute this request key.
  return public.platform_subscription_operation_receipt(v_operation,not v_new);
end; $$;

revoke all on function public.apply_platform_subscription_operation(uuid,uuid,uuid,text,jsonb),
  public.read_platform_subscription_operation(uuid,uuid,uuid),public.abandon_platform_subscription_operation(uuid,uuid,uuid)
  from public,anon,authenticated;
grant execute on function public.apply_platform_subscription_operation(uuid,uuid,uuid,text,jsonb),
  public.read_platform_subscription_operation(uuid,uuid,uuid),public.abandon_platform_subscription_operation(uuid,uuid,uuid)
  to service_role;
notify pgrst,'reload schema';
commit;
