-- StarRise member talent community
-- Photos and videos remain in a private bucket. Database RLS decides who can
-- discover a post and who may create a short-lived signed media URL.

create schema if not exists starrise_private;
revoke all on schema starrise_private from public, anon, authenticated;

create table public.member_follows (
  follower_id uuid not null references auth.users(id) on delete cascade,
  followed_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint member_follows_pkey primary key (follower_id, followed_id),
  constraint member_follows_no_self check (follower_id <> followed_id)
);

create table public.talent_posts (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references auth.users(id) on delete cascade,
  caption text not null default '',
  media_path text not null unique,
  media_kind text not null,
  media_mime_type text not null,
  visibility text not null default 'public',
  status text not null default 'published',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint talent_posts_caption_length
    check (char_length(caption) <= 2200),
  constraint talent_posts_media_kind
    check (media_kind in ('image', 'video')),
  constraint talent_posts_media_mime_type
    check (
      (media_kind = 'image' and media_mime_type in (
        'image/jpeg', 'image/png', 'image/webp', 'image/gif'
      ))
      or
      (media_kind = 'video' and media_mime_type in (
        'video/mp4', 'video/webm', 'video/quicktime'
      ))
    ),
  constraint talent_posts_visibility
    check (visibility in ('public', 'members', 'followers', 'private')),
  constraint talent_posts_status
    check (status in ('published', 'hidden')),
  constraint talent_posts_media_path_length
    check (char_length(media_path) between 3 and 500),
  constraint talent_posts_media_path_owner
    check (
      split_part(media_path, '/', 1) = creator_id::text
      and media_path = btrim(media_path)
      and media_path not like '/%'
      and media_path not like '%//%'
      and position('..' in media_path) = 0
    )
);

create table public.talent_post_likes (
  post_id uuid not null references public.talent_posts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint talent_post_likes_pkey primary key (post_id, user_id)
);

create table public.talent_post_comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.talent_posts(id) on delete cascade,
  author_id uuid not null references auth.users(id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now(),
  constraint talent_post_comments_body_length
    check (char_length(btrim(body)) between 1 and 1000)
);

