import json
import re
from datetime import datetime
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Dict, Iterable, List, Optional

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from openpyxl import Workbook

from .merge import member_key, merge_reports
from .parsers import (
    REFERRAL_COLUMNS,
    REFERRALS_TOTAL_COLUMN,
    SPREADSHEET_TABLE_START_ROW,
    TL_COLUMNS,
    parse_chapter_spreadsheet,
    parse_traffic_lights_pdf,
    tally_referral_columns,
)
from .supabase_client import SupabaseClient, SupabaseError

APP_ROOT = Path(__file__).resolve().parent.parent
STATIC_DIR = APP_ROOT / "static"
CHAPTERS_FILE = APP_ROOT / "chapters.json"
UPLOADS_DIR = APP_ROOT / "uploads"
SUPABASE = SupabaseClient.from_env()
SUPABASE_REQUIRED_DETAIL = (
    "Supabase is required for uploads and analytics. "
    "Set SUPABASE_URL and SUPABASE_SERVICE_KEY, then restart the server."
)

app = FastAPI()
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

ANALYTICS_GOALS = {
    "visitors": 190.0,
    "one_to_ones": 4400.0,
    "referrals": 1550.0,
    "ceu": 2630.0,
    "tyfcb": 2500000.0,
}


def load_chapters_file() -> List[str]:
    if not CHAPTERS_FILE.exists():
        return []
    try:
        data = json.loads(CHAPTERS_FILE.read_text(encoding="utf-8"))
        chapters = data.get("chapters", [])
        if isinstance(chapters, list):
            return [str(c) for c in chapters if str(c).strip()]
    except json.JSONDecodeError:
        return []
    return []


def strip_region_suffix(name: str) -> str:
    return re.sub(
        r"\s*-\s*(MO St\. Louis|IL Southern)\s*$",
        "",
        name.strip(),
        flags=re.IGNORECASE,
    )


def normalize_chapter(name: str) -> str:
    name = strip_region_suffix(name)
    return re.sub(r"[^a-z0-9]+", "", name.lower())


def slugify(value: str) -> str:
    value = strip_region_suffix(value)
    value = re.sub(r"[^a-zA-Z0-9]+", "_", value.strip())
    return value.strip("_").lower() or "unknown"


def load_chapters() -> List[str]:
    if not SUPABASE:
        raise SupabaseError("Supabase is not configured.")
    return SUPABASE.list_active_chapters()


def safe_filename(name: str) -> str:
    name = re.sub(r"[^a-zA-Z0-9._-]+", "_", name)
    return name.strip("._") or "upload"


async def save_upload(upload: UploadFile, path: Path) -> None:
    content = await upload.read()
    path.write_bytes(content)


def _as_number(value: object) -> float:
    if isinstance(value, bool):
        return 0.0
    if isinstance(value, (int, float)):
        return float(value)
    return 0.0


def _round_total(value: float) -> object:
    if float(value).is_integer():
        return int(value)
    return round(value, 2)


def _nullable_number(value: object) -> Optional[float]:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    return None


def _extract_columns(rows: Iterable[Dict[str, object]]) -> List[str]:
    seen = set()
    ordered: List[str] = []
    for row in rows:
        for key in row.keys():
            if key not in seen:
                seen.add(key)
                ordered.append(str(key))
    return ordered


def _sample_members(rows: Iterable[Dict[str, object]], limit: int = 5) -> List[str]:
    samples: List[str] = []
    for row in rows:
        first = str(row.get("First Name", "")).strip()
        last = str(row.get("Last Name", "")).strip()
        full = f"{first} {last}".strip()
        if full:
            samples.append(full)
        if len(samples) >= limit:
            break
    return samples


