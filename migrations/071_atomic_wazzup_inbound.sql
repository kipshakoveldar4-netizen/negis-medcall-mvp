-- Apply after 019, 026 and 028. Existing channels stay on their current path.
-- This migration does not bind, enable or opt in any channel.
begin;

alter table public.wazzup_channels
  add column if not exists atomic_inbound boolean not null default false;

create or replace function public.process_wazzup_inbound_message(
  p_channel_id text, p_message_id text, p_phone text,
  p_contact_name text, p_text text
) returns text language plpgsql security definer set search_path = '' as $$
declare
  channel public.wazzup_channels%rowtype;
  lead_id uuid;
  stage_id uuid;
  source_id uuid;
  result_kind text := 'repeat';
begin
  if p_channel_id is null or char_length(p_channel_id) not between 1 and 200
    or p_message_id is null or char_length(p_message_id) not between 1 and 200
    or p_phone is null or char_length(p_phone) not between 2 and 33
    or p_phone !~ '^\+[0-9]+$' then
    raise exception using errcode = 'P7101', message = 'wazzup_inbound_invalid';
  end if;

  -- Replays and new leads commit with the same receipt. A hash collision can
  -- only add waiting; the actual keys are always checked in the tables.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'wazzup-message:' || p_message_id, 0));
  if exists (select 1 from public.wazzup_inbound_messages where message_id = p_message_id) then
    return 'ignored';
  end if;

  -- Lock the current mapping through commit, so a completed stop cannot race
  -- a stale enabled/tenant read. The caller never supplies a workspace ID.
  select * into channel from public.wazzup_channels
    where channel_id = p_channel_id for share;
  if not found or not channel.enabled or not channel.atomic_inbound then
    return 'ignored';
  end if;

  -- Different opted-in channels/messages for the same workspace and phone
  -- must not both observe an absent lead. This does not serialize manual CRM
  -- writers or the legacy/Cloud pipeline, which are outside this opt-in.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'wazzup-phone:' || channel.workspace_id::text || ':' || p_phone, 0));
  select l.id into lead_id from public.leads l
    where l.workspace_id = channel.workspace_id
      and l.phone_normalized = p_phone and l.status is distinct from 'lost'
    order by l.created_at asc nulls last, l.id
    limit 1 for share;

  if lead_id is null then
    select s.id into stage_id from public.lead_stages s
      where s.workspace_id = channel.workspace_id and s.semantic_group = 'new'
      order by s.sort_order, s.id limit 1;
    select s.id into source_id from public.lead_sources s
      where s.workspace_id = channel.workspace_id and s.source_key = 'whatsapp'
      order by s.id limit 1;

    insert into public.leads (
      workspace_id, full_name, phone, source, status, stage_id, source_id, notes
    ) values (
      channel.workspace_id, left(coalesce(nullif(btrim(p_contact_name), ''), p_phone), 200),
      p_phone, 'whatsapp', 'new', stage_id, source_id,
      case when nullif(p_text, '') is null then null else 'WhatsApp: ' || left(p_text, 1000) end
    ) returning id into lead_id;
    result_kind := 'created';
  end if;

  -- Do not suppress a unique/error here: rolling back this transaction also
  -- rolls back its new lead. A later provider retry can safely read a receipt.
  insert into public.wazzup_inbound_messages (
    message_id, channel_id, workspace_id, lead_id, kind
  ) values (p_message_id, p_channel_id, channel.workspace_id, lead_id, result_kind);
  return result_kind;
end;
$$;

revoke all on function public.process_wazzup_inbound_message(text, text, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.process_wazzup_inbound_message(text, text, text, text, text)
  to service_role;

comment on function public.process_wazzup_inbound_message(text, text, text, text, text) is
  'Server-only atomic intake for explicitly opted-in Wazzup mappings. No workspace from payload, automatic assignment, outgoing messages or payments.';

commit;
notify pgrst, 'reload schema';
