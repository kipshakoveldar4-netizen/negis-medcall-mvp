-- Request authorship is historical. The acting user is authorized by the API/RPC.
-- A former employee must not freeze an existing clinic/operator agreement.
begin;

create or replace function public.check_growth_operator_request()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'requested' then raise exception 'operator_request_must_start_requested'; end if;
    if not exists (select 1 from public.growth_operator_profiles
      where id = new.operator_id and status = 'approved' and accepting_requests)
    then raise exception 'operator_not_accepting_requests'; end if;
    if not exists (
      select 1 from public.staff_users s
      where s.id = new.requested_by_staff_user_id and s.workspace_id = new.workspace_id
        and s.status = 'active' and s.role in ('owner', 'admin', 'manager')
    ) then raise exception 'clinic_requester_required'; end if;
  end if;
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

-- CREATE OR REPLACE preserves the existing trigger binding and grants from 052.
commit;
notify pgrst, 'reload schema';
