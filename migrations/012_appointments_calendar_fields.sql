-- Calendar workflow fields for appointments.
-- Safe to run multiple times after 010_staff_ready_crm.sql.

alter table appointments
add column if not exists duration_minutes integer default 60,
add column if not exists whatsapp text,
add column if not exists source text;

create index if not exists idx_appointments_starts_at
on appointments(starts_at);

create index if not exists idx_appointments_doctor_starts_at
on appointments(doctor_name, starts_at);
