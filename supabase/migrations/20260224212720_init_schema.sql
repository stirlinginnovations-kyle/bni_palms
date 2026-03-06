-- BNI PALMS Supabase schema
-- Run in Supabase SQL Editor.
--
-- Design:
-- 1) Weekly + YTD are chapter-specific uploads.
-- 2) Traffic Lights is a single monthly upload that contains all chapters.
-- 3) Keep upload history + current pointers + validation snapshots.
-- 4) Store files in a private storage bucket.

begin;

create extension if not exists pgcrypto;
create extension if not exists citext;

do $$
begin
  if not exists (
    select 1
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typname = 'chapter_report_type'
  ) then
    create type public.chapter_report_type as enum ('weekly', 'ytd');
  end if;
end $$;

create table if not exists public.chapters (
  id uuid primary key default gen_random_uuid(),
  name citext not null unique,
  slug text not null unique,
  is_active boolean not null default true,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint chapters_slug_format check (slug ~ '^[a-z0-9]+(?:_[a-z0-9]+)*$')
);

create table if not exists public.chapter_report_uploads (
  id bigint generated always as identity primary key,
  chapter_id uuid not null references public.chapters(id) on delete cascade,
  report_type public.chapter_report_type not null,
  original_filename text not null,
  storage_bucket text not null default 'chapter-reports',
  storage_path text not null unique,
  file_size_bytes bigint,
  mime_type text,
  uploaded_by text,
  validation jsonb not null default '{}'::jsonb,
  uploaded_at timestamptz not null default timezone('utc', now()),
  constraint chapter_report_uploads_storage_path_not_blank check (length(trim(storage_path)) > 0)
);

create index if not exists chapter_report_uploads_chapter_type_uploaded_at_idx
  on public.chapter_report_uploads (chapter_id, report_type, uploaded_at desc);

create table if not exists public.chapter_report_current (
  chapter_id uuid not null references public.chapters(id) on delete cascade,
  report_type public.chapter_report_type not null,
  upload_id bigint not null references public.chapter_report_uploads(id) on delete cascade,
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (chapter_id, report_type)
);

create table if not exists public.traffic_light_uploads (
  id bigint generated always as identity primary key,
  report_month date not null,
  original_filename text not null,
  storage_bucket text not null default 'chapter-reports',
  storage_path text not null unique,
  file_size_bytes bigint,
  mime_type text,
  uploaded_by text,
  validation jsonb not null default '{}'::jsonb,
  uploaded_at timestamptz not null default timezone('utc', now()),
  constraint traffic_light_report_month_first_day
    check (date_trunc('month', report_month::timestamp)::date = report_month),
  constraint traffic_light_storage_path_not_blank check (length(trim(storage_path)) > 0)
);

create unique index if not exists traffic_light_uploads_report_month_uidx
  on public.traffic_light_uploads (report_month);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := timezone('utc', now());
  return new;
end;
$$;

drop trigger if exists trg_chapters_updated_at on public.chapters;
create trigger trg_chapters_updated_at
before update on public.chapters
for each row
execute function public.set_updated_at();

drop trigger if exists trg_chapter_report_current_updated_at on public.chapter_report_current;
create trigger trg_chapter_report_current_updated_at
before update on public.chapter_report_current
for each row
execute function public.set_updated_at();

drop trigger if exists trg_sync_current_report_from_upload on public.chapter_report_uploads;
drop function if exists public.sync_current_report_from_upload();

create or replace function public.sync_current_chapter_report_from_upload()
returns trigger
language plpgsql
as $$
begin
  insert into public.chapter_report_current (
    chapter_id,
    report_type,
    upload_id,
    updated_at
  )
  values (
    new.chapter_id,
    new.report_type,
    new.id,
    timezone('utc', now())
  )
  on conflict (chapter_id, report_type)
  do update set
    upload_id = excluded.upload_id,
    updated_at = excluded.updated_at;

  return new;
end;
$$;

drop trigger if exists trg_sync_current_chapter_report_from_upload on public.chapter_report_uploads;
create trigger trg_sync_current_chapter_report_from_upload
after insert on public.chapter_report_uploads
for each row
execute function public.sync_current_chapter_report_from_upload();

create or replace view public.chapter_report_status as
with latest_traffic as (
  select
    t.report_month,
    t.storage_path,
    t.uploaded_at
  from public.traffic_light_uploads t
  order by t.report_month desc, t.uploaded_at desc
  limit 1
)
select
  c.id as chapter_id,
  c.name::text as chapter_name,
  c.slug as chapter_slug,
  wu.storage_path as weekly_storage_path,
  wu.uploaded_at as weekly_uploaded_at,
  yu.storage_path as ytd_storage_path,
  yu.uploaded_at as ytd_uploaded_at,
  lt.storage_path as traffic_storage_path,
  lt.uploaded_at as traffic_uploaded_at,
  lt.report_month as traffic_report_month,
  (wu.id is not null) as has_weekly,
  (yu.id is not null) as has_ytd,
  (lt.storage_path is not null) as has_latest_traffic