def infer_traffic_report_month(filename: str) -> str:
    stem = Path(filename or "").stem.lower()

    year_month_match = re.search(r"(20\d{2})[-_](0[1-9]|1[0-2])", stem)
    if year_month_match:
        year = int(year_month_match.group(1))
        month = int(year_month_match.group(2))
        return f"{year:04d}-{month:02d}-01"

    month_year_match = re.search(r"(0[1-9]|1[0-2])[-_](20\d{2})", stem)
    if month_year_match:
        month = int(month_year_match.group(1))
        year = int(month_year_match.group(2))
        return f"{year:04d}-{month:02d}-01"

    month_map = {
        "jan": 1,
        "feb": 2,
        "mar": 3,
        "apr": 4,
        "may": 5,
        "jun": 6,
        "jul": 7,
        "aug": 8,
        "sep": 9,
        "oct": 10,
        "nov": 11,
        "dec": 12,
    }

    named_month_match = re.search(
        r"(20\d{2})[-_ ]?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)",
        stem,
    )
    if named_month_match:
        year = int(named_month_match.group(1))
        month = month_map[named_month_match.group(2)]
        return f"{year:04d}-{month:02d}-01"

    reverse_named_match = re.search(
        r"(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[-_ ]?(20\d{2})",
        stem,
    )
    if reverse_named_match:
        month = month_map[reverse_named_match.group(1)]
        year = int(reverse_named_match.group(2))
        return f"{year:04d}-{month:02d}-01"

    now = datetime.utcnow()
    return f"{now.year:04d}-{now.month:02d}-01"


def _upload_content_type(upload: UploadFile, report_type: str) -> str:
    guessed = (upload.content_type or "").strip()
    if guessed:
        return guessed
    if report_type == "traffic":
        return "application/pdf"
    ext = Path(upload.filename or "").suffix.lower()
    if ext == ".xlsx":
        return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    return "application/vnd.ms-excel"


