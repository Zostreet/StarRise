-- Private, immutable studio snapshots. Account and payment flows remain independent.
create table public.studio_sessions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id),
  name text not null check (char_length(name) between 1 and 300),
  description text not null default '' check (char_length(description) <= 5000),
  archived boolean not null default false,
  created_at timestamptz not null default now()
);
create index studio_sessions_owner_idx on public.studio_sessions(owner_id,created_at desc);
create table public.studio_collaborators (
  session_id uuid not null references public.studio_sessions(id),
  user_id uuid not null references auth.users(id),
  invited_by uuid not null references auth.users(id),
  role text not null check (role in ('editor','viewer')),
  status text not null default 'invited' check (status in ('invited','accepted','declined','removed')),
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  primary key (session_id,user_id)
);
create index studio_collaborators_user_idx on public.studio_collaborators(user_id,status);
create index studio_collaborators_inviter_idx on public.studio_collaborators(invited_by);
create table public.studio_versions (
  id uuid primary key,
  session_id uuid not null references public.studio_sessions(id),
  author_id uuid not null references auth.users(id),
  base_version_id uuid references public.studio_versions(id),
  label text not null check (char_length(label) between 1 and 160),
  notes text not null default '' check (char_length(notes) <= 5000),
  asset_path text not null unique,
  asset_bytes bigint not null check (asset_bytes between 1 and 52428800),
  state text not null default 'pending' check (state in ('pending','ready','failed')),
  created_at timestamptz not null default now(),
  unique (session_id,id),
  check (asset_path = session_id::text || '/' || id::text || '.json')
);
create index studio_versions_session_idx on public.studio_versions(session_id,created_at desc);
create index studio_versions_author_idx on public.studio_versions(author_id);
create index studio_versions_base_idx on public.studio_versions(base_version_id);
create table public.studio_comments (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.studio_sessions(id),
  version_id uuid,
  author_id uuid not null references auth.users(id),
  body text not null check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default now(),
  foreign key (session_id,version_id) references public.studio_versions(session_id,id)
);
create index studio_comments_session_idx on public.studio_comments(session_id,created_at);
create index studio_comments_version_idx on public.studio_comments(session_id,version_id);
create index studio_comments_author_idx on public.studio_comments(author_id);

create or replace function starrise_private.studio_account() returns uuid
language plpgsql stable security invoker set search_path = '' as $$
begin
  if auth.uid() is null or coalesce(auth.jwt()->>'is_anonymous','false')='true' then
    raise exception 'Sign in with a registered StarRise account.' using errcode='42501';
  end if;
  return auth.uid();
