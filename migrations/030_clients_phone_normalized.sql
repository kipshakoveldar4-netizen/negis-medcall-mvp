-- NEGIS Migration 030 — canonical phone on clients, so lead → client conversion
-- stops creating duplicate patient cards.
--
-- The conversion looked for an existing patient by reading EVERY client of the
-- workspace and searching the array in the browser
-- (LeadsPage loadExistingClients → convertLeadToClient). Two defects, both of
-- which end in the same place: a second card for a patient who already has one.
--
--   1. Past whatever row cap PostgREST is configured with — a setting this
--      repository does not define anywhere — the returning patient's card sits
--      outside the window that came back, and the check finds nothing. This is
--      the same defect migration 028 repaired for leads, in the same shape, on
--      the other side of the conversion.
--
--   2. The browser compared digits only (`phoneDigits`), while this project's
--      canonicalizer knows that the national trunk prefix 8 and +7 address the
--      same subscriber. So «8 701 000 00 01» and «+7 701 000 00 01» were
--      already two different people to the dedup, at any clinic size, with no
--      cap involved. A clinic whose registrar types the trunk form and whose
--      WhatsApp delivers the international form has been accumulating pairs.
--
-- Both columns are generated, not application-maintained, for the reason 028
-- gives: every writer gets them for free — the CRM interface, both webhook
-- adapters, any future importer — so no path can forget to fill one and
-- silently reintroduce the miss.
--
-- whatsapp gets its own column because the conversion matches on both numbers:
-- a patient reached on WhatsApp at a number different from the one on file is
-- still that patient.
--
-- The expression is character-for-character the one in 028, which
-- test:crm-phone-parity pins against lib/crm/phone.ts case by case. Only
-- immutable expressions are allowed in a generated column; regexp_replace,
-- substr, length and left all qualify.
--
-- Same rules as every post-023 migration: runs as postgres, RLS on clients is
-- already enabled and unchanged, no new grants are needed (a column inherits
-- the table's privileges). Nothing here is destructive: both columns are
-- additive and derived, re-running is a no-op, and no existing value is
-- rewritten.

begin;

alter table public.clients
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

alter table public.clients
  add column if not exists whatsapp_normalized text
  generated always as (
    case
      when whatsapp is null then null
      when regexp_replace(whatsapp, '\D', '', 'g') = '' then null
      when length(regexp_replace(whatsapp, '\D', '', 'g')) > 11
        and left(regexp_replace(whatsapp, '\D', '', 'g'), 2) = '00'
        then '+' || substr(regexp_replace(whatsapp, '\D', '', 'g'), 3)
      when length(regexp_replace(whatsapp, '\D', '', 'g')) = 11
        and left(regexp_replace(whatsapp, '\D', '', 'g'), 1) = '8'
        then '+7' || substr(regexp_replace(whatsapp, '\D', '', 'g'), 2)
      else '+' || regexp_replace(whatsapp, '\D', '', 'g')
    end
  ) stored;

-- The lookup the conversion performs: one workspace, one canonical number,
-- either column. Partial so the index carries only rows that can match.
create index if not exists clients_workspace_phone_normalized_idx
  on public.clients (workspace_id, phone_normalized)
  where phone_normalized is not null;

create index if not exists clients_workspace_whatsapp_normalized_idx
  on public.clients (workspace_id, whatsapp_normalized)
  where whatsapp_normalized is not null;

commit;
