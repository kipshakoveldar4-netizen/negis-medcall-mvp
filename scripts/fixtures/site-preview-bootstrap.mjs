import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const candidateCommit = '43568ed';
export const testProjectRef = 'ukiobbwsdoblooynzlnx';
export const migrationFiles = [
  '009_medcall_mvp_persistence.sql',
  '010_staff_ready_crm.sql',
  '011_staff_auth_foundation.sql',
  '013_release_admin_settings.sql',
  '023_public_privilege_hardening.sql',
  '059_site_blog_drafts.sql',
  '060_site_blog_publication.sql',
];

// Generate SQL only. No environment loading, credentials, network or execution.
// Sources come from the tested release candidate, not the dirty working tree.
export function buildSitePreviewBootstrap() {
  const migrations = migrationFiles.map(file => {
    const source = execFileSync('git', ['show', `${candidateCommit}:migrations/${file}`], {
      cwd: root, encoding: 'utf8', windowsHide: true,
    });
    // These reviewed scripts use standalone transaction/notification lines.
    // Remove only those wrappers so the empty-database guard covers one transaction.
    const body = source.split(/\r?\n/).filter(line =>
      !/^\s*(?:begin;|commit;|notify pgrst, 'reload schema';)\s*$/i.test(line)).join('\n');
    return `-- Source: ${candidateCommit}:migrations/${file}\n${body}`;
  }).join('\n\n');

  return `-- TEST ONLY: medina-os-site-test (${testProjectRef}).
-- Verify this exact project in the Supabase dashboard BEFORE executing.
-- The empty-database check cannot prove the project identity.
-- No live data, auth users, credentials, site activation or scheduling are created.
-- Partial schema for auth/blog acceptance; NOT a full CRM migration chain.
begin;
set local lock_timeout = '3s';
set local statement_timeout = '120s';
select pg_advisory_xact_lock(hashtext('medina-site-preview-bootstrap'));
do $preview_guard$
begin
  if exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f')
  ) then
    raise exception 'preview_requires_empty_public_schema';
  end if;
  if to_regclass('auth.users') is null then
    raise exception 'preview_requires_supabase_auth';
  end if;
  if exists (select 1 from auth.users) then
    raise exception 'preview_requires_no_auth_users';
  end if;
end;
$preview_guard$;

${migrations}

-- Keep all application tables closed to browser Data API roles, including
-- early migrations that predate the explicit security foundation.
do $preview_rls$
declare t record;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t.tablename);
  end loop;
end;
$preview_rls$;
revoke all on all tables in schema public from public, anon, authenticated;
revoke all on all sequences in schema public from public, anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;
grant select on public.workspaces, public.staff_users, public.workspace_settings to service_role;
grant select, insert, update on public.site_blog_posts to service_role;
grant execute on function public.set_site_blog_publication(uuid, uuid, integer, boolean) to service_role;
commit;
notify pgrst, 'reload schema';
`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [output, ...extra] = process.argv.slice(2);
  if (!output || extra.length || !path.isAbsolute(output) || !output.endsWith('.sql')) {
    throw new Error('Expected one absolute .sql output path; this command does not apply SQL.');
  }
  await writeFile(output, buildSitePreviewBootstrap(), { flag: 'wx', encoding: 'utf8' });
  console.log('Test-only SQL generated. Not applied to any database.');
}
