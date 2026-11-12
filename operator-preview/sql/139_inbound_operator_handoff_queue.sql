-- Candidate 139: durable, server-only handoff queue for inbound conversations.
-- Apply after 054. This migration is intentionally not connected to any webhook.
begin;

create table if not exists public.inbound_conversation_handoffs (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('wazzup', 'whatsapp_cloud')),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  lead_id uuid not null,
  channel_key text not null check (char_length(btrim(channel_key)) between 1 and 200),
  conversation_key text not null check (conversation_key ~ '^[0-9a-f]{64}$'),
  latest_message_id text not null check (char_length(btrim(latest_message_id)) between 1 and 200),
  state text not null default 'needs_operator'
    check (state in ('needs_operator', 'claimed', 'resolved')),
  last_outcome text not null check (last_outcome in ('created', 'repeat')),
  operator_request_id uuid,
  claimed_by_operator_user_id uuid,
  claimed_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, workspace_id, conversation_key),
  foreign key (lead_id, workspace_id)
    references public.leads(id, workspace_id) on delete cascade,
  check ((state = 'needs_operator') = (claimed_at is null and resolved_at is null)),
  check ((state = 'claimed') = (claimed_at is not null and resolved_at is null)),
  check ((state = 'resolved') = (resolved_at is not null and claimed_at is not null))
);

create index if not exists inbound_conversation_handoffs_queue_idx
  on public.inbound_conversation_handoffs(workspace_id, state, updated_at desc, id);

alter table public.inbound_conversation_handoffs enable row level security;
revoke all on table public.inbound_conversation_handoffs from public, anon, authenticated, service_role;

create or replace function public.enqueue_inbound_operator_handoff(
  p_provider text,
  p_workspace_id uuid,
  p_lead_id uuid,
  p_channel_key text,
  p_conversation_key text,
  p_message_id text,
  p_outcome text
)
returns table(handoff_id uuid, state text, created boolean)
language plpgsql security definer set search_path = '' as $$
declare existing public.inbound_conversation_handoffs%rowtype;
begin
  if p_provider not in ('wazzup', 'whatsapp_cloud')
    or p_workspace_id is null or p_lead_id is null
    or p_channel_key is null or char_length(btrim(p_channel_key)) not between 1 and 200
    or p_conversation_key is null or p_conversation_key !~ '^[0-9a-f]{64}$'
    or p_message_id is null or char_length(btrim(p_message_id)) not between 1 and 200
    or p_outcome not in ('created', 'repeat') then
    raise exception using errcode = 'P7201', message = 'inbound_handoff_invalid';
  end if;

  perform 1 from public.leads l
    where l.id = p_lead_id and l.workspace_id = p_workspace_id for share;
  if not found then raise exception 'inbound_handoff_lead_unavailable'; end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'inbound-handoff:' || p_provider || ':' || p_workspace_id::text || ':' || p_conversation_key, 0));

  select * into existing from public.inbound_conversation_handoffs h
    where h.provider = p_provider and h.workspace_id = p_workspace_id
      and h.conversation_key = p_conversation_key for update;
  if found then
    if existing.lead_id <> p_lead_id then
      raise exception 'inbound_handoff_identity_conflict';
    end if;
    update public.inbound_conversation_handoffs
      set latest_message_id = p_message_id, last_outcome = p_outcome, updated_at = now()
      where id = existing.id;
    return query select existing.id, existing.state, false;
    return;
  end if;

  return query
    insert into public.inbound_conversation_handoffs as inserted
      (provider, workspace_id, lead_id, channel_key, conversation_key,
       latest_message_id, last_outcome)
    values
      (p_provider, p_workspace_id, p_lead_id, btrim(p_channel_key),
       p_conversation_key, btrim(p_message_id), p_outcome)
    returning inserted.id, inserted.state, true;
end;
$$;

create or replace function public.claim_inbound_operator_handoff(
  p_handoff_id uuid,
  p_request_id uuid,
  p_operator_user_id uuid
)
returns table(handoff_id uuid, state text, claimed boolean)
language plpgsql security definer set search_path = '' as $$
declare h public.inbound_conversation_handoffs%rowtype;
  r public.growth_operator_requests%rowtype;
begin
  select * into h from public.inbound_conversation_handoffs
    where id = p_handoff_id for update;
  if not found then raise exception 'inbound_handoff_unavailable'; end if;

  select * into r from public.growth_operator_requests
    where id = p_request_id and workspace_id = h.workspace_id
      and status = 'accepted' for share;
  if not found then raise exception 'operator_access_denied'; end if;

  perform 1 from public.growth_operator_profiles p
    where p.id = r.operator_id and p.auth_user_id = p_operator_user_id
      and p.status = 'approved' for share;
  if not found then raise exception 'operator_access_denied'; end if;

  if r.lead_scope = 'assigned' and not exists (
    select 1 from public.growth_operator_lead_assignments a
      where a.operator_request_id = r.id and a.workspace_id = h.workspace_id
        and a.lead_id = h.lead_id and a.assigned
  ) then
    raise exception 'operator_access_denied';
  end if;

  if h.state <> 'needs_operator' then
    return query select h.id, h.state, false;
    return;
  end if;

  update public.inbound_conversation_handoffs
    set state = 'claimed', operator_request_id = r.id,
        claimed_by_operator_user_id = p_operator_user_id,
        claimed_at = now(), updated_at = now()
    where id = h.id;
  return query select h.id, 'claimed'::text, true;