def _persist_upload_to_supabase(
    *,
    chapter: str,
    chapter_slug: str,
    report_type: str,
    timestamp: str,
    upload: UploadFile,
    content: bytes,
    validation: Optional[Dict[str, object]],
    parsed_rows: List[Dict[str, object]],
) -> Dict[str, object]:
    if not SUPABASE:
        raise SupabaseError("Supabase is not configured.")

    content_type = _upload_content_type(upload, report_type)
    safe_original_name = safe_filename(upload.filename or "upload")

    if report_type in {"weekly", "ytd"}:
        chapter_row = SUPABASE.upsert_chapter(name=chapter, slug=chapter_slug)
        chapter_id = str(chapter_row["id"])
        prior_uploads = SUPABASE.list_chapter_report_uploads(
            chapter_id=chapter_id,
            report_type=report_type,
        )
        chapter_ext = Path(safe_original_name).suffix.lower()
        if chapter_ext not in {".xls", ".xlsx"}:
            chapter_ext = ".xls"
        current_path = f"chapters/{chapter_slug}/{report_type}{chapter_ext}"
        archive_path = (
            f"chapters/{chapter_slug}/archive/{report_type}/{timestamp}_{safe_original_name}"
        )

        SUPABASE.upload_object(
            object_path=current_path,
            content=content,
            content_type=content_type,
            upsert=True,
        )
        SUPABASE.upload_object(
            object_path=archive_path,
            content=content,
            content_type=content_type,
            upsert=False,
        )

        upload_row = SUPABASE.insert_chapter_report_upload(
            {
                "chapter_id": chapter_row["id"],
                "report_type": report_type,
                "original_filename": upload.filename,
                "storage_bucket": SUPABASE.config.bucket,
                "storage_path": archive_path,
                "file_size_bytes": len(content),
                "mime_type": content_type,
                "validation": validation or {},
            }
        )
        upload_id = int(upload_row["id"])
        member_rows_payload: List[Dict[str, object]] = []
        for row in parsed_rows:
            first = str(row.get("First Name", "")).strip()
            last = str(row.get("Last Name", "")).strip()
            member_rows_payload.append(
                {
                    "upload_id": upload_id,
                    "chapter_id": chapter_row["id"],
                    "report_type": report_type,
                    "first_name": first,
                    "last_name": last,
                    "member_key": member_key(first, last),
                    "p": _nullable_number(row.get("P")),
                    "a": _nullable_number(row.get("A")),
                    "l": _nullable_number(row.get("L")),
                    "m": _nullable_number(row.get("M")),
                    "s": _nullable_number(row.get("S")),
                    "rgi": _nullable_number(row.get("RGI")),
                    "rgo": _nullable_number(row.get("RGO")),
                    "rri": _nullable_number(row.get("RRI")),
                    "rro": _nullable_number(row.get("RRO")),
                    "v": _nullable_number(row.get("V")),
                    "one_to_one": _nullable_number(row.get("1-2-1")),
                    "tyfcb": _nullable_number(row.get("TYFCB")),
                    "ceu": _nullable_number(row.get("CEU")),
                    "referrals_total": _nullable_number(
                        row.get(REFERRALS_TOTAL_COLUMN)
                    )
                    or 0.0,
                    "raw": row,
                }
            )
        member_rows_inserted = SUPABASE.insert_chapter_report_member_rows(
            member_rows_payload
        )

        # Keep only the newest upload per chapter/report_type.
        # Older uploads and their member rows are removed via cascade.
        SUPABASE.delete_chapter_report_uploads_except(
            chapter_id=chapter_id,
            report_type=report_type,
            keep_upload_id=upload_id,
        )
        for prior in prior_uploads:
            prior_path = str(prior.get("storage_path") or "").strip()
            if prior_path and prior_path != archive_path:
                SUPABASE.delete_object(object_path=prior_path)

        # Ensure only one current object remains per report type.
        for ext in (".xls", ".xlsx"):
            previous_current_path = f"chapters/{chapter_slug}/{report_type}{ext}"
            if previous_current_path != current_path:
                SUPABASE.delete_object(object_path=previous_current_path)

        return {
            "table": "chapter_report_uploads",
            "record_id": upload_id,
            "current_storage_path": current_path,
            "archive_storage_path": archive_path,
            "parsed_member_rows_inserted": member_rows_inserted,
        }

    report_month = infer_traffic_report_month(upload.filename or "")
    month_key = report_month[:7]
    current_path = f"traffic_lights/{month_key}/traffic.pdf"
    archive_path = f"traffic_lights/archive/{month_key}/{timestamp}_{safe_original_name}"

    SUPABASE.upload_object(
        object_path=current_path,
        content=content,
        content_type=content_type,
        upsert=True,
    )
    SUPABASE.upload_object(
        object_path=archive_path,
        content=content,
        content_type=content_type,
        upsert=False,
    )

    upload_row = SUPABASE.upsert_traffic_light_upload(
        {
            "report_month": report_month,
            "original_filename": upload.filename,
            "storage_bucket": SUPABASE.config.bucket,
            "storage_path": current_path,
            "file_size_bytes": len(content),
            "mime_type": content_type,
            "validation": validation or {},
        }
    )
    traffic_upload_id = int(upload_row["id"])
    SUPABASE.delete_traffic_light_member_rows(traffic_upload_id)
    traffic_rows_payload: List[Dict[str, object]] = []
    for row in parsed_rows:
        chapter_name = str(row.get("Chapter", "")).strip()
        first = str(row.get("First Name", "")).strip()
        last = str(row.get("Last Name", "")).strip()
        traffic_rows_payload.append(
            {
                "traffic_upload_id": traffic_upload_id,
                "report_month": report_month,
                "chapter_name": chapter_name,
                "chapter_slug": slugify(chapter_name),
                "first_name": first,
                "last_name": last,
                "member_key": member_key(first, last),
                "referrals": _nullable_number(row.get("Referrals")),
                "raw": row,
            }
        )
    member_rows_inserted = SUPABASE.insert_traffic_light_member_rows(traffic_rows_payload)

    return {
        "table": "traffic_light_uploads",
        "record_id": traffic_upload_id,
        "report_month": report_month,
        "current_storage_path": current_path,
        "archive_storage_path": archive_path,
        "parsed_member_rows_inserted": member_rows_inserted,
    }


