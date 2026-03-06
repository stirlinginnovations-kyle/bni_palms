begin;

create or replace view public.chapter_report_member_rows_reporting as
select
  mr.id,
  mr.upload_id,
  mr.chapter_id,
  c.name::text as chapter_name,
  c.slug as chapter_slug,
  mr.report_type,
  mr.first_name as "First Name",
  mr.last_name as "Last Name",
  mr.member_key,
  mr.rgi as "RGI",
  mr.rgo as "RGO",
  mr.rri as "RRI",
  mr.rro as "RRO",
  mr.v as "V",
  mr.one_to_one as "1-2-1",
  mr.tyfcb as "TYFCB",
  mr.ceu as "CEU",
  mr.referrals_total as "Referrals Total",
  mr.created_at
from public.chapter_report_member_rows mr
join public.chapters c
  on c.id = mr.chapter_id;

commit;
