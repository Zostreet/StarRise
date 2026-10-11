-- A public recognition board, with private nominations and existing-admin review.
create table public.spotlight_nominations (
  id uuid primary key default gen_random_uuid(),
  nominator_id uuid not null default auth.uid() references auth.users(id),
  creator_name text not null check(char_length(btrim(creator_name)) between 2 and 120),
  category text not null check(category in ('Music','Visual art','Film & video','Writing','Dance & performance','Digital creation','Community impact')),
  work_url text not null check(char_length(work_url)<=2000 and work_url ~ '^https://[A-Za-z0-9][A-Za-z0-9.-]*(:[0-9]{1,5})?(/[^[:space:]]*)?$'),
  city text not null default '' check(char_length(city)<=120),
  reason text not null check(char_length(btrim(reason)) between 20 and 2000),
  status text not null default 'pending' check(status in ('pending','selected','declined')),
  created_at timestamptz not null default now()
);
create index spotlight_nomination_owner on public.spotlight_nominations(nominator_id,created_at desc);
create index spotlight_nomination_queue on public.spotlight_nominations(status,created_at desc);
create table public.creator_spotlights (
  id uuid primary key references public.spotlight_nominations(id),
  creator_name text not null check(char_length(btrim(creator_name)) between 2 and 120),
  category text not null check(category in ('Music','Visual art','Film & video','Writing','Dance & performance','Digital creation','Community impact')),
  work_url text not null check(char_length(work_url)<=2000 and work_url ~ '^https://[A-Za-z0-9][A-Za-z0-9.-]*(:[0-9]{1,5})?(/[^[:space:]]*)?$'),
  city text not null default '' check(char_length(city)<=120),
  summary text not null check(char_length(btrim(summary)) between 20 and 2000),
  status text not null default 'published' check(status in ('published','hidden')),
  published_at timestamptz not null default now()
);
create index creator_spotlight_public on public.creator_spotlights(status,published_at desc);
alter table public.spotlight_nominations enable row level security;
alter table public.creator_spotlights enable row level security;
revoke all on public.spotlight_nominations,public.creator_spotlights from anon,authenticated;
grant select on public.creator_spotlights to anon,authenticated;
grant select on public.spotlight_nominations to authenticated;
grant insert(creator_name,category,work_url,city,reason) on public.spotlight_nominations to authenticated;

create function starrise_private.spotlight_admin() returns boolean
language sql stable security definer set search_path='' as $$
  select auth.uid() is not null
    and exists(select 1 from auth.users u where u.id=auth.uid() and coalesce(u.is_anonymous,false)=false)
    and exists(select 1 from public.platform_admins a where a.user_id=auth.uid());
$$;
revoke all on function starrise_private.spotlight_admin() from public,anon;
grant usage on schema starrise_private to authenticated;
grant execute on function starrise_private.spotlight_admin() to authenticated;
create policy "Published creators are publicly visible" on public.creator_spotlights for select to anon,authenticated using(status='published');
create policy "Existing admins review hidden spotlights" on public.creator_spotlights for select to authenticated using((select starrise_private.spotlight_admin()));
create policy "Members see their nominations and admins see the queue" on public.spotlight_nominations for select to authenticated
using((nominator_id=(select auth.uid()) and coalesce(((select auth.jwt())->>'is_anonymous')::boolean,false)=false) or (select starrise_private.spotlight_admin()));
create policy "Registered members submit pending nominations" on public.spotlight_nominations for insert to authenticated
with check(nominator_id=(select auth.uid()) and status='pending' and coalesce(((select auth.jwt())->>'is_anonymous')::boolean,false)=false);

create function starrise_private.check_spotlight_submission() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if auth.uid() is null or new.nominator_id<>auth.uid() or not exists(select 1 from auth.users u where u.id=auth.uid() and coalesce(u.is_anonymous,false)=false) then
    raise exception 'Sign in with a registered account to nominate a creator.' using errcode='42501';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(auth.uid()::text,98321));
  if (select count(*) from public.spotlight_nominations n where n.nominator_id=auth.uid() and n.created_at>now()-interval '24 hours')>=5 then
    raise exception 'You can submit five nominations in 24 hours. Check back tomorrow.' using errcode='23514';
  end if;
  return new;
end $$;
revoke all on function starrise_private.check_spotlight_submission() from public,anon,authenticated;
create trigger check_spotlight_submission before insert on public.spotlight_nominations for each row execute function starrise_private.check_spotlight_submission();

create function public.review_creator_spotlight(p_id uuid,p_action text,p_summary text default '') returns void
language plpgsql security definer set search_path='' as $$
declare n public.spotlight_nominations;
begin
  if not starrise_private.spotlight_admin() then raise exception 'Administrator access is required.' using errcode='42501'; end if;
  select * into n from public.spotlight_nominations where id=p_id for update;
  if n.id is null then raise exception 'Nomination not found.' using errcode='22023'; end if;
  if p_action='publish' then
    if char_length(btrim(p_summary)) not between 20 and 2000 then raise exception 'Write a public spotlight of 20 to 2000 characters.' using errcode='23514'; end if;
    insert into public.creator_spotlights(id,creator_name,category,work_url,city,summary)
    values(n.id,n.creator_name,n.category,n.work_url,n.city,btrim(p_summary))
    on conflict(id) do update set summary=excluded.summary,status='published',published_at=now();
    update public.spotlight_nominations set status='selected' where id=n.id;
  elsif p_action='decline' then
    if exists(select 1 from public.creator_spotlights where id=n.id and status='published') then raise exception 'Hide the published spotlight before declining it.' using errcode='23514'; end if;
    update public.spotlight_nominations set status='declined' where id=n.id;
  elsif p_action='hide' then
    update public.creator_spotlights set status='hidden' where id=n.id;
  else raise exception 'Choose publish, decline, or hide.' using errcode='22023'; end if;
end $$;
revoke all on function public.review_creator_spotlight(uuid,text,text) from public,anon;
grant execute on function public.review_creator_spotlight(uuid,text,text) to authenticated;