def _to_iso_utc_from_mtime(path: Optional[Path]) -> Optional[str]:
    if not path:
        return None
    return datetime.utcfromtimestamp(path.stat().st_mtime).replace(microsecond=0).isoformat() + "Z"


def _latest_file(directory: Path, suffixes: Iterable[str] | str) -> Optional[Path]:
    if not directory.exists():
        return None
    suffix_list = [suffixes] if isinstance(suffixes, str) else list(suffixes)
    files: List[Path] = []
    for suffix in suffix_list:
        files.extend(p for p in directory.glob(f"*{suffix}") if p.is_file())
    if not files:
        return None
    files.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return files[0]


def _normalize_member_rows(rows: Iterable[Dict[str, object]]) -> List[Dict[str, object]]:
    normalized: List[Dict[str, object]] = []
    for row in rows:
        first = str(row.get("first_name", row.get("First Name", ""))).strip()
        last = str(row.get("last_name", row.get("Last Name", ""))).strip()
        normalized.append(
            {
                "first_name": first,
                "last_name": last,
                "member_key": str(row.get("member_key", "")).strip(),
                "v": _as_number(row.get("v", row.get("V"))),
                "ceu": _as_number(row.get("ceu", row.get("CEU"))),
                "one_to_one": _as_number(row.get("one_to_one", row.get("1-2-1"))),
                "referrals_total": _as_number(
                    row.get("referrals_total", row.get(REFERRALS_TOTAL_COLUMN))
                ),
                "tyfcb": _as_number(row.get("tyfcb", row.get("TYFCB"))),
            }
        )
    return normalized


def _normalize_traffic_rows(rows: Iterable[Dict[str, object]]) -> List[Dict[str, object]]:
    normalized: List[Dict[str, object]] = []
    for row in rows:
        first = str(row.get("first_name", row.get("First Name", ""))).strip()
        last = str(row.get("last_name", row.get("Last Name", ""))).strip()

        raw = row.get("raw", {})
        points_value = None
        if isinstance(raw, dict):
            points_value = raw.get("Points")
        if points_value is None:
            points_value = row.get("Points")

        normalized.append(
            {
                "first_name": first,
                "last_name": last,
                "member_key": str(row.get("member_key", "")).strip(),
                "referrals": _as_number(row.get("referrals", row.get("Referrals"))),
                "points": _nullable_number(points_value),
            }
        )
    return normalized


def _sum_metric(rows: Iterable[Dict[str, object]], key: str) -> object:
    return _round_total(sum(_as_number(row.get(key)) for row in rows))


def _member_display_name(first: str, last: str) -> str:
    first = (first or "").strip()
    last = (last or "").strip()
    if last and first:
        return f"{last}, {first}"
    return first or last


def _build_traffic_distribution(
    rows: Iterable[Dict[str, object]],
) -> Dict[str, object]:
    buckets = {
        "club100": 0,
        "green": 0,
        "red": 0,
        "yellow": 0,
    }
    club_members: List[str] = []
    total = 0

    for row in rows:
        total += 1
        points = _nullable_number(row.get("points"))
        score = points if points is not None else 0.0
        if score >= 100:
            buckets["club100"] += 1
            name = _member_display_name(
                str(row.get("first_name", "")),
                str(row.get("last_name", "")),
            )
            if name:
                club_members.append(name)
        elif score >= 60:
            buckets["green"] += 1
        elif score >= 40:
            buckets["yellow"] += 1
        else:
            buckets["red"] += 1

    def _pct(count: int) -> float:
        if total <= 0:
            return 0.0
        return round((count / total) * 100.0, 1)

    distribution = [
        {
            "key": "club100",
            "label": "100 percent Club",
            "count": buckets["club100"],
            "pct": _pct(buckets["club100"]),
            "color": "#6ca0ff",
        },
        {
            "key": "green",
            "label": "Green",
            "count": buckets["green"],
            "pct": _pct(buckets["green"]),
            "color": "#9abf4f",
        },
        {
            "key": "red",
            "label": "Red",
            "count": buckets["red"],
            "pct": _pct(buckets["red"]),
            "color": "#e84a4a",
        },
        {
            "key": "yellow",
            "label": "Yellow",
            "count": buckets["yellow"],
            "pct": _pct(buckets["yellow"]),
            "color": "#e9c53a",
        },
    ]

    unique_club_members = sorted({name for name in club_members if name})
    return {"distribution": distribution, "club_members": unique_club_members}


