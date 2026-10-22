-- Only the taxonomy contract and future defaults change here. Existing
-- workspaces require an explicitly scoped call to seed_default_lead_taxonomy.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

do $dependency$
declare
  definition text;
begin
  if to_regclass('public.lead_stages') is null or to_regclass('public.lead_sources') is null
    or to_regprocedure('public.seed_default_lead_taxonomy(uuid)') is null then
    raise exception using errcode='P8001', message='postponed_lead_stage_requires_019';
  end if;
  lock table public.lead_stages in access exclusive mode;
  select regexp_replace(pg_get_constraintdef(c.oid), '\s', '', 'g') into definition
  from pg_constraint c
  where c.conrelid='public.lead_stages'::regclass and c.conname='lead_stages_semantic_group_check'
    and c.contype='c' and c.convalidated;
  if definition is distinct from regexp_replace($old$CHECK ((semantic_group = ANY (ARRAY['new'::text, 'in_progress'::text, 'booked'::text, 'lost'::text])))$old$, '\s', '', 'g')
    and definition is distinct from regexp_replace($new$CHECK ((semantic_group = ANY (ARRAY['new'::text, 'in_progress'::text, 'booked'::text, 'postponed'::text, 'lost'::text])))$new$, '\s', '', 'g') then
    raise exception using errcode='P8002', message='postponed_lead_stage_constraint_requires_review';
  end if;
end
$dependency$;

alter table public.lead_stages drop constraint lead_stages_semantic_group_check;
alter table public.lead_stages add constraint lead_stages_semantic_group_check
  check (semantic_group in ('new','in_progress','booked','postponed','lost'));

create or replace function public.seed_default_lead_taxonomy(target_workspace_id uuid)
returns void
language plpgsql
set search_path = public
as $$
begin
  insert into public.lead_stages (workspace_id,stage_key,name,color,semantic_group,sort_order,is_default)
  values
    (target_workspace_id,'new','Новая','#2563eb','new',10,true),
    (target_workspace_id,'in_progress','В работе','#d97706','in_progress',20,true),
    (target_workspace_id,'booked','Записана','#059669','booked',30,true),
    (target_workspace_id,'postponed','Отложена','#64748b','postponed',35,true),
    (target_workspace_id,'lost','Потеряна','#dc2626','lost',40,true)
  on conflict (workspace_id,stage_key) do nothing;

  insert into public.lead_sources (workspace_id,source_key,name,channel,color,sort_order,is_default)
  values
    (target_workspace_id,'manual','Вручную','manual','#64748b',10,true),
    (target_workspace_id,'meta_ads','Meta Ads','ads','#2563eb',20,true),
    (target_workspace_id,'instagram','Instagram','social','#db2777',30,true),
    (target_workspace_id,'whatsapp','WhatsApp','messenger','#059669',40,true),
    (target_workspace_id,'website','Сайт','website','#0891b2',50,true),
    (target_workspace_id,'referral','Рекомендация','referral','#7c3aed',60,true),
    (target_workspace_id,'webhook','Webhook','integration','#475569',70,true),
    (target_workspace_id,'other','Другое','other','#78716c',80,true)
  on conflict (workspace_id,source_key) do nothing;
end;
$$;

commit;
