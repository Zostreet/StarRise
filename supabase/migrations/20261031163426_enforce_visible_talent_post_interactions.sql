
-- Enforce parent post visibility for likes and comments.

drop policy if exists "Members can comment on visible talent posts"
on public.talent_post_comments;

create policy "Members can comment on visible talent posts"
on public.talent_post_comments
for insert
to authenticated
with check (
  author_id = (select auth.uid())
  and coalesce(
    ((select auth.jwt()) ->> 'is_anonymous')::boolean,
    false
  ) = false
  and exists (
    select 1
    from public.talent_posts p
    where p.id = talent_post_comments.post_id
  )
);

drop policy if exists "Visible talent post comments"
on public.talent_post_comments;

create policy "Visible talent post comments"
on public.talent_post_comments
for select
to anon, authenticated
using (
  exists (
    select 1
    from public.talent_posts p
    where p.id = talent_post_comments.post_id
  )
);

drop policy if exists "Members can like visible talent posts"
on public.talent_post_likes;

create policy "Members can like visible talent posts"
on public.talent_post_likes
for insert
to authenticated
with check (
  user_id = (select auth.uid())
  and coalesce(
    ((select auth.jwt()) ->> 'is_anonymous')::boolean,
    false
  ) = false
  and exists (
    select 1
    from public.talent_posts p
    where p.id = talent_post_likes.post_id
  )
);

drop policy if exists "Visible talent post likes"
on public.talent_post_likes;

create policy "Visible talent post likes"
on public.talent_post_likes
for select
to anon, authenticated
using (
  exists (
    select 1
    from public.talent_posts p
    where p.id = talent_post_likes.post_id
  )
);