def _build_analytics_payload(
    *,
    chapter: str,
    chapter_slug: str,
    source: str,
    weekly_rows: List[Dict[str, object]],
    ytd_rows: List[Dict[str, object]],
    traffic_rows: List[Dict[str, object]],
    weekly_uploaded_at: Optional[str],
    ytd_uploaded_at: Optional[str],
    traffic_uploaded_at: Optional[str],
    traffic_report_month: Optional[str],
) -> Dict[str, object]:
    weekly_summary = {
        "visitors": _sum_metric(weekly_rows, "v"),
        "ceu": _sum_metric(weekly_rows, "ceu"),
        "one_to_ones": _sum_metric(weekly_rows, "one_to_one"),
        "referrals": _sum_metric(weekly_rows, "referrals_total"),
        "tyfcb": _sum_metric(weekly_rows, "tyfcb"),
    }
    ytd_summary = {
        "visitors": _sum_metric(ytd_rows, "v"),
        "ceu": _sum_metric(ytd_rows, "ceu"),
        "one_to_ones": _sum_metric(ytd_rows, "one_to_one"),
        "referrals": _sum_metric(ytd_rows, "referrals_total"),
        "tyfcb": _sum_metric(ytd_rows, "tyfcb"),
    }

    bar_order = [
        ("ceu", "CEU"),
        ("referrals", "Referrals"),
        ("one_to_ones", "One to Ones"),
        ("visitors", "Visitors"),
        ("tyfcb", "TYFCB"),
    ]
    bar_metrics = []
    for key, label in bar_order:
        current = float(_as_number(ytd_summary.get(key)))
        goal = float(ANALYTICS_GOALS[key])
        bar_metrics.append(
            {
                "key": key,
                "label": label,
                "current": _round_total(current),
                "goal": _round_total(goal),
            }
        )

    ytd_metrics = []
    table_order = [
        ("visitors", "Visitors"),
        ("one_to_ones", "One to Ones"),
        ("referrals", "Referrals"),
        ("ceu", "CEU"),
        ("tyfcb", "TYFCB"),
    ]
    for key, label in table_order:
        current = float(_as_number(ytd_summary.get(key)))
        goal = float(ANALYTICS_GOALS[key])
        pct_to_goal = round((current / goal) * 100.0, 1) if goal > 0 else 0.0
        ytd_metrics.append(
            {
                "key": key,
                "metric": label,
                "current": _round_total(current),
                "yearly_goal": _round_total(goal),
                "pct_to_goal": pct_to_goal,
            }
        )

    traffic_parts = _build_traffic_distribution(traffic_rows)
    return {
        "chapter": chapter,
        "chapter_slug": chapter_slug,
        "source": source,
        "generated_at": datetime.utcnow().replace(microsecond=0).isoformat() + "Z",
        "updated_at": {
            "weekly_uploaded_at": weekly_uploaded_at,
            "ytd_uploaded_at": ytd_uploaded_at,
            "traffic_uploaded_at": traffic_uploaded_at,
            "traffic_report_month": traffic_report_month,
        },
        "has_data": {
            "weekly": bool(weekly_rows),
            "ytd": bool(ytd_rows),
            "traffic": bool(traffic_rows),
        },
        "weekly_summary": weekly_summary,
        "ytd_summary": ytd_summary,
        "bar_metrics": bar_metrics,
        "ytd_metrics": ytd_metrics,
        "traffic_distribution": traffic_parts["distribution"],
        "club_members": traffic_parts["club_members"],
    }


