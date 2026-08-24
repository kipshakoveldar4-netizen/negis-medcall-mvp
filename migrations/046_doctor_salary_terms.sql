-- NEGIS Migration 046 — условия оплаты мастера: фикс и процент.
--
-- Владелец: «фикс и процент, и чтобы могли менять на усмотрение админа».
-- Схема оплаты — свойство мастера, а не глобальная настройка: у топ-мастера
-- процент выше, у новичка — фикс больше.
--
-- salary_fixed_minor — фикс В МЕСЯЦ, в тиынах, как все деньги схемы.
-- salary_percent — целые проценты от выручки его записей, 0..100.
-- Оба nullable: null — «условия не заданы», и статистика честно не считает
-- зарплату вместо того, чтобы выдумать нули.
--
-- Кто правит: только manage_directory (реестр PATCH clinic-doctors не менялся).
-- Мастер свою зарплату не редактирует, а в списке справочника зарплатные
-- колонки мастеру СРЕЗАЮТСЯ сервером — чужие условия оплаты не его дело.

begin;

alter table public.clinic_doctors
  add column if not exists salary_fixed_minor bigint
    constraint clinic_doctors_salary_fixed_non_negative check (salary_fixed_minor is null or salary_fixed_minor >= 0);

alter table public.clinic_doctors
  add column if not exists salary_percent integer
    constraint clinic_doctors_salary_percent_range check (salary_percent is null or (salary_percent >= 0 and salary_percent <= 100));

commit;

notify pgrst, 'reload schema';
