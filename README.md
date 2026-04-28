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

Analytics page:
- `http://127.0.0.1:8000/analytics`

Login page:
- `http://127.0.0.1:8000/login`

Chapter PIN settings page:
- `http://127.0.0.1:8000/pin-settings`

## Deploy (Netlify + Render)
Frontend:
- Netlify serves static pages from this repo using `netlify.toml`.
- API requests are proxied to `https://bni-palms-api.onrender.com/api/*`.

Backend:
- Deploy this repo to Render as a Blueprint (`render.yaml` included).
- Render service name must be `bni-palms-api` so the Netlify proxy target matches.
- In Render, set required env vars when prompted:
  - `SUPABASE_URL`
  - `SUPABASE_SERVICE_KEY`

## Access login (PIN)
The app now requires login access for:
- Upload page: `/`
- Analytics page: `/analytics`
- API endpoints used by those pages (`/api/chapters`, `/api/analytics`, `/api/upload`, `/api/process`)

Configure one or more access PIN values with env vars:

```bash
set APP_AUTH_PASSWORDS=1234,my-shared-pin
```

Optional alternatives:
- `APP_AUTH_PASSWORD` (single PIN, legacy env name)
- `APP_AUTH_PIN` (single PIN)

Session/auth options:

```bash
set APP_AUTH_SESSION_SECRET=change-this-secret
set APP_AUTH_SESSION_SECONDS=43200
set APP_AUTH_COOKIE_SECURE=0
```

If no auth PIN env var is set, a local default PIN is used:
- `giversgain`

## Chapter upload PINs
- Uploads now require a chapter PIN after clicking `Load Selected Report To Analytics`.
- Default PIN for all chapters is `12345` unless overridden.
- Traffic Lights uploads use a separate global PIN (default `innovation`).
- Change a chapter PIN in the app at `/pin-settings` by entering:
  - chapter
  - current PIN
  - new PIN
  - confirm new PIN
- Changed chapter PINs are saved in Supabase table `public.chapter_upload_pins`.

Default credentials:
- Site login password: `giversgain`
- Traffic Lights upload PIN: `innovation`
- Chapter upload PIN (all chapters unless changed): `12345`

Optional env configuration:

```bash
set APP_DEFAULT_CHAPTER_UPLOAD_PIN=12345
set APP_TRAFFIC_UPLOAD_PIN=innovation
set APP_CHAPTER_UPLOAD_PINS={\"st_charles\":\"67890\"}
set APP_CHAPTER_PIN_MIN_LENGTH=4
```

Note:
- `APP_CHAPTER_UPLOAD_PINS` is an optional fallback map.
- Supabase `public.chapter_upload_pins` takes priority when a chapter override exists there.
- For the global Traffic Lights PIN, add/update row `chapter_slug='traffic_lights_global'` in `public.chapter_upload_pins` (or use `APP_TRAFFIC_UPLOAD_PIN` env var).
- Re-run `supabase/schema.sql` after pulling this change so `public.chapter_upload_pins` exists.

## Chapter yearly goals
- The same `/pin-settings` page now lets you update chapter-specific yearly goals:
  - Visitors
  - One to Ones
  - Referrals
  - CEU
  - TYFCB (closed business)
- Saving yearly goals requires the selected chapter's current PIN.
- Goals are saved in Supabase table `public.chapter_yearly_goals`.
- Analytics (`/api/analytics`) reads these chapter-specific yearly goals; if a chapter has no row yet, defaults are used.

## Supabase runtime config
To persist uploads to Supabase (storage + tables), set:

```bash
set SUPABASE_URL=https://<project-ref>.supabase.co
set SUPABASE_SERVICE_KEY=<sb_secret_or_service_role_key>
set SUPABASE_STORAGE_BUCKET=chapter-reports
```

If these vars are not set, uploads and analytics endpoints return `503` until Supabase is configured.

