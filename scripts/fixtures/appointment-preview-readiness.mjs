import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const columns = {
  workspaces: ['id'],
  staff_users: ['id', 'workspace_id', 'status'],
  clinic_doctors: ['id', 'workspace_id'],
  clinic_services: ['id', 'workspace_id'],
  clients: ['id', 'workspace_id', 'full_name', 'phone', 'whatsapp', 'source', 'status', 'notes', 'last_visit_at', 'updated_at'],
  appointments: ['id', 'workspace_id', 'client_id', 'client_name', 'client_phone', 'whatsapp', 'service',
    'doctor_name', 'starts_at', 'duration_minutes', 'price_minor', 'status', 'notes', 'source', 'updated_at',
    'created_by_staff_user_id', 'doctor_id', 'service_id', 'service_items'],
  crm_appointment_create_requests: ['workspace_id', 'staff_user_id', 'request_key', 'request_fingerprint',
    'appointment_id', 'client_created', 'client_match', 'created_at'],
};
const functions = [
  'public.create_crm_appointment_with_new_client(uuid,jsonb,jsonb)',
  'public.read_crm_appointment_create_request(uuid,uuid,uuid,text)',
  'public.create_crm_appointment_once(uuid,uuid,uuid,text,jsonb,jsonb,text)',
];

// Fixed metadata contract for 063/064. No patient rows, environment, network or SQL execution.
export const appointmentReadinessQuery = `with
required_columns(table_name, column_name) as (values
${Object.entries(columns).flatMap(([table, names]) => names.map(name => `  ('${table}', '${name}')`)).join(',\n')}
), required_functions(signature) as (values
${functions.map(signature => `  ('${signature}')`).join(',\n')}
), roles(role_name) as (values ('anon'), ('authenticated'), ('service_role')),
checks as (
  select 'column:' || r.table_name || '.' || r.column_name as check_name,
    exists(select 1 from pg_catalog.pg_attribute a
      where a.attrelid = to_regclass('public.' || r.table_name)
        and a.attname = r.column_name and a.attnum > 0 and not a.attisdropped) as ready
  from required_columns r
  union all
  select 'rpc:' || f.signature, exists(select 1 from pg_catalog.pg_proc p
    where p.oid = to_regprocedure(f.signature) and p.prosecdef
      and p.prorettype = 'jsonb'::regtype)
  from required_functions f
  union all
  select 'execute:' || r.role_name || ':' || f.signature,
    case when to_regrole(r.role_name) is null or to_regprocedure(f.signature) is null then false
    else has_function_privilege(to_regrole(r.role_name), to_regprocedure(f.signature), 'EXECUTE')
      = (r.role_name = 'service_role') end
  from required_functions f cross join roles r
  union all
  select 'receipts:rls', coalesce((select c.relrowsecurity from pg_catalog.pg_class c
    where c.oid = to_regclass('public.crm_appointment_create_requests')), false)
  union all
  select 'receipts:closed:' || r.role_name,
    case when to_regrole(r.role_name) is null or to_regclass('public.crm_appointment_create_requests') is null then false
    else not has_table_privilege(to_regrole(r.role_name), to_regclass('public.crm_appointment_create_requests'),
      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      and not has_any_column_privilege(to_regrole(r.role_name), to_regclass('public.crm_appointment_create_requests'),
        'SELECT,INSERT,UPDATE,REFERENCES') end
  from roles r
)
select check_name, ready from checks order by check_name;`;

export function buildAppointmentPreviewReadiness() {
  return `-- Read-only prerequisites for appointment creation RPCs 063/064.
-- Run only in the approved isolated Preview database after checking its identity.
-- Every row must be true. This is NOT end-to-end, concurrency or payment acceptance.
begin read only;
set local statement_timeout = '10s';
${appointmentReadinessQuery}
commit;
`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [output, ...extra] = process.argv.slice(2);
  if (!output || extra.length || !path.isAbsolute(output) || !output.endsWith('.sql')) {
    throw new Error('Expected one absolute .sql output path; this command does not apply SQL.');
  }
  await writeFile(output, buildAppointmentPreviewReadiness(), { flag: 'wx', encoding: 'utf8' });
  console.log('Read-only appointment checks generated. Not executed against any database.');
}
