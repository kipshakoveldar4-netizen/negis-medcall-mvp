-- Opt-in only. No historical payments, workspace activation or production tests.
begin;

alter table public.workspaces
  add column if not exists arrival_marks_paid boolean not null default false;
alter table public.appointments
  add column if not exists arrival_sale_id uuid references public.deals(id) on delete restrict;
create index if not exists appointments_arrival_sale_idx
  on public.appointments(arrival_sale_id) where arrival_sale_id is not null;

-- Serialize manual sale creation with arrival confirmation using the visit lock.
create or replace function public.guard_arrival_sale_link()
returns trigger language plpgsql set search_path = public, pg_temp as $$
declare
  v_enabled boolean;
begin
  if tg_op = 'UPDATE' then
    if (new.appointment_id is distinct from old.appointment_id
      or new.workspace_id is distinct from old.workspace_id) and exists (
      select 1 from public.appointments where arrival_sale_id = old.id
    ) then
      raise exception using errcode = 'P6107', message = 'arrival_receipt_link_locked';
    end if;
  end if;
  if new.appointment_id is null then return new; end if;
  select w.arrival_marks_paid into v_enabled
    from public.appointments a join public.workspaces w on w.id = a.workspace_id
    where a.id = new.appointment_id and a.workspace_id = new.workspace_id
    for update of a;
  if not found then
    raise exception using errcode = 'P6101', message = 'arrival_invalid_link';
  end if;
  if v_enabled and exists (
    select 1 from public.deals d
    where d.workspace_id = new.workspace_id and d.appointment_id = new.appointment_id
      and d.id <> new.id
  ) then
    raise exception using errcode = 'P6102', message = 'arrival_sale_exists';
  end if;
  return new;
end;
$$;

drop trigger if exists guard_arrival_sale_link on public.deals;
create trigger guard_arrival_sale_link
  before insert or update of appointment_id, workspace_id on public.deals
  for each row execute function public.guard_arrival_sale_link();

create or replace function public.record_appointment_arrival_payment()
returns trigger language plpgsql set search_path = public, pg_temp as $$
declare
  v_deal public.deals%rowtype;
  v_count integer;
  v_staff_id uuid;
begin
  if new.status is distinct from 'arrived' then return new; end if;
  if tg_op = 'UPDATE' then
    if old.status = 'arrived' then return new; end if;
  end if;
  if not exists (select 1 from public.workspaces
    where id = new.workspace_id and arrival_marks_paid) then return new; end if;

  -- An existing receipt remains linked even after a refund or status reversal.
  -- Arrival must never silently undo a refund or create another payment.
  if new.arrival_sale_id is not null then return new; end if;
  select count(*) into v_count from public.deals
    where workspace_id = new.workspace_id and appointment_id = new.id;
  if v_count > 1 then
    raise exception using errcode = 'P6103', message = 'arrival_sales_ambiguous';
  end if;
  select * into v_deal from public.deals
    where workspace_id = new.workspace_id and appointment_id = new.id for update;
  if v_deal.id is not null and v_deal.status in ('cancelled', 'refunded') then
    raise exception using errcode = 'P6104', message = 'arrival_sale_closed';
  end if;
  if v_deal.id is null or v_deal.status <> 'paid' then
    if new.price_minor is null then
      raise exception using errcode = 'P6105', message = 'arrival_price_required';
    end if;
    if (new.client_id is not null and not exists (
      select 1 from public.clients where id = new.client_id and workspace_id = new.workspace_id
    )) or (new.service_id is not null and not exists (
      select 1 from public.clinic_services where id = new.service_id and workspace_id = new.workspace_id
    )) then
      raise exception using errcode = 'P6101', message = 'arrival_invalid_link';
    end if;
    select staff_user_id into v_staff_id from public.clinic_doctors
      where id = new.doctor_id and workspace_id = new.workspace_id;
    if v_deal.id is null then
      insert into public.deals (
        workspace_id, appointment_id, client_id, service_id, title,
        amount_minor, currency, status, paid_at, responsible_user_id
      ) values (
        new.workspace_id, new.id, new.client_id, new.service_id,
        coalesce(nullif(btrim(new.service), ''), 'Услуги по записи'),
        new.price_minor, 'KZT', 'paid', now(), v_staff_id
      ) returning * into v_deal;
    else
      if v_deal.currency <> 'KZT' then
        raise exception using errcode = 'P6106', message = 'arrival_currency_conflict';
      end if;
      update public.deals set amount_minor = new.price_minor, status = 'paid',
        paid_at = now(), updated_at = now()
        where id = v_deal.id and workspace_id = new.workspace_id;
    end if;
  end if;
  -- AFTER trigger covers both new visits and status transitions atomically.
  update public.appointments set arrival_sale_id = v_deal.id where id = new.id;
  return new;
end;
$$;

drop trigger if exists record_appointment_arrival_payment on public.appointments;
create trigger record_appointment_arrival_payment
  after insert or update of status on public.appointments
  for each row execute function public.record_appointment_arrival_payment();

revoke all on function public.guard_arrival_sale_link() from public, anon, authenticated;
revoke all on function public.record_appointment_arrival_payment() from public, anon, authenticated;

comment on column public.workspaces.arrival_marks_paid is
  'Explicit opt-in: a new arrived transition records one paid KZT sale using the visit price snapshot. Default off; no historical backfill.';
comment on column public.appointments.arrival_sale_id is
  'Server-owned link to the sale recorded or reused on arrival. Does not imply the sale is still paid after a refund.';

commit;
notify pgrst, 'reload schema';
