begin;

create table if not exists public.chapter_report_member_rows (
  id bigint generated always as identity primary key,
  upload_id bigint not null references public.chapter_report_uploads(id) on delete cascade,
  chapter_id uuid not null references public.chapters(id) on delete cascade,
  report_type public.chapter_report_type not null,
  first_name text not null default '',
  last_name text not null default '',
  member_key text not null,
  rgi numeric,
  rgo numeric,
  rri numeric,
  rro numeric,
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

alter table public.chapter_report_member_rows enable row level security;
alter table public.traffic_light_member_rows enable row level security;

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

commit;