end $$;
create or replace function starrise_private.studio_is_owner(p_session uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and coalesce(auth.jwt()->>'is_anonymous','false')='false'
    and exists(select 1 from public.studio_sessions s where s.id=p_session and s.owner_id=auth.uid() and not s.archived)
$$;
create or replace function starrise_private.studio_can_read(p_session uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and coalesce(auth.jwt()->>'is_anonymous','false')='false'
    and exists(select 1 from public.studio_sessions s where s.id=p_session and not s.archived and
      (s.owner_id=auth.uid() or exists(select 1 from public.studio_collaborators c where c.session_id=s.id and c.user_id=auth.uid() and c.status='accepted')))
$$;
create or replace function starrise_private.studio_can_write(p_session uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and coalesce(auth.jwt()->>'is_anonymous','false')='false'
    and exists(select 1 from public.studio_sessions s where s.id=p_session and not s.archived and
      (s.owner_id=auth.uid() or exists(select 1 from public.studio_collaborators c where c.session_id=s.id and c.user_id=auth.uid() and c.status='accepted' and c.role='editor')))
$$;
revoke all on function starrise_private.studio_account(),starrise_private.studio_is_owner(uuid),starrise_private.studio_can_read(uuid),starrise_private.studio_can_write(uuid) from public,anon;
grant usage on schema starrise_private to authenticated;
grant execute on function starrise_private.studio_account(),starrise_private.studio_is_owner(uuid),starrise_private.studio_can_read(uuid),starrise_private.studio_can_write(uuid) to authenticated;

alter table public.studio_sessions enable row level security;
alter table public.studio_collaborators enable row level security;
alter table public.studio_versions enable row level security;
alter table public.studio_comments enable row level security;
revoke all on public.studio_sessions,public.studio_collaborators,public.studio_versions,public.studio_comments from public,anon,authenticated;
grant select on public.studio_sessions,public.studio_collaborators,public.studio_versions,public.studio_comments to authenticated;
create policy studio_sessions_read on public.studio_sessions for select to authenticated using (
  starrise_private.studio_is_owner(id) or starrise_private.studio_can_read(id) or
  (coalesce((select auth.jwt())->>'is_anonymous','false')='false' and not archived and exists(select 1 from public.studio_collaborators c where c.session_id=id and c.user_id=(select auth.uid()) and c.status='invited'))
);
create policy studio_collaborators_read on public.studio_collaborators for select to authenticated using (
  coalesce((select auth.jwt())->>'is_anonymous','false')='false' and
  (user_id=(select auth.uid()) or starrise_private.studio_is_owner(session_id) or (status='accepted' and starrise_private.studio_can_read(session_id)))
);
create policy studio_versions_read on public.studio_versions for select to authenticated using (
  (state='ready' and starrise_private.studio_can_read(session_id)) or
  (author_id=(select auth.uid()) and starrise_private.studio_can_write(session_id))
);
create policy studio_comments_read on public.studio_comments for select to authenticated using (starrise_private.studio_can_read(session_id));

create or replace function public.studio_create_session(p_name text,p_description text default '') returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_user uuid := starrise_private.studio_account(); v_id uuid;
begin
  insert into public.studio_sessions(owner_id,name,description) values(v_user,btrim(p_name),coalesce(p_description,'')) returning id into v_id;
  return v_id;
end $$;
create or replace function public.studio_invite_member(p_session uuid,p_user uuid,p_role text default 'editor') returns void
language plpgsql security definer set search_path = '' as $$
declare v_user uuid := starrise_private.studio_account();
begin
  if not starrise_private.studio_is_owner(p_session) then raise exception 'Only the session owner can invite members.' using errcode='42501'; end if;
  if p_role not in ('editor','viewer') or p_user=v_user or not exists(select 1 from public."Profiles" p where p.id=p_user and p.display_name is not null) then raise exception 'Choose another registered member and a valid role.'; end if;
  insert into public.studio_collaborators(session_id,user_id,invited_by,role) values(p_session,p_user,v_user,p_role)
  on conflict(session_id,user_id) do update set role=excluded.role,invited_by=excluded.invited_by,
    status=case when public.studio_collaborators.status='accepted' then 'accepted' else 'invited' end,
    responded_at=case when public.studio_collaborators.status='accepted' then public.studio_collaborators.responded_at else null end;
end $$;
create or replace function public.studio_respond_invite(p_session uuid,p_accept boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare v_user uuid := starrise_private.studio_account();
begin
  if not exists(select 1 from public.studio_sessions where id=p_session and not archived) then raise exception 'This session is unavailable.'; end if;
  update public.studio_collaborators set status=case when p_accept then 'accepted' else 'declined' end,responded_at=now() where session_id=p_session and user_id=v_user and status='invited';
  if not found then raise exception 'No pending invitation was found.'; end if;
end $$;
create or replace function public.studio_remove_member(p_session uuid,p_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform starrise_private.studio_account();
  if not starrise_private.studio_is_owner(p_session) then raise exception 'Only the session owner can remove members.' using errcode='42501'; end if;
  update public.studio_collaborators set status='removed',responded_at=now() where session_id=p_session and user_id=p_user;
end $$;
create or replace function public.studio_reserve_version(p_session uuid,p_label text,p_notes text,p_bytes bigint,p_base_version uuid default null)
returns table(version_id uuid,asset_path text)
language plpgsql security definer set search_path = '' as $$
declare v_user uuid := starrise_private.studio_account(); v_id uuid := gen_random_uuid(); v_path text;
begin
  if not starrise_private.studio_can_write(p_session) then raise exception 'Accept an editor invitation before publishing.' using errcode='42501'; end if;
  if p_base_version is not null and not exists(select 1 from public.studio_versions where id=p_base_version and session_id=p_session and state='ready') then raise exception 'The starting version does not belong to this session.'; end if;
  v_path:=p_session::text||'/'||v_id::text||'.json';
  insert into public.studio_versions(id,session_id,author_id,base_version_id,label,notes,asset_path,asset_bytes) values(v_id,p_session,v_user,p_base_version,btrim(p_label),coalesce(p_notes,''),v_path,p_bytes);
  return query select v_id,v_path;
end $$;
create or replace function public.studio_finish_version(p_version uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_user uuid := starrise_private.studio_account(); v_version public.studio_versions%rowtype;
begin
  select * into v_version from public.studio_versions where id=p_version for update;
  if not found or v_version.author_id<>v_user or not starrise_private.studio_can_write(v_version.session_id) then raise exception 'You cannot finish this version.' using errcode='42501'; end if;
  if v_version.state<>'pending' then raise exception 'This version is already finalized.'; end if;
  if not exists(select 1 from storage.objects o where o.bucket_id='studio-sessions' and o.name=v_version.asset_path and (o.metadata->>'size')::bigint=v_version.asset_bytes and o.metadata->>'mimetype'='application/json') then raise exception 'The complete project upload was not found. Retry publishing.'; end if;
  update public.studio_versions set state='ready' where id=p_version;
end $$;
create or replace function public.studio_cancel_version(p_version uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_user uuid := starrise_private.studio_account();
begin
  update public.studio_versions set state='failed' where id=p_version and author_id=v_user and state='pending';
end $$;
create or replace function public.studio_add_comment(p_session uuid,p_body text,p_version uuid default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_user uuid := starrise_private.studio_account(); v_id uuid;
begin
  if not starrise_private.studio_can_read(p_session) then raise exception 'Accept the invitation before commenting.' using errcode='42501'; end if;
  if p_version is not null and not exists(select 1 from public.studio_versions where id=p_version and session_id=p_session and state='ready') then raise exception 'Choose a published version from this session.'; end if;
  insert into public.studio_comments(session_id,version_id,author_id,body) values(p_session,p_version,v_user,btrim(p_body)) returning id into v_id;
  return v_id;
end $$;
revoke all on function public.studio_create_session(text,text),public.studio_invite_member(uuid,uuid,text),public.studio_respond_invite(uuid,boolean),public.studio_remove_member(uuid,uuid),public.studio_reserve_version(uuid,text,text,bigint,uuid),public.studio_finish_version(uuid),public.studio_cancel_version(uuid),public.studio_add_comment(uuid,text,uuid) from public,anon;
grant execute on function public.studio_create_session(text,text),public.studio_invite_member(uuid,uuid,text),public.studio_respond_invite(uuid,boolean),public.studio_remove_member(uuid,uuid),public.studio_reserve_version(uuid,text,text,bigint,uuid),public.studio_finish_version(uuid),public.studio_cancel_version(uuid),public.studio_add_comment(uuid,text,uuid) to authenticated;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values('studio-sessions','studio-sessions',false,52428800,array['application/json']);
create policy studio_snapshot_upload on storage.objects for insert to authenticated with check (
  bucket_id='studio-sessions' and exists(select 1 from public.studio_versions v where v.asset_path=name and v.state='pending' and v.author_id=(select auth.uid()) and starrise_private.studio_can_write(v.session_id))
);
create policy studio_snapshot_download on storage.objects for select to authenticated using (
  bucket_id='studio-sessions' and exists(select 1 from public.studio_versions v where v.asset_path=name and
    ((v.state='ready' and starrise_private.studio_can_read(v.session_id)) or (v.state='pending' and v.author_id=(select auth.uid()) and starrise_private.studio_can_write(v.session_id))))
);
