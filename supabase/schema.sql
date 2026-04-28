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

create table if not exists public.chapter_upload_pins (
  chapter_slug text primary key,
  chapter_name text not null,
  chapter_pin text not null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint chapter_upload_pins_slug_format check (chapter_slug ~ '^[a-z0-9]+(?:_[a-z0-9]+)*$'),
  constraint chapter_upload_pins_name_not_blank check (length(trim(chapter_name)) > 0),
  constraint chapter_upload_pins_pin_not_blank check (length(trim(chapter_pin)) > 0)
);

create table if not exists public.chapter_yearly_goals (
  chapter_slug text primary key,
  chapter_name text not null,
  visitors numeric not null default 190,
  one_to_ones numeric not null default 4400,
  referrals numeric not null default 1550,
  ceu numeric not null default 2630,
  tyfcb numeric not null default 2500000,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint chapter_yearly_goals_slug_format check (chapter_slug ~ '^[a-z0-9]+(?:_[a-z0-9]+)*$'),
  constraint chapter_yearly_goals_name_not_blank check (length(trim(chapter_name)) > 0),
  constraint chapter_yearly_goals_visitors_nonnegative check (visitors >= 0),
  constraint chapter_yearly_goals_one_to_ones_nonnegative check (one_to_ones >= 0),
  constraint chapter_yearly_goals_referrals_nonnegative check (referrals >= 0),
  constraint chapter_yearly_goals_ceu_nonnegative check (ceu >= 0),
  constraint chapter_yearly_goals_tyfcb_nonnegative check (tyfcb >= 0)
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

create table if not exists public.chapter_report_member_rows (
  id bigint generated always as identity primary key,
  upload_id bigint not null references public.chapter_report_uploads(id) on delete cascade,
  chapter_id uuid not null references public.chapters(id) on delete cascade,
  report_type public.chapter_report_type not null,
  first_name text not null default '',
  last_name text not null default '',
  member_key text not null,
  p numeric,
  a numeric,
  l numeric,
  m numeric,
  s numeric,
  rgi numeric,
  rgo numeric,
  rri numeric,
  rro numeric,
  v numeric,
  one_to_one numeric,
  tyfcb numeric,
  ceu numeric,
  referrals_total numeric not null default 0,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  constraint chapter_report_member_rows_member_key_not_blank check (length(trim(member_key)) > 0),
  constraint chapter_report_member_rows_upload_member_key_unique unique (upload_id, member_key)
);

create index if not exists chapter_report_member_rows_chapter_type_member_idx
  on public.chapter_report_member_rows (chapter_id, report_type, member_key);

create index if not exists chapter_report_member_rows_upload_idx
  on public.chapter_report_member_rows (upload_id);

create table if not exists public.traffic_light_member_rows (
  id bigint generated always as identity primary key,
  traffic_upload_id bigint not null references public.traffic_light_uploads(id) on delete cascade,
  report_month date not null,
  chapter_name text not null,
  chapter_slug text not null,
  first_name text not null default '',
  last_name text not null default '',
  member_key text not null,
  referrals numeric,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  constraint traffic_light_member_rows_chapter_slug_not_blank check (length(trim(chapter_slug)) > 0),
  constraint traffic_light_member_rows_member_key_not_blank check (length(trim(member_key)) > 0),
  constraint traffic_light_member_rows_upload_chapter_member_unique
    unique (traffic_upload_id, chapter_slug, member_key)
);

create index if not exists traffic_light_member_rows_month_chapter_idx
  on public.traffic_light_member_rows (report_month, chapter_slug);

create index if not exists traffic_light_member_rows_upload_idx
  on public.traffic_light_member_rows (traffic_upload_id);

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

drop trigger if exists trg_chapter_upload_pins_updated_at on public.chapter_upload_pins;
create trigger trg_chapter_upload_pins_updated_at
before update on public.chapter_upload_pins
for each row
execute function public.set_updated_at();

drop trigger if exists trg_chapter_yearly_goals_updated_at on public.chapter_yearly_goals;
create trigger trg_chapter_yearly_goals_updated_at
before update on public.chapter_yearly_goals
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

create or replace view public.chapter_report_member_rows_reporting as
select
  mr.id,
  mr.upload_id,
  mr.chapter_id,
  c.name::text as chapter_name,
  c.slug as chapter_slug,
  mr.report_type,
  trim(concat(mr.first_name, ' ', mr.last_name)) as "Full_name",
  mr.first_name as "First Name",
  mr.last_name as "Last Name",
  mr.p as "P",
  mr.a as "A",
  mr.l as "L",
  mr.m as "M",
  mr.s as "S",
  mr.member_key,
  mr.rgi as "RGI",
  false as "FALSE",
  mr.rgo as "RGO",
  mr.rri as "RRI",
  mr.rro as "RRO",
  mr.v as "V",
  mr.one_to_one as "1-2-1",
  mr.one_to_one as "121's",
  mr.tyfcb as "TYFCB",
  mr.ceu as "CEU",
  mr.referrals_total as "Referals Total",
  mr.referrals_total as "Referrals Total",
  mr.created_at
from public.chapter_report_member_rows mr
join public.chapters c
  on c.id = mr.chapter_id;

insert into storage.buckets (id, name, public)
values ('chapter-reports', 'chapter-reports', false)
on conflict (id) do nothing;

alter table public.chapters enable row level security;
alter table public.chapter_upload_pins enable row level security;
alter table public.chapter_yearly_goals enable row level security;
alter table public.chapter_report_uploads enable row level security;
alter table public.chapter_report_current enable row level security;
alter table public.traffic_light_uploads enable row level security;
alter table public.chapter_report_member_rows enable row level security;
alter table public.traffic_light_member_rows enable row level security;

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

drop policy if exists chapter_upload_pins_read_authenticated on public.chapter_upload_pins;
create policy chapter_upload_pins_read_authenticated
on public.chapter_upload_pins
for select
to authenticated
using (true);

drop policy if exists chapter_upload_pins_write_authenticated on public.chapter_upload_pins;
create policy chapter_upload_pins_write_authenticated
on public.chapter_upload_pins
for all
to authenticated
using (true)
with check (true);

drop policy if exists chapter_yearly_goals_read_authenticated on public.chapter_yearly_goals;
create policy chapter_yearly_goals_read_authenticated
on public.chapter_yearly_goals
for select
to authenticated
using (true);

drop policy if exists chapter_yearly_goals_write_authenticated on public.chapter_yearly_goals;
create policy chapter_yearly_goals_write_authenticated
on public.chapter_yearly_goals
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

drop policy if exists chapter_report_member_rows_read_authenticated on public.chapter_report_member_rows;
create policy chapter_report_member_rows_read_authenticated
on public.chapter_report_member_rows
for select
to authenticated
using (true);

drop policy if exists chapter_report_member_rows_insert_authenticated on public.chapter_report_member_rows;
create policy chapter_report_member_rows_insert_authenticated
on public.chapter_report_member_rows
for insert
to authenticated
with check (true);

drop policy if exists chapter_report_member_rows_update_authenticated on public.chapter_report_member_rows;
create policy chapter_report_member_rows_update_authenticated
on public.chapter_report_member_rows
for update
to authenticated
using (true)
with check (true);

drop policy if exists chapter_report_member_rows_delete_authenticated on public.chapter_report_member_rows;
create policy chapter_report_member_rows_delete_authenticated
on public.chapter_report_member_rows
for delete
to authenticated
using (true);

drop policy if exists traffic_light_member_rows_read_authenticated on public.traffic_light_member_rows;
create policy traffic_light_member_rows_read_authenticated
on public.traffic_light_member_rows
for select
to authenticated
using (true);

drop policy if exists traffic_light_member_rows_insert_authenticated on public.traffic_light_member_rows;
create policy traffic_light_member_rows_insert_authenticated
on public.traffic_light_member_rows
for insert
to authenticated
with check (true);

drop policy if exists traffic_light_member_rows_update_authenticated on public.traffic_light_member_rows;
create policy traffic_light_member_rows_update_authenticated
on public.traffic_light_member_rows
for update
to authenticated
using (true)
with check (true);

drop policy if exists traffic_light_member_rows_delete_authenticated on public.traffic_light_member_rows;
create policy traffic_light_member_rows_delete_authenticated
on public.traffic_light_member_rows
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
