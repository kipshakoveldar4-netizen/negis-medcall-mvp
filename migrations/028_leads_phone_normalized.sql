-- NEGIS Migration 028 — canonical phone on leads, so inbound dedup is exact.
--
-- The repeat-contact rule (W3: an inbound message from a phone that already
-- has an open lead records a repeat instead of filing a second lead) compared
-- phones in application code. To do that it read up to 1000 open leads per
-- message with no ORDER BY, normalized each one in JS, and searched the list.
--
-- Past a thousand open leads in a workspace that stops being a dedup rule:
-- PostgREST returns an arbitrary thousand rows, the returning patient's lead
-- can sit outside the window, and a duplicate lead is filed — exactly what W3
-- exists to prevent. An adversarial review of the phase-2 branch confirmed it
-- on 2026-08-03; the defect is old (it came from the original Wazzup handler)
-- and now feeds two providers.
--
-- The fix is to let the database hold the canonical form and match on it:
--
--   leads.phone_normalized  a STORED GENERATED column. Generated rather than
--                           application-maintained on purpose — every writer
--                           gets it for free, including the CRM interface,
--                           both webhook adapters and any future importer, so
--                           there is no path that can forget to fill it and
--                           silently reintroduce the miss.
--
-- The expression reproduces lib/crm/phone.ts exactly, and test:crm-phone-parity
-- pins the two against each other case by case:
--   ""            -> null      (no digits: nothing to match on)
--   00 + >9 more  -> +<rest>   (international call prefix)
--   8 + 10 digits -> +7<10>    (national trunk form used in KZ/RU)
--   otherwise     -> +<digits>
--
-- Only immutable expressions are allowed in a generated column; regexp_replace,
-- substr, length and left all qualify.
--
-- Same rules as every post-023 migration: runs as postgres, RLS on the table is
-- already enabled and unchanged, no new grants are needed (a column inherits
-- the table's privileges, and leads already grants service_role exactly what it
-- needs). Nothing here is destructive: the column is additive and derived, so
-- re-running is a no-op and no existing value is rewritten.

begin;

alter table public.leads
  add column if not exists phone_normalized text
  generated always as (
    case
      when phone is null then null
      when regexp_replace(phone, '\D', '', 'g') = '' then null
      when length(regexp_replace(phone, '\D', '', 'g')) > 11
        and left(regexp_replace(phone, '\D', '', 'g'), 2) = '00'
        then '+' || substr(regexp_replace(phone, '\D', '', 'g'), 3)
      when length(regexp_replace(phone, '\D', '', 'g')) = 11
        and left(regexp_replace(phone, '\D', '', 'g'), 1) = '8'
        then '+7' || substr(regexp_replace(phone, '\D', '', 'g'), 2)
      else '+' || regexp_replace(phone, '\D', '', 'g')
    end
  ) stored;

-- The lookup the inbound pipeline performs: one workspace, one canonical
-- phone, open leads only. Partial on the status so the index stays small and
-- matches the query's own filter.
create index if not exists leads_workspace_phone_normalized_idx
  on public.leads (workspace_id, phone_normalized)
  where phone_normalized is not null and status is distinct from 'lost';

commit;
