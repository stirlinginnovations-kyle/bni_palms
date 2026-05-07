# BNI PALMS Onboarding Guide (New Users)

This guide is for chapter users who upload reports and review analytics.

## 1. What This Tool Does
- Uploads your chapter reports to Supabase.
- Updates the analytics dashboard with the latest uploaded data.
- Lets authorized users change chapter upload PINs and yearly goals.

## 2. Pages You Will Use
- `Upload Center`: `/`
- `Analytics Dashboard`: `/analytics`
- `PIN and Goals Settings`: `/pin-settings`

## 3. Credentials You Need
- Site access password (to enter the app).
- Chapter upload PIN (for Weekly and YTD uploads).
- Traffic Lights upload PIN (global PIN for Traffic Lights PDF uploads).

If you do not have these, ask your admin.

## 4. First-Time Quick Start
1. Open the app URL.
2. Enter the site password.
3. Go to `Upload Center`.
4. Select your chapter from the chapter dropdown.
5. Select a report type:
   - Weekly Report (`.xls` or `.xlsx`)
   - YTD Report (`.xls` or `.xlsx`)
   - Traffic Lights (`.pdf`)
6. Choose your file.
7. Click `Load Selected Report To Analytics`.
8. Enter the required PIN when prompted.
9. Wait for the success message.
10. Open `Analytics Dashboard` and verify the updated numbers.

## 5. Upload Rules
- Weekly and YTD files must be Excel files: `.xls` or `.xlsx`.
- Traffic Lights file must be a PDF: `.pdf`.
- Uploading a new Weekly/YTD report for a chapter replaces the previous current report for that same type.
- Referrals Total is calculated as `RGI + RGO`.

## 6. Reading Analytics
- Top cards show this week's core metrics:
  - Visitors
  - CEU's
  - 121's
  - Referrals Total
  - TYFCB
- YTD table shows current progress against yearly goals.
- Traffic section shows score distribution and 100 Percent Club members.

## 7. PIN and Goal Management (Admin/Leadership)
Use `/pin-settings` to:
- Change a chapter upload PIN.
- Update yearly goals (Visitors, One to Ones, Referrals, CEU, TYFCB).
- Review latest load timestamps by chapter in `Latest Report Loads`.

Important:
- Saving a new chapter PIN requires the current chapter PIN.
- Saving yearly goals requires chapter PIN confirmation.
- Default pin is 12345 unless chapter has changed the password

## 8. Common Issues and Fixes
- `Nothing happens after selecting file`:
  - Confirm file type matches the selected report type.
  - Click the load button and complete the PIN prompt.
- `PIN rejected`:
  - Confirm you selected the correct chapter.
  - Confirm you used the chapter PIN (or Traffic Lights PIN for traffic upload).
- `No chapter data in analytics`:
  - Confirm at least one successful upload exists for that chapter.
  - Refresh the page after upload.
- `Unable to load/save to Supabase`:
  - Usually a backend environment/config issue. Contact admin.

## 9. Recommended Weekly Workflow
1. Upload Weekly report.
2. Upload YTD report.
3. Upload Traffic Lights PDF (when available).
4. Open analytics and validate:
   - Weekly cards look correct.
   - YTD current values updated.
   - Traffic data appears for the current traffic month.

## 10. Security Best Practices
- Do not share chapter PINs in email threads or screenshots.
- Rotate chapter PINs periodically in `/pin-settings`.
- Change access passwords when staff/leadership changes.
