begin;

drop view if exists public.chapter_upload_tables;

drop trigger if exists trg_ensure_chapter_upload_table on public.chapters;
drop trigger if exists trg_sync_chapter_upload_to_chapter_table on public.chapter_report_uploads;

drop function if exists public.trg_ensure_chapter_upload_table();
drop function if exists public.trg_sync_chapter_upload_to_chapter_table();
drop function if exists public.sync_chapter_upload_to_chapter_table(bigint);
drop function if exists public.ensure_chapter_upload_table(uuid);
drop function if exists public.chapter_upload_table_name(uuid);

do $$
declare
  table_row record;
begin
  for table_row in
    select tablename
    from pg_tables
    where schemaname = 'public'
      and tablename ~ '^chapter_uploads_[0-9a-f]{32}$'
  loop
    execute format('drop table if exists public.%I', table_row.tablename);
  end loop;
end
$$;

notify pgrst, 'reload schema';

commit;
