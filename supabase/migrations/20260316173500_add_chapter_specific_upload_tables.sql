begin;

create or replace function public.chapter_upload_table_name(p_chapter_id uuid)
returns text
language sql
immutable
as $$
select 'chapter_uploads_' || replace(p_chapter_id::text, '-', '');
$$;

create or replace function public.ensure_chapter_upload_table(p_chapter_id uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  table_name text;
  qualified_table_name text;
  report_type_uploaded_at_idx text;
begin
  if p_chapter_id is null then
    raise exception 'p_chapter_id is required';
  end if;

  table_name := public.chapter_upload_table_name(p_chapter_id);
  qualified_table_name := format('public.%I', table_name);

  if to_regclass(qualified_table_name) is not null then
    return table_name;
  end if;

  report_type_uploaded_at_idx := format(
    'idx_%s_rt_uploaded_at',
    substr(md5(table_name), 1, 18)
  );

  execute format(
    $sql$
      create table if not exists public.%I (
        id bigint primary key references public.chapter_report_uploads(id) on delete cascade,
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
        check (chapter_id = %L::uuid),
        check (length(trim(storage_path)) > 0)
      )
    $sql$,
    table_name,
    p_chapter_id::text
  );

  execute format(
    'create index if not exists %I on public.%I (report_type, uploaded_at desc)',
    report_type_uploaded_at_idx,
    table_name
  );

  execute format('alter table public.%I enable row level security', table_name);

  execute format(
    'drop policy if exists chapter_uploads_read_authenticated on public.%I',
    table_name
  );
  execute format(
    $sql$
      create policy chapter_uploads_read_authenticated
      on public.%I
      for select
      to authenticated
      using (true)
    $sql$,
    table_name
  );

  execute format(
    'drop policy if exists chapter_uploads_write_authenticated on public.%I',
    table_name
  );
  execute format(
    $sql$
      create policy chapter_uploads_write_authenticated
      on public.%I
      for all
      to authenticated
      using (true)
      with check (true)
    $sql$,
    table_name
  );

  return table_name;
end;
$$;

create or replace function public.sync_chapter_upload_to_chapter_table(p_upload_id bigint)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  upload_row public.chapter_report_uploads%rowtype;
  table_name text;
begin
  select *
  into upload_row
  from public.chapter_report_uploads
  where id = p_upload_id;

  if not found then
    return null;
  end if;

  table_name := public.ensure_chapter_upload_table(upload_row.chapter_id);

  execute format(
    $sql$
      insert into public.%I (
        id,
        chapter_id,
        report_type,
        original_filename,
        storage_bucket,
        storage_path,
        file_size_bytes,
        mime_type,
        uploaded_by,
        validation,
        uploaded_at
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      on conflict (id)
      do update set
        chapter_id = excluded.chapter_id,
        report_type = excluded.report_type,
        original_filename = excluded.original_filename,
        storage_bucket = excluded.storage_bucket,
        storage_path = excluded.storage_path,
        file_size_bytes = excluded.file_size_bytes,
        mime_type = excluded.mime_type,
        uploaded_by = excluded.uploaded_by,
        validation = excluded.validation,
        uploaded_at = excluded.uploaded_at
    $sql$,
    table_name
  )
  using
    upload_row.id,
    upload_row.chapter_id,
    upload_row.report_type,
    upload_row.original_filename,
    upload_row.storage_bucket,
    upload_row.storage_path,
    upload_row.file_size_bytes,
    upload_row.mime_type,
    upload_row.uploaded_by,
    upload_row.validation,
    upload_row.uploaded_at;

  return table_name;
end;
$$;

create or replace function public.trg_ensure_chapter_upload_table()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.ensure_chapter_upload_table(new.id);
  return new;
end;
$$;

drop trigger if exists trg_ensure_chapter_upload_table on public.chapters;
create trigger trg_ensure_chapter_upload_table
after insert on public.chapters
for each row
execute function public.trg_ensure_chapter_upload_table();

create or replace function public.trg_sync_chapter_upload_to_chapter_table()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.sync_chapter_upload_to_chapter_table(new.id);
  return new;
end;
$$;

drop trigger if exists trg_sync_chapter_upload_to_chapter_table on public.chapter_report_uploads;
create trigger trg_sync_chapter_upload_to_chapter_table
after insert or update on public.chapter_report_uploads
for each row
execute function public.trg_sync_chapter_upload_to_chapter_table();

do $$
declare
  chapter_row record;
begin
  for chapter_row in
    select c.id
    from public.chapters c
  loop
    perform public.ensure_chapter_upload_table(chapter_row.id);
  end loop;
end
$$;

do $$
declare
  upload_row record;
begin
  for upload_row in
    select u.id
    from public.chapter_report_uploads u
    order by u.id
  loop
    perform public.sync_chapter_upload_to_chapter_table(upload_row.id);
  end loop;
end
$$;

create or replace view public.chapter_upload_tables as
select
  c.id as chapter_id,
  c.name::text as chapter_name,
  c.slug as chapter_slug,
  public.chapter_upload_table_name(c.id) as upload_table_name
from public.chapters c;

commit;
