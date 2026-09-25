-- Private editorial drafts only. No public reads or publication side effects.
begin;
create table if not exists public.site_blog_posts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  locale text not null default 'ru' check (locale = 'ru'),
  slug text not null check (length(slug) between 1 and 100 and slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  title text not null check (length(btrim(title)) between 1 and 200),
  excerpt text not null default '' check (length(excerpt) <= 500),
  body text not null default '' check (length(body) <= 30000),
  status text not null default 'draft' check (status = 'draft'),
  version integer not null default 1 check (version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, locale, slug)
);
create index if not exists site_blog_posts_workspace_updated_idx
  on public.site_blog_posts(workspace_id, updated_at desc, id);
alter table public.site_blog_posts enable row level security;
revoke all on public.site_blog_posts from public, anon, authenticated;
grant select, insert, update on public.site_blog_posts to service_role;
comment on table public.site_blog_posts is
  'Private plain-text drafts. Server-verified workspace owner/admin only. Not a public publication source.';
commit;
notify pgrst, 'reload schema';