end;
$$;

create or replace function public.read_inbound_operator_handoffs(
  p_request_id uuid,
  p_operator_user_id uuid,
  p_state text default null,
  p_offset integer default 0
)
returns table(
  handoff_id uuid,
  workspace_id uuid,
  lead_id uuid,
  provider text,
  state text,
  last_outcome text,
  operator_request_id uuid,
  claimed_by_operator_user_id uuid,
  claimed_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql security definer set search_path = '' as $$
declare r public.growth_operator_requests%rowtype;
begin
  if p_request_id is null or p_operator_user_id is null
    or (p_state is not null and p_state not in ('needs_operator', 'claimed', 'resolved'))
    or p_offset is null or p_offset < 0 or p_offset > 1000000 then
    raise exception using errcode = 'P7201', message = 'inbound_handoff_invalid';
  end if;

  select q.* into r from public.growth_operator_requests q
    join public.growth_operator_profiles p on p.id = q.operator_id
    where q.id = p_request_id and q.status = 'accepted'
      and p.auth_user_id = p_operator_user_id and p.status = 'approved'
    for share;
  if not found then raise exception 'operator_access_denied'; end if;

  return query
    select h.id, h.workspace_id, h.lead_id, h.provider, h.state,
      h.last_outcome, h.operator_request_id, h.claimed_by_operator_user_id,
      h.claimed_at, h.created_at, h.updated_at
    from public.inbound_conversation_handoffs h
    where h.workspace_id = r.workspace_id
      and (p_state is null or h.state = p_state)
      and (
        (h.state = 'needs_operator' and (
          r.lead_scope = 'clinic'
          or exists (
            select 1 from public.growth_operator_lead_assignments a
              where a.operator_request_id = r.id and a.workspace_id = h.workspace_id
                and a.lead_id = h.lead_id and a.assigned
          )
        ))
        or h.operator_request_id = r.id
      )
    order by h.updated_at desc, h.id
    limit 50 offset p_offset;
end;
$$;

create or replace function public.resolve_inbound_operator_handoff(
  p_handoff_id uuid,
  p_request_id uuid,
  p_operator_user_id uuid
)
returns table(handoff_id uuid, state text, resolved boolean)
language plpgsql security definer set search_path = '' as $$
declare h public.inbound_conversation_handoffs%rowtype;
  r public.growth_operator_requests%rowtype;
begin
  if p_handoff_id is null or p_request_id is null or p_operator_user_id is null then
    raise exception using errcode = 'P7201', message = 'inbound_handoff_invalid';
  end if;

  select * into h from public.inbound_conversation_handoffs
    where id = p_handoff_id for update;
  if not found then raise exception 'inbound_handoff_unavailable'; end if;

  select * into r from public.growth_operator_requests
    where id = p_request_id and workspace_id = h.workspace_id
      and status = 'accepted' for share;
  if not found then raise exception 'operator_access_denied'; end if;

  perform 1 from public.growth_operator_profiles p
    where p.id = r.operator_id and p.auth_user_id = p_operator_user_id
      and p.status = 'approved' for share;
  if not found then raise exception 'operator_access_denied'; end if;

  if h.state = 'resolved' then
    return query select h.id, h.state, false;
    return;
  end if;
  if h.state <> 'claimed' or h.operator_request_id <> r.id
    or h.claimed_by_operator_user_id <> p_operator_user_id then
    raise exception 'operator_access_denied';
  end if;

  update public.inbound_conversation_handoffs
    set state = 'resolved', resolved_at = now(), updated_at = now()
    where id = h.id;
  return query select h.id, 'resolved'::text, true;
end;
$$;

revoke all on function public.enqueue_inbound_operator_handoff(text, uuid, uuid, text, text, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.claim_inbound_operator_handoff(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.read_inbound_operator_handoffs(uuid, uuid, text, integer)
  from public, anon, authenticated, service_role;
revoke all on function public.resolve_inbound_operator_handoff(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.enqueue_inbound_operator_handoff(text, uuid, uuid, text, text, text, text)
  to service_role;
grant execute on function public.claim_inbound_operator_handoff(uuid, uuid, uuid)
  to service_role;
grant execute on function public.read_inbound_operator_handoffs(uuid, uuid, text, integer)
  to service_role;
grant execute on function public.resolve_inbound_operator_handoff(uuid, uuid, uuid)
  to service_role;

comment on table public.inbound_conversation_handoffs is
  'Server-only durable handoff queue. Conversation keys are hashes; no phone, name or message text is stored.';
comment on function public.enqueue_inbound_operator_handoff(text, uuid, uuid, text, text, text, text) is
  'Idempotently stores a scoped inbound conversation handoff. Webhooks must opt in explicitly.';
comment on function public.claim_inbound_operator_handoff(uuid, uuid, uuid) is
  'Atomically claims one handoff after rechecking active operator agreement and lead scope.';
comment on function public.read_inbound_operator_handoffs(uuid, uuid, text, integer) is
  'Reads only handoffs visible to an active operator agreement; returns no phone, name or message text.';
comment on function public.resolve_inbound_operator_handoff(uuid, uuid, uuid) is
  'Atomically resolves only a handoff claimed by the current approved operator agreement.';

commit;
notify pgrst, 'reload schema';