from public.chapters c
left join public.chapter_report_current wc
  on wc.chapter_id = c.id and wc.report_type = 'weekly'
left join public.chapter_report_uploads wu
  on wu.id = wc.upload_id
left join public.chapter_report_current yc
  on yc.chapter_id = c.id and yc.report_type = 'ytd'
left join public.chapter_report_uploads yu
  on yu.id = yc.upload_id
left join latest_traffic lt
  on true;

insert into storage.buckets (id, name, public)
values ('chapter-reports', 'chapter-reports', false)
on conflict (id) do nothing;

alter table public.chapters enable row level security;
alter table public.chapter_report_uploads enable row level security;
alter table public.chapter_report_current enable row level security;
alter table public.traffic_light_uploads enable row level security;

drop policy if exists chapters_read on public.chapters;
create policy chapters_read
on public.chapters
for select
to anon, authenticated
using (true);

drop policy if exists chapters_write_authenticated on public.chapters;
create policy chapters_write_authenticated
on public.chapters
for all
to authenticated
using (true)
with check (true);

drop policy if exists chapter_report_uploads_read_authenticated on public.chapter_report_uploads;
create policy chapter_report_uploads_read_authenticated
on public.chapter_report_uploads
for select
to authenticated
using (true);

drop policy if exists chapter_report_uploads_write_authenticated on public.chapter_report_uploads;
drop policy if exists chapter_report_uploads_insert_authenticated on public.chapter_report_uploads;
create policy chapter_report_uploads_insert_authenticated
on public.chapter_report_uploads
for insert
to authenticated
with check (true);

drop policy if exists chapter_report_uploads_update_authenticated on public.chapter_report_uploads;
create policy chapter_report_uploads_update_authenticated
on public.chapter_report_uploads
for update
to authenticated
using (true)
with check (true);

drop policy if exists chapter_report_current_read_authenticated on public.chapter_report_current;
create policy chapter_report_current_read_authenticated
on public.chapter_report_current
for select
to authenticated
using (true);

drop policy if exists chapter_report_current_write_authenticated on public.chapter_report_current;
create policy chapter_report_current_write_authenticated
on public.chapter_report_current
for all
to authenticated
using (true)
with check (true);

drop policy if exists traffic_light_uploads_read_authenticated on public.traffic_light_uploads;
create policy traffic_light_uploads_read_authenticated
on public.traffic_light_uploads
for select
to authenticated
using (true);

drop policy if exists traffic_light_uploads_insert_authenticated on public.traffic_light_uploads;
create policy traffic_light_uploads_insert_authenticated
on public.traffic_light_uploads
for insert
to authenticated
with check (true);

drop policy if exists traffic_light_uploads_update_authenticated on public.traffic_light_uploads;
create policy traffic_light_uploads_update_authenticated
on public.traffic_light_uploads
for update
to authenticated
using (true)
with check (true);

drop policy if exists traffic_light_uploads_delete_authenticated on public.traffic_light_uploads;
create policy traffic_light_uploads_delete_authenticated
on public.traffic_light_uploads
for delete
to authenticated
using (true);

do $storage$
begin
  begin
    execute 'drop policy if exists chapter_reports_read_authenticated on storage.objects';
    execute $sql$
      create policy chapter_reports_read_authenticated
      on storage.objects
      for select
      to authenticated
      using (bucket_id = 'chapter-reports')
    $sql$;

    execute 'drop policy if exists chapter_reports_insert_authenticated on storage.objects';
    execute $sql$
      create policy chapter_reports_insert_authenticated
      on storage.objects
      for insert
      to authenticated
      with check (
        bucket_id = 'chapter-reports'
        and (storage.foldername(name))[1] in ('chapters', 'traffic_lights')
      )
    $sql$;

    execute 'drop policy if exists chapter_reports_update_authenticated on storage.objects';
    execute $sql$
      create policy chapter_reports_update_authenticated
      on storage.objects
      for update
      to authenticated
      using (bucket_id = 'chapter-reports')
      with check (bucket_id = 'chapter-reports')
    $sql$;

    execute 'drop policy if exists chapter_reports_delete_authenticated on storage.objects';
    execute $sql$
      create policy chapter_reports_delete_authenticated
      on storage.objects
      for delete
      to authenticated
      using (bucket_id = 'chapter-reports')
    $sql$;
  exception
    when insufficient_privilege then
      raise notice 'Skipping storage.objects policy changes due to insufficient privileges.';
  end;
end
$storage$;

commit;

-- Recommended storage object key format:
--
-- Chapter-scoped current files:
-- chapters/{chapter_slug}/weekly.xls
-- chapters/{chapter_slug}/ytd.xls
--
-- Global monthly traffic file:
-- traffic_lights/{yyyy-mm}/traffic.pdf
--
-- Optional archive format:
-- chapters/{chapter_slug}/archive/{report_type}/{yyyymmdd_hhmmss}_{original_filename}
-- traffic_lights/archive/{yyyy-mm}/{yyyymmdd_hhmmss}_{original_filename}
