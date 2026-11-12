-- Local candidate. Requires 090; no provider, Storage, billing or cloud action.
begin;

do $$ begin
  if to_regclass('public.generated_video_workflows') is null
    or to_regclass('public.generated_video_admission_guards') is null
    or to_regprocedure('public.assert_generated_video_actor(uuid,uuid,uuid)') is null
    or to_regprocedure('public.generated_video_envelope(public.generated_video_workflows)') is null
    or not (select relrowsecurity from pg_class where oid='public.generated_video_workflows'::regclass)
    or not (select relrowsecurity from pg_class where oid='public.generated_video_admission_guards'::regclass)
    or not exists(select 1 from pg_roles where rolname='service_role' and rolbypassrls)
    then raise exception 'generated_video_terminal_dependencies_unconfirmed'; end if;
end $$;

alter table public.generated_video_workflows add column provider_failure_receipt jsonb;

create or replace function public.protect_generated_video_terminal_failure() returns trigger
language plpgsql security invoker set search_path='' as $$
declare proof jsonb;
begin
  if tg_op='DELETE' then
    if old.provider_failure_receipt is not null and exists(select 1 from public.workspaces where id=old.workspace_id)
      then raise exception using errcode='P9002',message='generated_video_terminal_proof_immutable'; end if;
    return old;
  end if;
  if new.status='cancelled' and new.provider_job_id is not null and new.provider_failure_receipt is null
    then raise exception using errcode='P9002',message='generated_video_terminal_proof_required'; end if;
  if tg_op='UPDATE' and old.provider_failure_receipt is not null then
    if new.provider_failure_receipt is distinct from old.provider_failure_receipt
      or row(new.status,new.provider_job_id,new.dispatch_id,new.input_size,new.input_sha256,new.raw_bucket,new.raw_path,new.result)
        is distinct from row(old.status,old.provider_job_id,old.dispatch_id,old.input_size,old.input_sha256,old.raw_bucket,old.raw_path,old.result)
      then raise exception using errcode='P9002',message='generated_video_terminal_proof_immutable'; end if;
  elsif new.provider_failure_receipt is not null then
    if tg_op<>'UPDATE' then raise exception using errcode='P9002',message='generated_video_terminal_proof_invalid'; end if;
    proof:=new.provider_failure_receipt;
    if old.status is distinct from 'rendering' or new.status is distinct from 'cancelled'
      or new.provider_job_id is null or (left(new.generation_key,3)='v2:' and new.dispatch_id is null)
      or new.input_size is not null or new.input_sha256 is not null or new.raw_bucket is not null or new.raw_path is not null or new.result is not null
      or jsonb_typeof(proof) is distinct from 'object'
      or (proof->>'staffUserId') is null or (proof->>'staffUserId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      or (proof->>'authUserId') is null or (proof->>'authUserId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      or proof is distinct from jsonb_build_object('kind','provider-terminal-failure-v1','provider','openai','status','failed',
        'providerJobId',new.provider_job_id,'generationKey',new.generation_key,'requestDigest',new.request_digest,'keyDigest',new.key_digest,
        'acknowledgedAt',new.updated_at,'staffUserId',proof->>'staffUserId','authUserId',proof->>'authUserId')
      or exists(select 1 from public.ad_creative_assets where id=new.asset_id)
      or exists(select 1 from public.video_processing_jobs where id=new.job_id)
      then raise exception using errcode='P9002',message='generated_video_terminal_proof_invalid'; end if;
    perform public.assert_generated_video_actor(new.workspace_id,(proof->>'staffUserId')::uuid,(proof->>'authUserId')::uuid);
  end if;
  return new;
end $$;
create trigger protect_generated_video_terminal_failure before insert or update or delete on public.generated_video_workflows
  for each row execute function public.protect_generated_video_terminal_failure();

-- Only the server's successful authenticated provider GET can supply this ACK.
-- HTTP/network/timeout/unknown errors are not terminal observations. The bound
-- provider id and request identity remain durable, so replay cannot rerender.
create or replace function public.ack_generated_video_provider_failure(p_workspace_id uuid,p_staff_user_id uuid,p_auth_user_id uuid,
  p_generation_key text,p_provider_job_id text,p_provider_status text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare o public.generated_video_workflows%rowtype; at_time timestamptz;
begin
  perform public.assert_generated_video_actor(p_workspace_id,p_staff_user_id,p_auth_user_id);
  if p_provider_status is distinct from 'failed' or p_provider_job_id is null or octet_length(p_provider_job_id) not between 1 and 512
    or p_provider_job_id<>btrim(p_provider_job_id) or p_provider_job_id ~ '[[:cntrl:]]'
    then raise exception using errcode='P9001',message='generated_video_terminal_observation_invalid'; end if;
  -- Same MVCC guard as admission: a freed slot becomes visible atomically.
  insert into public.generated_video_admission_guards(workspace_id,revision) values(p_workspace_id,1)
    on conflict(workspace_id) do update set revision=public.generated_video_admission_guards.revision+1;
  select * into o from public.generated_video_workflows where workspace_id=p_workspace_id and generation_key=p_generation_key for update;
  if not found then raise exception using errcode='P9003',message='generated_video_unavailable'; end if;
  if o.provider_job_id is distinct from p_provider_job_id or o.status not in ('rendering','cancelled')
    or o.input_size is not null or o.input_sha256 is not null or o.raw_bucket is not null or o.raw_path is not null or o.result is not null
    or exists(select 1 from public.ad_creative_assets where id=o.asset_id)
    or exists(select 1 from public.video_processing_jobs where id=o.job_id)
    then raise exception using errcode='P9002',message='generated_video_terminal_observation_conflict'; end if;
  if o.status='cancelled' then
    if o.provider_failure_receipt is null or o.provider_failure_receipt->>'providerJobId' is distinct from p_provider_job_id
      or o.provider_failure_receipt->>'status' is distinct from 'failed'
      then raise exception using errcode='P9002',message='generated_video_terminal_observation_conflict'; end if;
  else
    at_time:=clock_timestamp();
    update public.generated_video_workflows set status='cancelled',updated_at=at_time,
      provider_failure_receipt=jsonb_build_object('kind','provider-terminal-failure-v1','provider','openai','status','failed',
        'providerJobId',o.provider_job_id,'generationKey',o.generation_key,'requestDigest',o.request_digest,'keyDigest',o.key_digest,
        'acknowledgedAt',at_time,'staffUserId',p_staff_user_id,'authUserId',p_auth_user_id)
      where workspace_id=p_workspace_id and generation_key=p_generation_key returning * into o;
  end if;
  return public.generated_video_envelope(o);
end $$;

revoke select(provider_failure_receipt),insert(provider_failure_receipt),update(provider_failure_receipt),references(provider_failure_receipt)
  on table public.generated_video_workflows from public,anon,authenticated;
revoke all on function public.protect_generated_video_terminal_failure() from public,anon,authenticated;
revoke all on function public.ack_generated_video_provider_failure(uuid,uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.protect_generated_video_terminal_failure() to service_role;
grant execute on function public.ack_generated_video_provider_failure(uuid,uuid,uuid,text,text,text) to service_role;
do $$ declare role_name text; table_name text; f record; begin
  foreach role_name in array array['anon','authenticated'] loop
    foreach table_name in array array['generated_video_workflows','generated_video_admission_guards','ad_creative_assets','video_processing_jobs'] loop
      if has_table_privilege(role_name,('public.'||table_name)::regclass,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        or has_any_column_privilege(role_name,('public.'||table_name)::regclass,'SELECT,INSERT,UPDATE,REFERENCES')
        then raise exception 'generated_video_terminal_browser_table_access_unconfirmed'; end if;
    end loop;
    for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname in ('protect_generated_video_terminal_failure','ack_generated_video_provider_failure') loop
      if has_function_privilege(role_name,f.signature,'EXECUTE')
        then raise exception 'generated_video_terminal_browser_function_access_unconfirmed'; end if;
    end loop;
  end loop;
end $$;
comment on column public.generated_video_workflows.provider_failure_receipt is
  'Immutable authenticated provider terminal-failure ACK, before any input binding. Releases only native admission capacity, never paid usage or the request key. Retained until workspace deletion.';
commit;