create table public.member_conversations (
  id uuid primary key default gen_random_uuid(),
  user_a uuid not null references auth.users(id) on delete cascade,
  user_b uuid not null references auth.users(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  last_message_at timestamptz not null default now(),
  constraint member_conversations_pair unique (user_a, user_b),
  constraint member_conversations_canonical_pair check (user_a < user_b),
  constraint member_conversations_creator_is_participant
    check (created_by in (user_a, user_b))
);

create table public.member_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null
    references public.member_conversations(id) on delete cascade,
  sender_id uuid not null references auth.users(id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  constraint member_messages_body_length
    check (char_length(btrim(body)) between 1 and 4000),
  constraint member_messages_read_after_send
    check (read_at is null or read_at >= created_at)
);

create index member_follows_followed_created_idx
  on public.member_follows (followed_id, created_at desc);

create index talent_posts_feed_idx
  on public.talent_posts (created_at desc)
  where status = 'published';

create index talent_posts_creator_created_idx
  on public.talent_posts (creator_id, created_at desc);

create index talent_post_likes_user_created_idx
  on public.talent_post_likes (user_id, created_at desc);

create index talent_post_comments_post_created_idx
  on public.talent_post_comments (post_id, created_at);

create index talent_post_comments_author_created_idx
  on public.talent_post_comments (author_id, created_at desc);

create index member_conversations_user_a_activity_idx
  on public.member_conversations (user_a, last_message_at desc);

create index member_conversations_user_b_activity_idx
  on public.member_conversations (user_b, last_message_at desc);

create index member_messages_conversation_created_idx
  on public.member_messages (conversation_id, created_at);

create index member_messages_unread_idx
  on public.member_messages (conversation_id, created_at)
  where read_at is null;

create or replace function starrise_private.touch_talent_post_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

revoke all on function starrise_private.touch_talent_post_updated_at()
  from public, anon, authenticated;

create trigger talent_posts_touch_updated_at
before update on public.talent_posts
for each row
execute function starrise_private.touch_talent_post_updated_at();

create or replace function starrise_private.notify_new_follow()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_name text;
begin
  select coalesce(nullif(btrim(p.display_name), ''), nullif(btrim(p.full_name), ''), 'A StarRise member')
  into actor_name
  from public."Profiles" p
  where p.id = new.follower_id;

  insert into public.notifications (user_id, type, title, message, created_at)
  values (
    new.followed_id,
    'new_follower',
    'New StarRise follower',
    coalesce(actor_name, 'A StarRise member') || ' started following you.',
    new.created_at
  );

  return new;
end;
$$;

revoke all on function starrise_private.notify_new_follow()
  from public, anon, authenticated;

create trigger member_follows_notify
after insert on public.member_follows
for each row
execute function starrise_private.notify_new_follow();

create or replace function starrise_private.notify_post_like()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  post_owner uuid;
  actor_name text;
begin
  select p.creator_id
  into post_owner
  from public.talent_posts p
  where p.id = new.post_id;

  if post_owner is null or post_owner = new.user_id then
    return new;
  end if;

  select coalesce(nullif(btrim(p.display_name), ''), nullif(btrim(p.full_name), ''), 'A StarRise member')
  into actor_name
  from public."Profiles" p
  where p.id = new.user_id;

  insert into public.notifications (user_id, type, title, message, created_at)
  values (
    post_owner,
    'post_like',
    'Someone liked your talent post',
    coalesce(actor_name, 'A StarRise member') || ' liked your talent post.',
    new.created_at
  );

  return new;
end;
$$;

revoke all on function starrise_private.notify_post_like()
  from public, anon, authenticated;

create trigger talent_post_likes_notify
after insert on public.talent_post_likes
for each row
execute function starrise_private.notify_post_like();

create or replace function starrise_private.notify_post_comment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  post_owner uuid;
  actor_name text;
begin
  select p.creator_id
  into post_owner
  from public.talent_posts p
  where p.id = new.post_id;

  if post_owner is null or post_owner = new.author_id then
    return new;
  end if;

  select coalesce(nullif(btrim(p.display_name), ''), nullif(btrim(p.full_name), ''), 'A StarRise member')
  into actor_name
  from public."Profiles" p
  where p.id = new.author_id;

  insert into public.notifications (user_id, type, title, message, created_at)
  values (
    post_owner,
    'post_comment',
    'New comment on your talent post',
    coalesce(actor_name, 'A StarRise member') || ' commented on your talent post.',
    new.created_at
  );

  return new;
end;
$$;

revoke all on function starrise_private.notify_post_comment()
  from public, anon, authenticated;

create trigger talent_post_comments_notify
after insert on public.talent_post_comments
for each row
execute function starrise_private.notify_post_comment();

create or replace function starrise_private.process_direct_message()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  recipient_id uuid;
  actor_name text;
begin
  update public.member_conversations
  set last_message_at = new.created_at
  where id = new.conversation_id
    and new.sender_id in (user_a, user_b);

  select
    case when c.user_a = new.sender_id then c.user_b else c.user_a end
  into recipient_id
  from public.member_conversations c
  where c.id = new.conversation_id
    and new.sender_id in (c.user_a, c.user_b);

  if recipient_id is null then
    raise exception 'Message sender is not a conversation participant';
  end if;

  select coalesce(nullif(btrim(p.display_name), ''), nullif(btrim(p.full_name), ''), 'A StarRise member')
  into actor_name
  from public."Profiles" p
  where p.id = new.sender_id;

  insert into public.notifications (user_id, type, title, message, created_at)
  values (
    recipient_id,
    'direct_message',
    'New private StarRise message',
    coalesce(actor_name, 'A StarRise member') || ' sent you a private message.',
    new.created_at
  );

  return new;
end;
$$;

revoke all on function starrise_private.process_direct_message()
  from public, anon, authenticated;

create trigger member_messages_process
after insert on public.member_messages
for each row
execute function starrise_private.process_direct_message();

alter table public.member_follows enable row level security;
alter table public.talent_posts enable row level security;
alter table public.talent_post_likes enable row level security;
alter table public.talent_post_comments enable row level security;
alter table public.member_conversations enable row level security;
alter table public.member_messages enable row level security;

create policy "Signed-in members can view follows"
on public.member_follows
for select
to authenticated
using (
  coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
);

create policy "Members can follow other members"
on public.member_follows
for insert
to authenticated
with check (
  (select auth.uid()) = follower_id
  and coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
);

create policy "Members can unfollow"
on public.member_follows
for delete
to authenticated
using (
  (select auth.uid()) = follower_id
  and coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
);

create policy "Public talent posts are viewable"
on public.talent_posts
for select
to anon, authenticated
using (
  status = 'published'
  and visibility = 'public'
);

create policy "Signed-in members can view permitted talent posts"
on public.talent_posts
for select
to authenticated
using (
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
);

create policy "Members can create talent posts"
on public.talent_posts
for insert
to authenticated
with check (
  creator_id = (select auth.uid())
  and coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
);

create policy "Creators can update talent posts"
on public.talent_posts
for update
to authenticated
using (
  coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
  and (
    creator_id = (select auth.uid())
    or exists (
      select 1
      from public.platform_admins a
      where a.user_id = (select auth.uid())
    )
  )
)
with check (
  coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
  and (
    creator_id = (select auth.uid())
    or exists (
      select 1
      from public.platform_admins a
      where a.user_id = (select auth.uid())
    )
  )
);

create policy "Creators can delete talent posts"
on public.talent_posts
for delete
to authenticated
using (
  coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
  and (
    creator_id = (select auth.uid())
    or exists (
      select 1
      from public.platform_admins a
      where a.user_id = (select auth.uid())
    )
  )
);

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

create policy "Members can like visible talent posts"
on public.talent_post_likes
for insert
to authenticated
with check (
  user_id = (select auth.uid())
  and coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
  and exists (
    select 1
    from public.talent_posts p
    where p.id = talent_post_likes.post_id
  )
);

create policy "Members can remove own talent post likes"
on public.talent_post_likes
for delete
to authenticated
using (
  user_id = (select auth.uid())
  and coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
);

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

create policy "Members can comment on visible talent posts"
on public.talent_post_comments
for insert
to authenticated
with check (
  author_id = (select auth.uid())
  and coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
  and exists (
    select 1
    from public.talent_posts p
    where p.id = talent_post_comments.post_id
  )
);

create policy "Members can delete own talent post comments"
on public.talent_post_comments
for delete
to authenticated
using (
  coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
  and (
    author_id = (select auth.uid())
    or exists (
      select 1
      from public.platform_admins a
      where a.user_id = (select auth.uid())
    )
  )
);

create policy "Participants can view conversations"
on public.member_conversations
for select
to authenticated
using (
  (select auth.uid()) in (user_a, user_b)
  and coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
);

create policy "Members can start direct conversations"
on public.member_conversations
for insert
to authenticated
with check (
  created_by = (select auth.uid())
  and (select auth.uid()) in (user_a, user_b)
  and coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
);

create policy "Participants can view direct messages"
on public.member_messages
for select
to authenticated
using (
  coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
  and exists (
    select 1
    from public.member_conversations c
    where c.id = member_messages.conversation_id
      and (select auth.uid()) in (c.user_a, c.user_b)
  )
);

create policy "Participants can send direct messages"
on public.member_messages
for insert
to authenticated
with check (
  sender_id = (select auth.uid())
  and coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
  and exists (
    select 1
    from public.member_conversations c
    where c.id = member_messages.conversation_id
      and (select auth.uid()) in (c.user_a, c.user_b)
  )
);

create policy "Recipients can mark direct messages read"
on public.member_messages
for update
to authenticated
using (
  sender_id <> (select auth.uid())
  and coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
  and exists (
    select 1
    from public.member_conversations c
    where c.id = member_messages.conversation_id
      and (select auth.uid()) in (c.user_a, c.user_b)
  )
)
with check (
  sender_id <> (select auth.uid())
  and read_at is not null
  and coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
  and exists (
    select 1
    from public.member_conversations c
    where c.id = member_messages.conversation_id
      and (select auth.uid()) in (c.user_a, c.user_b)
  )
);

revoke all on public.member_follows from anon, authenticated;
revoke all on public.talent_posts from anon, authenticated;
revoke all on public.talent_post_likes from anon, authenticated;
revoke all on public.talent_post_comments from anon, authenticated;
revoke all on public.member_conversations from anon, authenticated;
revoke all on public.member_messages from anon, authenticated;

grant select on public.talent_posts to anon;
grant select on public.talent_post_likes to anon;
grant select on public.talent_post_comments to anon;

grant select, insert, update, delete on public.talent_posts to authenticated;
grant select, insert, delete on public.talent_post_likes to authenticated;
grant select, insert, delete on public.talent_post_comments to authenticated;
grant select, insert, delete on public.member_follows to authenticated;
grant select, insert on public.member_conversations to authenticated;
grant select, insert on public.member_messages to authenticated;
grant update (read_at) on public.member_messages to authenticated;

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'talent-posts',
  'talent-posts',
  false,
  104857600,
  array[
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
    'video/mp4',
    'video/webm',
    'video/quicktime'
  ]::text[]
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy "View permitted talent post media"
on storage.objects
for select
to anon, authenticated
using (
  bucket_id = 'talent-posts'
  and exists (
    select 1
    from public.talent_posts p
    where p.media_path = storage.objects.name
  )
);

create policy "Creators can read own talent post media"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'talent-posts'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
);

create policy "Creators can upload talent post media"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'talent-posts'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
);

create policy "Creators can update own talent post media"
on storage.objects
for update
to authenticated
using (
  bucket_id = 'talent-posts'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
)
with check (
  bucket_id = 'talent-posts'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
);

create policy "Creators can delete own talent post media"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'talent-posts'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
);

do $$
begin
  if exists (
    select 1 from pg_publication where pubname = 'supabase_realtime'
  ) then
    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'member_messages'
    ) then
      alter publication supabase_realtime add table public.member_messages;
    end if;

    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'talent_post_comments'
    ) then
      alter publication supabase_realtime add table public.talent_post_comments;
    end if;

    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'talent_post_likes'
    ) then
      alter publication supabase_realtime add table public.talent_post_likes;
    end if;
  end if;
end;
$$;

comment on table public.talent_posts is
  'StarRise member photo and video talent posts with creator-selected visibility.';

comment on column public.talent_posts.visibility is
  'public, members, followers, or private; enforced by RLS and private storage policies.';

comment on table public.member_messages is
  'Private one-to-one member messages; only conversation participants can select rows.';
