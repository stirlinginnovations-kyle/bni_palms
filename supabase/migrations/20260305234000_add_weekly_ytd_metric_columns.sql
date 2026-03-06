begin;

alter table if exists public.chapter_report_member_rows
  add column if not exists v numeric,
  add column if not exists one_to_one numeric,
  add column if not exists tyfcb numeric,
  add column if not exists ceu numeric;

commit;