## Upload behavior
- Local copy: files are always written under `uploads/<chapter>/<report_type>/` with a timestamped filename.
- Source of truth: uploads are persisted to Supabase and analytics is read from Supabase.
- Weekly/YTD:
  - parser ignores rows 1-8 and reads headers from row 9
  - parser adds per-member `Referrals Total` = `RGI + RGO`
  - accepts `.xls` and `.xlsx` uploads
  - uploads current file to `chapters/{chapter_slug}/{weekly|ytd}.{xls|xlsx}` (matching uploaded extension)
  - uploads archive copy to `chapters/{chapter_slug}/archive/{report_type}/{timestamp}_{filename}`
  - when a new weekly/ytd upload is loaded for a chapter, older uploads for that same chapter/report type are deleted from Supabase tables and old storage objects are removed
  - upserts chapter in `public.chapters`
  - inserts upload history row in `public.chapter_report_uploads` (trigger keeps `public.chapter_report_current` in sync)
  - inserts parsed member rows in `public.chapter_report_member_rows` including `RGI`, `RGO`, `RRI`, `RRO`, `V`, `1-2-1`, `TYFCB`, `CEU`, and `referrals_total`
- Traffic Lights:
  - uploads current file to `traffic_lights/{yyyy-mm}/traffic.pdf`
  - uploads archive copy to `traffic_lights/archive/{yyyy-mm}/{timestamp}_{filename}`
  - upserts month row in `public.traffic_light_uploads`
  - extracts chapter, member name, and score from each row
  - replaces parsed member rows for that month in `public.traffic_light_member_rows`

## Chapters list
`/api/chapters` is read from Supabase `public.chapters` only.

To add/update chapters, edit records in Supabase `public.chapters`
(`name`, `slug`, `is_active`) rather than local files.

## Supabase schema
Run `supabase/schema.sql` in your Supabase SQL Editor.

What it creates:
- `public.chapters` (master chapter records)
- `public.chapter_upload_pins` (chapter PIN overrides used by uploads + pin settings page)
- `public.chapter_yearly_goals` (chapter-specific yearly goal targets used by analytics + pin settings page)
- `public.chapter_report_uploads` (chapter-level weekly/ytd upload history + validation JSON)
- `public.chapter_report_current` (exactly one current weekly/ytd file per chapter)
- `public.chapter_report_member_rows` (parsed weekly/ytd per-member rows, including `referrals_total`)
- `public.traffic_light_uploads` (global monthly traffic-light uploads for all chapters)
- `public.traffic_light_member_rows` (parsed traffic-light per-member rows for all chapters)
- `public.chapter_report_status` view (chapter weekly/ytd status + latest traffic month snapshot)
- `public.chapter_report_member_rows_reporting` view (end-file shape columns including `"Full_name"`, `"P"`, `"A"`, `"L"`, `"M"`, `"S"`, `"FALSE"`, `"121's"`, `"TYFCB"`, `"CEU"`, `"Referals Total"`)
- private storage bucket: `chapter-reports`

## Analytics API
- `GET /api/analytics?chapter=<chapter-name>`
- Returns weekly summary cards, YTD metric/goal data, traffic-light distribution, and 100 percent club member names for the selected chapter.
- Supabase is required; endpoint returns `503` until Supabase env vars are configured.

Recommended object paths:
- `chapters/{chapter_slug}/weekly.{xls|xlsx}`
- `chapters/{chapter_slug}/ytd.{xls|xlsx}`
- `traffic_lights/{yyyy-mm}/traffic.pdf`

Optional archive paths:
- `chapters/{chapter_slug}/archive/{report_type}/{yyyymmdd_hhmmss}_{original_filename}`
- `traffic_lights/archive/{yyyy-mm}/{yyyymmdd_hhmmss}_{original_filename}`

## Upload table queries
Use these in Supabase SQL Editor to inspect weekly/ytd uploads by chapter and report type.

```sql
select
  c.name as chapter_name,
  u.report_type,
  count(*) as upload_count
from public.chapter_report_uploads u
join public.chapters c on c.id = u.chapter_id
group by c.name, u.report_type
order by c.name, u.report_type;
```
