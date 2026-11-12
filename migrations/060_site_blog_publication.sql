-- Explicit publication snapshots. Draft edits never change the public version.
begin;
alter table public.site_blog_posts
  add column if not exists published_snapshot jsonb,
  add column if not exists published_at timestamptz,
  add column if not exists published_version integer;

create unique index if not exists site_blog_posts_public_slug_idx
  on public.site_blog_posts(workspace_id, (published_snapshot->>'slug'))
  where published_snapshot is not null;

create or replace function public.set_site_blog_publication(
  p_workspace_id uuid, p_post_id uuid, p_version integer, p_publish boolean
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_post public.site_blog_posts%rowtype;
begin
  if p_workspace_id is null or p_post_id is null or p_version is null
    or p_publish is null then
    raise exception using message = 'invalid_publication', errcode = '22023';
  end if;
  select * into v_post from public.site_blog_posts
    where workspace_id = p_workspace_id and id = p_post_id for update;
  if not found or v_post.version <> p_version then
    raise exception using message = 'publication_conflict', errcode = '40001';
  end if;
  if p_publish and (length(btrim(v_post.body)) = 0 or length(btrim(v_post.excerpt)) = 0) then
    raise exception using message = 'incomplete_article', errcode = '22023';
  end if;
  update public.site_blog_posts set
    published_snapshot = case when p_publish then jsonb_build_object(
      'title', v_post.title, 'slug', v_post.slug, 'excerpt', v_post.excerpt,
      'body', v_post.body, 'locale', v_post.locale
    ) else null end,
    published_at = case when p_publish then now() else null end,
    published_version = case when p_publish then v_post.version + 1 else null end,
    version = v_post.version + 1, updated_at = now()
    where id = v_post.id and workspace_id = p_workspace_id
    returning * into v_post;
  return to_jsonb(v_post);
end;
$$;
revoke all on function public.set_site_blog_publication(uuid, uuid, integer, boolean)
  from public, anon, authenticated;
grant execute on function public.set_site_blog_publication(uuid, uuid, integer, boolean)
  to service_role;
comment on column public.site_blog_posts.published_snapshot is
  'Explicitly approved plain-text public copy; null means withdrawn. No draft edits are auto-published.';
commit;
notify pgrst, 'reload schema';
