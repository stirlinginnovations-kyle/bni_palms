# bni_palms
BNI PALMS reporting tool.

## Run locally
1. Install Python 3.10+.
2. Install dependencies:

```bash
python -m pip install -r requirements.txt
```

3. Start the server:

```bash
python -m uvicorn app.main:app --reload
```

Then open `http://127.0.0.1:8000`.

## Supabase runtime config
To persist uploads to Supabase (storage + tables), set:

```bash
set SUPABASE_URL=https://<project-ref>.supabase.co
set SUPABASE_SERVICE_KEY=<sb_secret_or_service_role_key>
set SUPABASE_STORAGE_BUCKET=chapter-reports
```

If these vars are not set, the app falls back to local-only storage.

## Upload behavior
- Local copy: files are always written under `uploads/<chapter>/<report_type>/` with a timestamped filename.
- Weekly/YTD:
  - parser ignores rows 1-8 and reads headers from row 9
  - parser adds per-member `Referrals Total` = `RGI + RGO + RRI + RRO`
  - uploads current file to `chapters/{chapter_slug}/{weekly|ytd}.xls`
  - uploads archive copy to `chapters/{chapter_slug}/archive/{report_type}/{timestamp}_{filename}`
  - upserts chapter in `public.chapters`
  - inserts upload history row in `public.chapter_report_uploads` (trigger keeps `public.chapter_report_current` in sync)
  - inserts parsed member rows in `public.chapter_report_member_rows` including `RGI`, `RGO`, `RRI`, `RRO`, `V`, `1-2-1`, `TYFCB`, `CEU`, and `referrals_total`
- Traffic Lights:
  - uploads current file to `traffic_lights/{yyyy-mm}/traffic.pdf`
  - uploads archive copy to `traffic_lights/archive/{yyyy-mm}/{timestamp}_{filename}`
  - upserts month row in `public.traffic_light_uploads`
  - replaces parsed member rows for that month in `public.traffic_light_member_rows`

## Chapters list
Update the chapter dropdown by editing `chapters.json`:

```json
{
  "chapters": ["St. Charles", "Abundant Connections"]
}
```

When Supabase is configured, `/api/chapters` reads active chapters from `public.chapters`.  
If the table is empty, it seeds from `chapters.json` automatically.

## Supabase schema
Run `supabase/schema.sql` in your Supabase SQL Editor.

What it creates:
- `public.chapters` (master chapter records)
- `public.chapter_report_uploads` (chapter-level weekly/ytd upload history + validation JSON)
- `public.chapter_report_current` (exactly one current weekly/ytd file per chapter)
- `public.chapter_report_member_rows` (parsed weekly/ytd per-member rows, including `referrals_total`)
- `public.traffic_light_uploads` (global monthly traffic-light uploads for all chapters)
- `public.traffic_light_member_rows` (parsed traffic-light per-member rows for all chapters)
- `public.chapter_report_status` view (chapter weekly/ytd status + latest traffic month snapshot)
- `public.chapter_report_member_rows_reporting` view (end-file shape columns including `"Full_name"`, `"P"`, `"A"`, `"L"`, `"M"`, `"S"`, `"FALSE"`, `"121's"`, `"TYFCB"`, `"CEU"`, `"Referals Total"`)
- private storage bucket: `chapter-reports`

Recommended object paths:
- `chapters/{chapter_slug}/weekly.xls`
- `chapters/{chapter_slug}/ytd.xls`
- `traffic_lights/{yyyy-mm}/traffic.pdf`

Optional archive paths:
- `chapters/{chapter_slug}/archive/{report_type}/{yyyymmdd_hhmmss}_{original_filename}`
- `traffic_lights/archive/{yyyy-mm}/{yyyymmdd_hhmmss}_{original_filename}`
