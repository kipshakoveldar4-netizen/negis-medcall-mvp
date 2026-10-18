begin;

do $dependency$
begin
  if to_regclass('public.meta_ad_accounts') is null then
    raise exception using errcode = 'P7502', message = 'meta_account_binding_requires_013';
  end if;
end
$dependency$;

lock table public.meta_ad_accounts in share row exclusive mode;

-- Preserve ambiguous legacy rows for an explicit administrator decision.
do $duplicates$
begin
  if exists (
    select 1 from public.meta_ad_accounts
    where workspace_id is not null
    group by workspace_id having count(*) > 1
  ) then
    raise exception using errcode = 'P7501', message = 'meta_account_binding_duplicates_require_review';
  end if;
end
$duplicates$;

create unique index if not exists meta_ad_accounts_one_workspace_idx
  on public.meta_ad_accounts(workspace_id);

do $index_contract$
begin
  if not exists (
    select 1 from pg_index i
    join pg_attribute a on a.attrelid = i.indrelid and a.attname = 'workspace_id'
    where i.indexrelid = 'public.meta_ad_accounts_one_workspace_idx'::regclass
      and i.indrelid = 'public.meta_ad_accounts'::regclass
      and i.indisunique and i.indisvalid and i.indisready
      and i.indnkeyatts = 1 and i.indnatts = 1 and i.indkey[0] = a.attnum
      and i.indexprs is null and i.indpred is null
  ) then
    raise exception using errcode = 'P7503', message = 'meta_account_binding_index_contract_mismatch';
  end if;
end
$index_contract$;

commit;
