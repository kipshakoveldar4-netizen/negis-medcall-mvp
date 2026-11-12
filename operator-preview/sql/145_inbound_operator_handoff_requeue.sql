-- Candidate 145: release a claimed handoff when its operator agreement ends.
-- The update runs in the same transaction as the request transition and keeps
-- resolved conversations immutable.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

do $$ begin
  if to_regclass('public.inbound_conversation_handoffs') is null
    or to_regclass('public.growth_operator_requests') is null
    or not exists(select 1 from pg_roles where rolname='service_role' and rolbypassrls)
    then raise exception 'inbound_handoff_requeue_dependencies_unconfirmed'; end if;
end $$;

create or replace function public.requeue_inbound_handoffs_after_operator_end()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status = 'accepted' and new.status = 'ended' then
    update public.inbound_conversation_handoffs
      set state = 'needs_operator',
          operator_request_id = null,
          claimed_by_operator_user_id = null,
          claimed_at = null,
          updated_at = clock_timestamp()
      where workspace_id = new.workspace_id
        and operator_request_id = new.id
        and state = 'claimed';
  end if;
  return new;
end;
$$;

revoke all on function public.requeue_inbound_handoffs_after_operator_end() from public, anon, authenticated, service_role;

drop trigger if exists inbound_handoff_requeue_after_operator_end on public.growth_operator_requests;
create trigger inbound_handoff_requeue_after_operator_end
  after update of status on public.growth_operator_requests
  for each row execute function public.requeue_inbound_handoffs_after_operator_end();

comment on function public.requeue_inbound_handoffs_after_operator_end() is
  'Releases only claimed, unresolved handoffs when an accepted operator agreement ends.';

notify pgrst, 'reload schema';
commit;
