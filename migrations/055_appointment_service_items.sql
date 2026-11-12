-- Snapshot all services in one visit. Legacy appointments keep their existing fields.
begin;
alter table public.appointments
  add column if not exists service_items jsonb not null default '[]'::jsonb;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'appointments_service_items_shape'
    and conrelid = 'public.appointments'::regclass) then
    alter table public.appointments add constraint appointments_service_items_shape
      check (case when jsonb_typeof(service_items) = 'array'
        then jsonb_array_length(service_items) <= 20 else false end);
  end if;
end $$;

comment on column public.appointments.service_items is
  'Service snapshots: serviceId, name, priceMinor (null means unknown), durationMinutes. API validates workspace and specialist. No patient contacts.';
commit;
notify pgrst, 'reload schema';