def _load_supabase_analytics(chapter: str) -> Dict[str, object]:
    if not SUPABASE:
        raise SupabaseError("Supabase is not configured.")

    chapter_slug = slugify(chapter)
    chapter_row = SUPABASE.get_chapter_by_slug(chapter_slug)
    if not chapter_row:
        return _build_analytics_payload(
            chapter=chapter,
            chapter_slug=chapter_slug,
            source="supabase",
            weekly_rows=[],
            ytd_rows=[],
            traffic_rows=[],
            weekly_uploaded_at=None,
            ytd_uploaded_at=None,
            traffic_uploaded_at=None,
            traffic_report_month=None,
        )

    chapter_id = str(chapter_row["id"])
    weekly_upload = SUPABASE.get_latest_chapter_upload(
        chapter_id=chapter_id, report_type="weekly"
    )
    ytd_upload = SUPABASE.get_latest_chapter_upload(
        chapter_id=chapter_id, report_type="ytd"
    )
    traffic_upload = SUPABASE.get_latest_traffic_upload()

    weekly_rows = _normalize_member_rows(
        SUPABASE.get_chapter_member_rows_for_upload(int(weekly_upload["id"]))
        if weekly_upload
        else []
    )
    ytd_rows = _normalize_member_rows(
        SUPABASE.get_chapter_member_rows_for_upload(int(ytd_upload["id"]))
        if ytd_upload
        else []
    )
    traffic_rows = _normalize_traffic_rows(
        SUPABASE.get_traffic_rows_for_upload(
            traffic_upload_id=int(traffic_upload["id"]),
            chapter_slug=chapter_slug,
        )
        if traffic_upload
        else []
    )

    return _build_analytics_payload(
        chapter=str(chapter_row.get("name") or chapter),
        chapter_slug=chapter_slug,
        source="supabase",
        weekly_rows=weekly_rows,
        ytd_rows=ytd_rows,
        traffic_rows=traffic_rows,
        weekly_uploaded_at=str(weekly_upload.get("uploaded_at")) if weekly_upload else None,
        ytd_uploaded_at=str(ytd_upload.get("uploaded_at")) if ytd_upload else None,
        traffic_uploaded_at=str(traffic_upload.get("uploaded_at")) if traffic_upload else None,
        traffic_report_month=str(traffic_upload.get("report_month")) if traffic_upload else None,
    )


def _load_local_analytics(chapter: str) -> Dict[str, object]:
    chapter_slug = slugify(chapter)
    chapter_dir = UPLOADS_DIR / chapter_slug
    weekly_path = _latest_file(chapter_dir / "weekly", (".xlsx", ".xls"))
    ytd_path = _latest_file(chapter_dir / "ytd", (".xlsx", ".xls"))
    traffic_path = _latest_file(chapter_dir / "traffic", ".pdf")

    weekly_rows_raw = parse_chapter_spreadsheet(weekly_path) if weekly_path else []
    ytd_rows_raw = parse_chapter_spreadsheet(ytd_path) if ytd_path else []
    traffic_rows_raw = parse_traffic_lights_pdf(traffic_path) if traffic_path else []

    chapter_norm = normalize_chapter(chapter)
    filtered_traffic_rows = [
        row
        for row in traffic_rows_raw
        if normalize_chapter(str(row.get("Chapter", ""))) == chapter_norm
    ]

    return _build_analytics_payload(
        chapter=chapter,
        chapter_slug=chapter_slug,
        source="local",
        weekly_rows=_normalize_member_rows(weekly_rows_raw),
        ytd_rows=_normalize_member_rows(ytd_rows_raw),
        traffic_rows=_normalize_traffic_rows(filtered_traffic_rows),
        weekly_uploaded_at=_to_iso_utc_from_mtime(weekly_path),
        ytd_uploaded_at=_to_iso_utc_from_mtime(ytd_path),
        traffic_uploaded_at=_to_iso_utc_from_mtime(traffic_path),
        traffic_report_month=infer_traffic_report_month(traffic_path.name)
        if traffic_path
        else None,
    )


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/login")
def login_page() -> FileResponse:
    # Staged page for future paywall/auth rollout. Not enforced yet.
    return FileResponse(STATIC_DIR / "login.html")


