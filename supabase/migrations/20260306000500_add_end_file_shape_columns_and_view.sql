begin;

alter table if exists public.chapter_report_member_rows
  add column if not exists p numeric,
  add column if not exists a numeric,
  add column if not exists l numeric,
  add column if not exists m numeric,
  add column if not exists s numeric;

update public.chapter_report_member_rows mr
set
  p = coalesce(
    mr.p,
    case when coalesce(mr.raw ->> 'P', '') ~ '^-?\d+(\.\d+)?$' then (mr.raw ->> 'P')::numeric end
  ),
  a = coalesce(
    mr.a,
    case when coalesce(mr.raw ->> 'A', '') ~ '^-?\d+(\.\d+)?$' then (mr.raw ->> 'A')::numeric end
  ),
  l = coalesce(
    mr.l,
    case when coalesce(mr.raw ->> 'L', '') ~ '^-?\d+(\.\d+)?$' then (mr.raw ->> 'L')::numeric end
  ),
  m = coalesce(
    mr.m,
    case when coalesce(mr.raw ->> 'M', '') ~ '^-?\d+(\.\d+)?$' then (mr.raw ->> 'M')::numeric end
  ),
  s = coalesce(
    mr.s,
    case when coalesce(mr.raw ->> 'S', '') ~ '^-?\d+(\.\d+)?$' then (mr.raw ->> 'S')::numeric end
  ),
  v = coalesce(
    mr.v,
    case when coalesce(mr.raw ->> 'V', '') ~ '^-?\d+(\.\d+)?$' then (mr.raw ->> 'V')::numeric end
  ),
  one_to_one = coalesce(
    mr.one_to_one,
    case when coalesce(mr.raw ->> '1-2-1', '') ~ '^-?\d+(\.\d+)?$' then (mr.raw ->> '1-2-1')::numeric end
  ),
  tyfcb = coalesce(
    mr.tyfcb,
    case when coalesce(mr.raw ->> 'TYFCB', '') ~ '^-?\d+(\.\d+)?$' then (mr.raw ->> 'TYFCB')::numeric end
  ),
  ceu = coalesce(
    mr.ceu,
    case when coalesce(mr.raw ->> 'CEU', '') ~ '^-?\d+(\.\d+)?$' then (mr.raw ->> 'CEU')::numeric end
  )
where
  mr.p is null
  or mr.a is null
  or mr.l is null
  or mr.m is null
  or mr.s is null
  or mr.v is null
  or mr.one_to_one is null
  or mr.tyfcb is null
  or mr.ceu is null;

drop view if exists public.chapter_report_member_rows_reporting;

create view public.chapter_report_member_rows_reporting as
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

commit;
