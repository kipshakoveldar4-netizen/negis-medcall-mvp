-- Local candidate: couple native dispatch to its original reserved quota receipt.
-- No existing operation is backfilled, cancelled, refunded or sent to a provider.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

do $dependencies$ begin
  if to_regclass('public.generated_video_workflows') is null
    or to_regclass('public.content_generation_usage') is null
    or to_regprocedure('public.assert_generated_video_actor(uuid,uuid,uuid)') is null
    or to_regprocedure('public.generated_video_envelope(public.generated_video_workflows)') is null
    or to_regprocedure('public.begin_generated_video_dispatch(uuid,uuid,uuid,text,uuid)') is null
    or to_regprocedure('public.reserve_content_generation_usage(uuid,uuid,uuid,text,text,integer,integer,text,text)') is null
    then raise exception using errcode='P1060',message='generated_video_quota_dependencies_unconfirmed'; end if;
end $dependencies$;

lock table public.generated_video_workflows,public.content_generation_usage in share row exclusive mode;
do $authority$ declare r text; t text; begin
  if not exists(select 1 from pg_roles where rolname='service_role' and rolbypassrls and not rolsuper)
    then raise exception using errcode='P1060',message='generated_video_quota_authority_unconfirmed'; end if;
  foreach t in array array['generated_video_workflows','content_generation_usage'] loop
    if not (select relrowsecurity from pg_class where oid=('public.'||t)::regclass)
      then raise exception using errcode='P1060',message='generated_video_quota_rls_unconfirmed'; end if;
    foreach r in array array['anon','authenticated'] loop
      if exists(select 1 from pg_roles where rolname=r and rolbypassrls)
        or has_table_privilege(r,('public.'||t)::regclass,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        or has_any_column_privilege(r,('public.'||t)::regclass,'SELECT,INSERT,UPDATE,REFERENCES')
        then raise exception using errcode='P1060',message='generated_video_quota_browser_access_unconfirmed'; end if;
    end loop;
  end loop;
end $authority$;

alter table public.generated_video_workflows add column if not exists quota_usage_id uuid
  references public.content_generation_usage(id) deferrable initially deferred;
do $column$ begin
  if not exists(select 1 from pg_attribute where attrelid='public.generated_video_workflows'::regclass
    and attname='quota_usage_id' and atttypid='uuid'::regtype and not attisdropped)
    or not exists(select 1 from pg_constraint where conrelid='public.generated_video_workflows'::regclass
      and conname='generated_video_workflows_quota_usage_id_fkey' and contype='f'
      and confrelid='public.content_generation_usage'::regclass and condeferrable and condeferred and convalidated
      and confdeltype='a' and confupdtype='a'
      and conkey=array[(select attnum from pg_attribute where attrelid='public.generated_video_workflows'::regclass and attname='quota_usage_id')]::smallint[]
      and confkey=array[(select attnum from pg_attribute where attrelid='public.content_generation_usage'::regclass and attname='id')]::smallint[])
    then raise exception using errcode='P1060',message='generated_video_quota_column_unconfirmed'; end if;
end $column$;
create unique index if not exists generated_video_workflows_quota_usage_unique
  on public.generated_video_workflows(quota_usage_id) where quota_usage_id is not null;
do $index$ begin
  if not exists(select 1 from pg_index where indexrelid='public.generated_video_workflows_quota_usage_unique'::regclass
    and indrelid='public.generated_video_workflows'::regclass and indisunique and indisvalid and indnkeyatts=1
    and indkey[0]=(select attnum from pg_attribute where attrelid='public.generated_video_workflows'::regclass and attname='quota_usage_id')
    and pg_get_expr(indpred,indrelid)='(quota_usage_id IS NOT NULL)')
    then raise exception using errcode='P1060',message='generated_video_quota_index_unconfirmed'; end if;
end $index$;

create or replace function public.protect_generated_video_quota_binding() returns trigger
language plpgsql security invoker set search_path='' as $$ begin
  if (old.quota_usage_id is not null and new.quota_usage_id is distinct from old.quota_usage_id)
    or (old.quota_usage_id is null and new.quota_usage_id is not null and old.status<>'reserved')
    then raise exception using errcode='P9002',message='generated_video_quota_binding_immutable'; end if;
  return new;
end $$;
drop trigger if exists protect_generated_video_quota_binding on public.generated_video_workflows;
create trigger protect_generated_video_quota_binding before update on public.generated_video_workflows
  for each row execute function public.protect_generated_video_quota_binding();

create or replace function public.begin_generated_video_dispatch_with_usage(
  p_workspace_id uuid,p_staff_user_id uuid,p_auth_user_id uuid,p_generation_key text,p_dispatch_id uuid,
  p_usage_id uuid,p_request_digest text,p_units integer,p_limit_units integer,p_model text
)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare o public.generated_video_workflows%rowtype; u public.content_generation_usage%rowtype; accepted boolean:=false;
begin
  perform public.assert_generated_video_actor(p_workspace_id,p_staff_user_id,p_auth_user_id);
  if p_generation_key is null or p_generation_key !~ '^v2:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or p_dispatch_id is null or p_dispatch_id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or p_usage_id is null or p_request_digest is null or p_request_digest !~ '^[0-9a-f]{64}$'
    or p_units is null or p_units not between 1 and 3600 or p_limit_units is null or p_limit_units<p_units
    or p_model is null or char_length(p_model) not between 1 and 120 or p_model<>btrim(p_model) or p_model ~ '[[:cntrl:]]'
    then raise exception using errcode='P9001',message='generated_video_quota_dispatch_invalid'; end if;
  select * into o from public.generated_video_workflows
    where workspace_id=p_workspace_id and generation_key=p_generation_key for update;
  if not found then raise exception using errcode='P9003',message='generated_video_unavailable'; end if;
  if row(o.created_by_staff_user_id,o.created_by_auth_user_id,o.request_digest)
    is distinct from row(p_staff_user_id,p_auth_user_id,p_request_digest)
    or (o.quota_usage_id is not null and o.quota_usage_id<>p_usage_id)
    then raise exception using errcode='P9002',message='generated_video_quota_identity_conflict'; end if;
  select * into u from public.content_generation_usage where id=p_usage_id for share;
  if not found or row(u.workspace_id,u.staff_user_id,u.request_key,u.operation,u.kind,u.units,u.provider,u.model)
    is distinct from row(p_workspace_id,p_staff_user_id,substring(p_generation_key from 4)::uuid,'generated_video'::text,'video_seconds'::text,p_units,'openai'::text,p_model)
    or u.created_at<o.created_at
    or u.period_start<>date_trunc('month',u.created_at at time zone 'UTC')::date
    then raise exception using errcode='P9002',message='generated_video_quota_receipt_conflict'; end if;
  if o.status='reserved' or (o.status='dispatching' and o.dispatch_id=p_dispatch_id) then
    if u.status<>'reserved' or u.completed_at is not null or u.error_code is not null
      then raise exception using errcode='P9002',message='generated_video_quota_not_reserved'; end if;
    if o.status='reserved' then
      if o.reserved_until<=clock_timestamp() then raise exception using errcode='P9003',message='generated_video_reservation_expired'; end if;
      update public.generated_video_workflows set status='dispatching',dispatch_id=p_dispatch_id,quota_usage_id=p_usage_id,updated_at=clock_timestamp()
        where workspace_id=p_workspace_id and generation_key=p_generation_key returning * into o;
    elsif o.quota_usage_id is distinct from p_usage_id then
      raise exception using errcode='P9002',message='generated_video_quota_binding_unconfirmed';
    end if;
    accepted:=true;
  end if;
  return public.generated_video_envelope(o)||jsonb_build_object('dispatchAccepted',accepted);
end $$;

revoke all on function public.begin_generated_video_dispatch(uuid,uuid,uuid,text,uuid) from public,anon,authenticated,service_role;
revoke all on function public.begin_generated_video_dispatch_with_usage(uuid,uuid,uuid,text,uuid,uuid,text,integer,integer,text)
  from public,anon,authenticated;
revoke all on function public.protect_generated_video_quota_binding() from public,anon,authenticated;
grant execute on function public.begin_generated_video_dispatch_with_usage(uuid,uuid,uuid,text,uuid,uuid,text,integer,integer,text),
  public.protect_generated_video_quota_binding() to service_role;
revoke select(quota_usage_id),insert(quota_usage_id),update(quota_usage_id),references(quota_usage_id)
  on public.generated_video_workflows from public,anon,authenticated;
do $effective_access$ declare r text; begin
  if has_function_privilege('service_role','public.begin_generated_video_dispatch(uuid,uuid,uuid,text,uuid)','EXECUTE')
    then raise exception using errcode='P1060',message='generated_video_legacy_dispatch_access_unconfirmed'; end if;
  foreach r in array array['anon','authenticated'] loop
    if has_function_privilege(r,'public.begin_generated_video_dispatch_with_usage(uuid,uuid,uuid,text,uuid,uuid,text,integer,integer,text)','EXECUTE')
      then raise exception using errcode='P1060',message='generated_video_quota_rpc_access_unconfirmed'; end if;
  end loop;
end $effective_access$;
comment on column public.generated_video_workflows.quota_usage_id is 'Immutable original reserved quota receipt for dispatch; legacy rows remain unbound and are never automatically reconciled.';
commit;
notify pgrst,'reload schema';