@app.get("/analytics")
def analytics_page() -> FileResponse:
    return FileResponse(STATIC_DIR / "analytics.html")


@app.get("/api/chapters")
def chapters() -> List[str]:
    if not SUPABASE:
        raise HTTPException(status_code=503, detail=SUPABASE_REQUIRED_DETAIL)
    try:
        return load_chapters()
    except SupabaseError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Failed to load chapters from Supabase: {exc}",
        ) from exc


@app.get("/api/analytics")
def analytics(chapter: str) -> Dict[str, object]:
    chapter = (chapter or "").strip()
    if not chapter:
        raise HTTPException(status_code=400, detail="Chapter is required.")
    if not SUPABASE:
        raise HTTPException(status_code=503, detail=SUPABASE_REQUIRED_DETAIL)
    try:
        return _load_supabase_analytics(chapter)
    except SupabaseError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Failed to load analytics from Supabase: {exc}",
        ) from exc


@app.post("/api/upload")
async def upload_file(
    chapter: str = Form(...),
    report_type: str = Form(...),
    file: UploadFile = File(...),
):
    chapter = (chapter or "").strip()
    report_type = (report_type or "").strip().lower()

    if not chapter:
        raise HTTPException(status_code=400, detail="Chapter is required.")

    if report_type not in {"weekly", "ytd", "traffic"}:
        raise HTTPException(status_code=400, detail="Invalid report type.")
    if not SUPABASE:
        raise HTTPException(status_code=503, detail=SUPABASE_REQUIRED_DETAIL)

    if not file.filename:
        raise HTTPException(status_code=400, detail="Missing file.")

    ext = Path(file.filename).suffix.lower()
    if report_type in {"weekly", "ytd"} and ext not in {".xls", ".xlsx"}:
        raise HTTPException(status_code=400, detail="Weekly/YTD must be .xls or .xlsx.")
    if report_type == "traffic" and ext != ".pdf":
        raise HTTPException(status_code=400, detail="Traffic Lights must be .pdf.")

    timestamp = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
    chapter_slug = slugify(chapter)
    target_dir = UPLOADS_DIR / chapter_slug / report_type
    target_dir.mkdir(parents=True, exist_ok=True)

    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="Uploaded file is empty.")

    safe_name = safe_filename(Path(file.filename).stem)
    target_path = target_dir / f"{timestamp}_{safe_name}{ext}"
    target_path.write_bytes(content)

    validation = None
    parsed_rows: List[Dict[str, object]] = []
    if report_type in {"weekly", "ytd"}:
        try:
            rows = parse_chapter_spreadsheet(target_path)
        except Exception as exc:
            raise HTTPException(
                status_code=400,
                detail=f"Unable to parse {report_type.upper()} Excel report.",
            ) from exc

        parsed_rows = rows
        columns_loaded = _extract_columns(rows)
        referral_tally = tally_referral_columns(rows)
        referral_total = _round_total(
            sum(float(referral_tally[col]) for col in REFERRAL_COLUMNS)
        )

        validation = {
            "kind": "chapter_spreadsheet",
            "rows_parsed": len(rows),
            "columns_loaded": columns_loaded,
            "table_start_row": SPREADSHEET_TABLE_START_ROW,
            "referral_columns": list(REFERRAL_COLUMNS),
            "row_referrals_total_column": REFERRALS_TOTAL_COLUMN,
            "referral_tally": referral_tally,
            "referrals_total": referral_total,
            "key_metrics_summary": [
                {
                    "key": "v",
                    "label": "V",
                    "value": _round_total(
                        sum(_as_number(row.get("V")) for row in rows)
                    ),
                },
                {
                    "key": "one_to_ones",
                    "label": "1-2-1's",
                    "value": _round_total(
                        sum(_as_number(row.get("1-2-1")) for row in rows)
                    ),
                },
                {
                    "key": "tyfcb",
                    "label": "TYFCB",
                    "value": _round_total(
                        sum(_as_number(row.get("TYFCB")) for row in rows)
                    ),
                },
                {
                    "key": "ceu",
                    "label": "CEU",
                    "value": _round_total(
                        sum(_as_number(row.get("CEU")) for row in rows)
                    ),
                },
                {
                    "key": "referrals_total",
                    "label": "Referrals Total",
                    "value": _round_total(
                        sum(
                            _as_number(row.get(REFERRALS_TOTAL_COLUMN))
                            for row in rows
                        )
                    ),
                },
            ],
            "sample_members": _sample_members(rows),
        }
    elif report_type == "traffic":
        try:
            rows = parse_traffic_lights_pdf(target_path)
        except Exception as exc:
            raise HTTPException(
                status_code=400,
                detail="Unable to parse Traffic Lights PDF report.",
            ) from exc

        parsed_rows = rows
        chapters_detected = sorted(
            {
                str(row.get("Chapter", "")).strip()
                for row in rows
                if str(row.get("Chapter", "")).strip()
            }
        )
        referrals_total = _round_total(sum(_as_number(row.get("Referrals")) for row in rows))

        validation = {
            "kind": "traffic_lights_pdf",
            "rows_parsed": len(rows),
            "columns_loaded": ["Chapter", "First Name", "Last Name", *TL_COLUMNS],
            "chapters_detected": chapters_detected,
            "chapters_detected_count": len(chapters_detected),
            "referrals_total": referrals_total,
            "sample_members": _sample_members(rows),
        }

    try:
        supabase_result = _persist_upload_to_supabase(
            chapter=chapter,
            chapter_slug=chapter_slug,
            report_type=report_type,
            timestamp=timestamp,
            upload=file,
            content=content,
            validation=validation,
            parsed_rows=parsed_rows,
        )
        if (
            report_type == "traffic"
            and validation is not None
            and isinstance(supabase_result, dict)
            and supabase_result.get("report_month")
        ):
            validation["report_month"] = supabase_result["report_month"]
    except SupabaseError as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Report parsed but failed to persist to Supabase: {exc}",
        ) from exc

    response = {
        "status": "ok",
        "path": str(target_path),
        "validation": validation,
        "storage_backend": "supabase",
    }
    response["supabase"] = supabase_result
    return response


