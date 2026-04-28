begin;

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

drop trigger if exists trg_chapter_yearly_goals_updated_at on public.chapter_yearly_goals;
create trigger trg_chapter_yearly_goals_updated_at
before update on public.chapter_yearly_goals
for each row
execute function public.set_updated_at();

alter table public.chapter_yearly_goals enable row level security;

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

notify pgrst, 'reload schema';

commit;
