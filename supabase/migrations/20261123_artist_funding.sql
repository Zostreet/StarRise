-- StarRise artist funding applications (BeatBread-style advances)
--
-- Artists apply for an advance against future streaming income. StarRise has
-- no funding capital of its own yet, so every number shown in the app is an
-- ESTIMATE and every row here is an APPLICATION, never a funded offer.
-- Funding decisions need a funding partner; this table only collects and
-- tracks applications for admin review.
--
-- Distribution reports are stored in the private `funding-reports` bucket.
-- Only platform admins can read them (via short-lived signed URLs).

create schema if not exists starrise_private;
revoke all on schema starrise_private from public, anon, authenticated;

create table public.artist_funding_applications (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  artist_name text not null,
  email text not null,
  distributor text not null default '',
  streaming_links text not null default '',
  monthly_listeners integer not null default 0,
  trailing_12mo_income numeric(14, 2) not null default 0,
  amount_requested numeric(14, 2) not null,
  use_of_funds text not null default '',
  report_file_path text,
  term_months integer not null default 24,
  income_share_kept integer not null default 70,
  status text not null default 'pending',
  admin_notes text not null default '',
  user_id uuid references auth.users(id) on delete set null,
  constraint artist_funding_applications_artist_name_length
    check (char_length(btrim(artist_name)) between 1 and 200),
  constraint artist_funding_applications_email_format
    check (
      char_length(btrim(email)) between 4 and 320
      and position('@' in btrim(email)) > 1
    ),
  constraint artist_funding_applications_monthly_listeners
    check (monthly_listeners >= 0),
  constraint artist_funding_applications_trailing_income
    check (trailing_12mo_income >= 0),
  constraint artist_funding_applications_amount_requested
    check (amount_requested > 0),
  constraint artist_funding_applications_term_months
    check (term_months in (12, 18, 24, 30, 36)),
  constraint artist_funding_applications_income_share_kept
    check (income_share_kept between 50 and 90),
  constraint artist_funding_applications_status
    check (status in ('pending', 'under_review', 'approved', 'declined')),
  constraint artist_funding_applications_use_of_funds_length
    check (char_length(use_of_funds) <= 2000),
  constraint artist_funding_applications_admin_notes_length
    check (char_length(admin_notes) <= 4000),
  constraint artist_funding_applications_report_path_length
    check (
      report_file_path is null
      or char_length(report_file_path) between 3 and 500
    )
);

create index artist_funding_applications_created_idx
  on public.artist_funding_applications (created_at desc);

create index artist_funding_applications_status_created_idx
  on public.artist_funding_applications (status, created_at desc);

create index artist_funding_applications_user_created_idx
  on public.artist_funding_applications (user_id, created_at desc);

create or replace function starrise_private.touch_artist_funding_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

revoke all on function starrise_private.touch_artist_funding_updated_at()
  from public, anon, authenticated;

create trigger artist_funding_applications_touch_updated_at
before update on public.artist_funding_applications
for each row
execute function starrise_private.touch_artist_funding_updated_at();

alter table public.artist_funding_applications enable row level security;

-- Anyone (signed in or not) can submit an application. New rows must arrive
-- as pending, with no admin notes, and may only claim the submitting user.
create policy "Anyone can submit a funding application"
on public.artist_funding_applications
for insert
to anon, authenticated
with check (
  status = 'pending'
  and admin_notes = ''
  and (
    user_id is null
    or user_id = (select auth.uid())
  )
);

-- Platform admins can read every application.
create policy "Admins can view funding applications"
on public.artist_funding_applications
for select
to authenticated
using (
  exists (
    select 1
    from public.platform_admins a
    where a.user_id = (select auth.uid())
  )
);

-- A signed-in applicant can read their own application (to check its status).
create policy "Applicants can view their own funding application"
on public.artist_funding_applications
for select
to authenticated
using (
  user_id = (select auth.uid())
  and coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
);

-- Only platform admins can change an application (status, admin notes).
create policy "Admins can update funding applications"
on public.artist_funding_applications
for update
to authenticated
using (
  exists (
    select 1
    from public.platform_admins a
    where a.user_id = (select auth.uid())
  )
)
with check (
  exists (
    select 1
    from public.platform_admins a
    where a.user_id = (select auth.uid())
  )
);

-- No delete policy: applications are removed by a platform admin through the
-- Supabase dashboard / service role only, so nothing is lost by accident.

revoke all on public.artist_funding_applications from anon, authenticated;

grant insert on public.artist_funding_applications to anon;
grant select, insert, update on public.artist_funding_applications to authenticated;

-- Private bucket for distribution reports (PDF / CSV / spreadsheets).
-- Reports hold private earnings data, so the bucket is never public.
insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'funding-reports',
  'funding-reports',
  false,
  26214400,
  array[
    'application/pdf',
    'text/csv',
    'text/plain',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ]::text[]
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Anyone submitting an application may upload a report under applications/.
-- Files use random names (applications/<owner>/<uuid>-<name>), so uploads
-- cannot overwrite each other. If spam uploads become a problem, restrict
-- this policy to authenticated users.
create policy "Anyone can upload a funding report"
on storage.objects
for insert
to anon, authenticated
with check (
  bucket_id = 'funding-reports'
  and (storage.foldername(name))[1] = 'applications'
);

-- Only platform admins can read funding reports (via signed URLs).
create policy "Admins can view funding reports"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'funding-reports'
  and exists (
    select 1
    from public.platform_admins a
    where a.user_id = (select auth.uid())
  )
);

-- Only platform admins can delete funding reports.
create policy "Admins can delete funding reports"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'funding-reports'
  and exists (
    select 1
    from public.platform_admins a
    where a.user_id = (select auth.uid())
  )
);

comment on table public.artist_funding_applications is
  'StarRise artist funding applications: estimates and applications only, never funded offers. StarRise holds no funding capital; any advance needs a funding partner.';

comment on column public.artist_funding_applications.report_file_path is
  'Private storage path in the funding-reports bucket, e.g. applications/<owner>/<uuid>-<file>. Admins open it with a short-lived signed URL.';
