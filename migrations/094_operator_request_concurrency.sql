-- Apply after 053 (and 054 when lead scopes are enabled).
-- Lock the live permissions used by proposal admission. An FK's KEY SHARE
-- does not protect status/role columns from a concurrent non-key UPDATE.
-- Historical authorship remains historical: a departed requester must not
-- prevent an existing agreement from being accepted, declined or ended.
begin;

do $$
begin
  if to_regprocedure('public.check_growth_operator_request()') is null
    or to_regprocedure('public.accept_growth_operator_request(uuid,uuid)') is null
    or not exists (
      select 1 from pg_trigger
      where tgrelid = 'public.growth_operator_requests'::regclass
        and tgname = 'growth_operator_request_guard' and not tgisinternal
    )
  then raise exception 'operator_request_lifecycle_dependency_required'; end if;
end;
$$;

create or replace function public.check_growth_operator_request()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'requested' then raise exception 'operator_request_must_start_requested'; end if;
    perform 1 from public.growth_operator_profiles
      where id = new.operator_id and status = 'approved' and accepting_requests
      for share;
    if not found then raise exception 'operator_not_accepting_requests'; end if;
    perform 1 from public.staff_users s
      where s.id = new.requested_by_staff_user_id and s.workspace_id = new.workspace_id
        and s.status = 'active' and s.role in ('owner', 'admin', 'manager')
      for share;
    if not found then raise exception 'clinic_requester_required'; end if;
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

-- CREATE OR REPLACE retains the existing trigger binding and 052's ACL.
-- No new RPC, table grant, rate, membership or payment is introduced.
commit;
notify pgrst, 'reload schema';