@app.post("/api/process")
async def process(
    chapter: str = Form(...),
    weekly: UploadFile = File(...),
    ytd: UploadFile = File(...),
    traffic: UploadFile = File(...),
):
    chapter = (chapter or "").strip()
    if not chapter:
        raise HTTPException(status_code=400, detail="Chapter is required.")

    with TemporaryDirectory() as tmpdir:
        tmp = Path(tmpdir)
        weekly_path = tmp / weekly.filename
        ytd_path = tmp / ytd.filename
        traffic_path = tmp / traffic.filename

        await save_upload(weekly, weekly_path)
        await save_upload(ytd, ytd_path)
        await save_upload(traffic, traffic_path)

        weekly_rows = parse_chapter_spreadsheet(weekly_path)
        ytd_rows = parse_chapter_spreadsheet(ytd_path)
        traffic_rows = parse_traffic_lights_pdf(traffic_path)

        chapter_norm = normalize_chapter(chapter)
        traffic_rows = [
            r
            for r in traffic_rows
            if normalize_chapter(str(r.get("Chapter", ""))) == chapter_norm
        ]

        if not traffic_rows:
            raise HTTPException(
                status_code=400,
                detail="Chapter not found in traffic lights report.",
            )

        merged = merge_reports(chapter, weekly_rows, ytd_rows, traffic_rows)

        wb = Workbook()
        ws = wb.active
        ws.title = "Merged"

        if not merged:
            ws.append(["Chapter", "First Name", "Last Name"])
        else:
            headers = list(merged[0].keys())
            ws.append(headers)
            for row in merged:
                ws.append([row.get(h, "") for h in headers])

        output = BytesIO()
        wb.save(output)
        output.seek(0)

        filename = f"{chapter.replace(' ', '_')}_merged.xlsx"
        return StreamingResponse(
            output,
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={"Content-Disposition": f"attachment; filename={filename}"},
        )
