create index member_conversations_created_by_idx
  on public.member_conversations (created_by);

create index member_messages_sender_created_idx
  on public.member_messages (sender_id, created_at desc);

drop policy "Public talent posts are viewable"
  on public.talent_posts;

drop policy "Signed-in members can view permitted talent posts"
  on public.talent_posts;

create policy "Anonymous visitors can view public talent posts"
on public.talent_posts
for select
to anon
using (
  status = 'published'
  and visibility = 'public'
);

create policy "Authenticated visitors can view permitted talent posts"
on public.talent_posts
for select
to authenticated
using (
  (
    status = 'published'
    and visibility = 'public'
  )
  or (
    coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
    and (
      creator_id = (select auth.uid())
      or (
        status = 'published'
        and visibility = 'members'
      )
      or (
        status = 'published'
        and visibility = 'followers'
        and exists (
          select 1
          from public.member_follows f
          where f.follower_id = (select auth.uid())
            and f.followed_id = talent_posts.creator_id
        )
      )
      or exists (
        select 1
        from public.platform_admins a
        where a.user_id = (select auth.uid())
      )
    )
  )
);
