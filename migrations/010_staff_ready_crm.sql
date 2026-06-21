-- Negis MedCall staff-ready CRM layer.
-- Apply after 009_medcall_mvp_persistence.sql.
-- RLS is intentionally not enabled here because Vercel API routes still use
-- SUPABASE_SERVICE_ROLE_KEY. Enable tenant-scoped RLS before full multi-tenant
-- production rollout.

create table if not exists staff_users (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references workspaces(id) on delete cascade,
  email text not null,
  full_name text not null,
  phone text,
  role text not null default 'receptionist',
  status text not null default 'active',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists clients (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references workspaces(id) on delete cascade,
  full_name text not null,
  phone text,
  whatsapp text,
  source text,
  status text default 'new',
  notes text,
  last_visit_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists leads (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references workspaces(id) on delete cascade,
  client_id uuid references clients(id) on delete set null,
  full_name text,
  phone text,
  source text,
  campaign text,
  status text default 'new',
  responsible_user_id uuid references staff_users(id) on delete set null,
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists appointments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references workspaces(id) on delete cascade,
  client_id uuid references clients(id) on delete set null,
  client_name text,
  client_phone text,
  service text,
  doctor_name text,
  starts_at timestamptz,
  status text default 'scheduled',
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists calls (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references workspaces(id) on delete cascade,
  client_id uuid references clients(id) on delete set null,
  phone text,
  direction text,
  source text,
  result text,
  summary text,
  call_time timestamptz default now(),
  created_at timestamptz default now()
);

create table if not exists tasks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references workspaces(id) on delete cascade,
  title text not null,
  description text,
  assignee_user_id uuid references staff_users(id) on delete set null,
  assignee_name text,
  priority text default 'medium',
  status text default 'new',
  due_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists chat_messages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references workspaces(id) on delete cascade,
  channel text default 'general',
  sender_name text,
  sender_role text,
  message text not null,
  created_at timestamptz default now()
);

create table if not exists content_videos (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references workspaces(id) on delete cascade,
  title text not null,
  niche text,
  goal text,
  duration text,
  style text,
  audience text,
  hook text,
  script text,
  voiceover text,
  cta text,
  caption text,
  hashtags jsonb,
  avatar_prompt text,
  tapnow_prompt text,
  status text default 'idea',
  raw_payload jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists audit_logs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references workspaces(id) on delete cascade,
  actor_name text,
  actor_role text,
  action text not null,
  entity_type text,
  entity_id text,
  metadata jsonb,
  created_at timestamptz default now()
);

create index if not exists idx_staff_users_workspace_id on staff_users(workspace_id);
create index if not exists idx_staff_users_status on staff_users(status);
create index if not exists idx_staff_users_created_at on staff_users(created_at desc);

create index if not exists idx_clients_workspace_id on clients(workspace_id);
create index if not exists idx_clients_status on clients(status);
create index if not exists idx_clients_created_at on clients(created_at desc);

create index if not exists idx_leads_workspace_id on leads(workspace_id);
create index if not exists idx_leads_status on leads(status);
create index if not exists idx_leads_created_at on leads(created_at desc);

create index if not exists idx_appointments_workspace_id on appointments(workspace_id);
create index if not exists idx_appointments_status on appointments(status);
create index if not exists idx_appointments_created_at on appointments(created_at desc);
create index if not exists idx_appointments_starts_at on appointments(starts_at);

create index if not exists idx_calls_workspace_id on calls(workspace_id);
create index if not exists idx_calls_result on calls(result);
create index if not exists idx_calls_created_at on calls(created_at desc);

create index if not exists idx_tasks_workspace_id on tasks(workspace_id);
create index if not exists idx_tasks_status on tasks(status);
create index if not exists idx_tasks_created_at on tasks(created_at desc);

create index if not exists idx_chat_messages_workspace_id on chat_messages(workspace_id);
create index if not exists idx_chat_messages_channel on chat_messages(channel);
create index if not exists idx_chat_messages_created_at on chat_messages(created_at desc);

create index if not exists idx_content_videos_workspace_id on content_videos(workspace_id);
create index if not exists idx_content_videos_status on content_videos(status);
create index if not exists idx_content_videos_created_at on content_videos(created_at desc);

create index if not exists idx_audit_logs_workspace_id on audit_logs(workspace_id);
create index if not exists idx_audit_logs_created_at on audit_logs(created_at desc);
