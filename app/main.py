import json
import hashlib
import hmac
import os
import re
import time
from datetime import datetime
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Dict, Iterable, List, Optional
from urllib.parse import quote

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from openpyxl import Workbook
from pydantic import BaseModel

from .merge import member_key, merge_reports
from .parsers import (
    REFERRAL_COLUMNS,
    REFERRALS_TOTAL_COLUMN,
    SPREADSHEET_TABLE_START_ROW,
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

AUTH_COOKIE_NAME = "bni_palms_auth"
AUTH_COOKIE_MAX_AGE_SECONDS = max(
    300,
    int(os.getenv("APP_AUTH_SESSION_SECONDS", "43200")),
)
AUTH_DEFAULT_PASSWORD = "giversgain"
AUTH_SESSION_SECRET = (
    os.getenv("APP_AUTH_SESSION_SECRET", "").strip()
    or os.getenv("SUPABASE_SERVICE_KEY", "").strip()
    or "bni-palms-local-session"
)
AUTH_COOKIE_SECURE = os.getenv("APP_AUTH_COOKIE_SECURE", "0").strip().lower() in {
    "1",
    "true",
    "yes",
}
DEFAULT_CHAPTER_UPLOAD_PIN = (
    os.getenv("APP_DEFAULT_CHAPTER_UPLOAD_PIN", "12345").strip() or "12345"
)
CHAPTER_PIN_MIN_LENGTH = max(
    1,
    int((os.getenv("APP_CHAPTER_PIN_MIN_LENGTH", "4") or "4").strip() or "4"),
)
CHAPTER_PIN_MAX_LENGTH = max(CHAPTER_PIN_MIN_LENGTH, 32)
CHAPTER_PIN_PATTERN = re.compile(r"^\d+$")


def _configured_chapter_upload_pins() -> Dict[str, str]:
    raw_json = os.getenv("APP_CHAPTER_UPLOAD_PINS", "").strip()
    if not raw_json:
        return {}
    try:
        parsed = json.loads(raw_json)
    except json.JSONDecodeError:
        return {}
    if not isinstance(parsed, dict):
        return {}

    chapter_pins: Dict[str, str] = {}
    for chapter_name, pin_value in parsed.items():
        chapter_key = slugify(str(chapter_name))
        pin_text = str(pin_value or "").strip()
        if chapter_key and pin_text:
            chapter_pins[chapter_key] = pin_text
    return chapter_pins


class LoginPayload(BaseModel):
    password: str
    next: Optional[str] = None


class ChapterPinChangePayload(BaseModel):
    chapter: str
    current_pin: str
    new_pin: str
    confirm_new_pin: str


class ChapterGoalsUpdatePayload(BaseModel):
    chapter: str
    current_pin: str
    visitors: float
    one_to_ones: float
    referrals: float
    ceu: float
    tyfcb: float


def _configured_auth_passwords() -> List[str]:
    passwords: List[str] = []
    csv_value = (
        os.getenv("APP_AUTH_PASSWORDS", "").strip()
        or os.getenv("BNI_AUTH_PASSWORDS", "").strip()
    )
    if csv_value:
        passwords.extend([value.strip() for value in csv_value.split(",") if value.strip()])

    single_value = (
        os.getenv("APP_AUTH_PASSWORD", "").strip()
        or os.getenv("APP_AUTH_PIN", "").strip()
    )
    if single_value:
        passwords.append(single_value)

    if passwords:
        return sorted(set(passwords))
    return [AUTH_DEFAULT_PASSWORD]


AUTH_PASSWORDS = _configured_auth_passwords()


def _normalize_next_path(value: Optional[str]) -> str:
    if not value:
        return "/"
    value = str(value).strip()
    if not value.startswith("/") or value.startswith("//"):
        return "/"
    if value.startswith("/api/"):
        return "/"
    return value


def _auth_signature(payload: str) -> str:
    return hmac.new(
        AUTH_SESSION_SECRET.encode("utf-8"),
        payload.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


def _build_auth_token() -> str:
    expires_at = int(time.time()) + AUTH_COOKIE_MAX_AGE_SECONDS
    payload = str(expires_at)
    signature = _auth_signature(payload)
    return f"{payload}.{signature}"


def _is_valid_auth_token(token: Optional[str]) -> bool:
    if not token:
        return False
    if "." not in token:
        return False
    expires_at_raw, signature = token.split(".", 1)
    if not expires_at_raw.isdigit():
        return False
    expected = _auth_signature(expires_at_raw)
    if not hmac.compare_digest(signature, expected):
        return False
    return int(expires_at_raw) >= int(time.time())


def _is_authenticated(request: Request) -> bool:
    return _is_valid_auth_token(request.cookies.get(AUTH_COOKIE_NAME))


def _password_matches(candidate: str) -> bool:
    candidate = (candidate or "").strip()
    if not candidate:
        return False
    for configured in AUTH_PASSWORDS:
        if hmac.compare_digest(candidate, configured):
            return True
    return False


def _set_auth_cookie(response: JSONResponse) -> None:
    response.set_cookie(
        key=AUTH_COOKIE_NAME,
        value=_build_auth_token(),
        max_age=AUTH_COOKIE_MAX_AGE_SECONDS,
        httponly=True,
        secure=AUTH_COOKIE_SECURE,
        samesite="lax",
        path="/",
    )


def _expected_chapter_upload_pin(chapter: str) -> str:
    chapter_key = slugify(chapter)
    supabase_pin: Optional[str] = None
    if SUPABASE:
        try:
            supabase_pin = SUPABASE.get_chapter_upload_pin(chapter_slug=chapter_key)
        except SupabaseError as exc:
            if "chapter_upload_pins" not in str(exc):
                raise
    return supabase_pin or CHAPTER_UPLOAD_PINS.get(chapter_key) or DEFAULT_CHAPTER_UPLOAD_PIN


def _page_auth_or_redirect(request: Request) -> Optional[RedirectResponse]:
    if _is_authenticated(request):
        return None
    next_path = _normalize_next_path(request.url.path)
    return RedirectResponse(
        url=f"/login?next={quote(next_path, safe='/')}",
        status_code=303,
    )


def _require_api_auth(request: Request) -> None:
    if not _is_authenticated(request):
        raise HTTPException(status_code=401, detail="Login required.")


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


CHAPTER_UPLOAD_PINS = _configured_chapter_upload_pins()


def _set_chapter_upload_pin(chapter: str, pin: str) -> None:
    if not SUPABASE:
        raise SupabaseError("Supabase is not configured.")
    chapter_slug = slugify(chapter)
    SUPABASE.upsert_chapter_upload_pin(
        chapter_slug=chapter_slug,
        chapter_name=chapter,
        chapter_pin=pin,
    )


def _set_chapter_yearly_goals(chapter: str, goals: Dict[str, float]) -> None:
    if not SUPABASE:
        raise SupabaseError("Supabase is not configured.")
    chapter_slug = slugify(chapter)
    SUPABASE.upsert_chapter_yearly_goals(
        chapter_slug=chapter_slug,
        chapter_name=chapter,
        visitors=float(goals["visitors"]),
        one_to_ones=float(goals["one_to_ones"]),
        referrals=float(goals["referrals"]),
        ceu=float(goals["ceu"]),
        tyfcb=float(goals["tyfcb"]),
    )


def _default_yearly_goals() -> Dict[str, float]:
    return {key: float(value) for key, value in ANALYTICS_GOALS.items()}


def _chapter_yearly_goals(chapter: str) -> Dict[str, float]:
    goals = _default_yearly_goals()
    if not SUPABASE:
        return goals

    chapter_slug = slugify(chapter)
    try:
        row = SUPABASE.get_chapter_yearly_goals(chapter_slug=chapter_slug)
    except SupabaseError as exc:
        if "chapter_yearly_goals" in str(exc):
            return goals
        raise

    if not row:
        return goals

    for key in ("visitors", "one_to_ones", "referrals", "ceu", "tyfcb"):
        value = row.get(key)
        if isinstance(value, bool):
            continue
        if isinstance(value, (int, float)):
            goals[key] = float(value)

    return goals


def _validate_yearly_goals_input(goals: Dict[str, float]) -> None:
    labels = {
        "visitors": "Visitors",
        "one_to_ones": "One to Ones",
        "referrals": "Referrals",
        "ceu": "CEU",
        "tyfcb": "TYFCB",
    }
    for key, label in labels.items():
        value = goals.get(key)
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise HTTPException(status_code=400, detail=f"{label} yearly goal must be a number.")
        if float(value) < 0:
            raise HTTPException(status_code=400, detail=f"{label} yearly goal cannot be negative.")


def _public_yearly_goals_payload(goals: Dict[str, float]) -> Dict[str, object]:
    return {key: _round_total(float(goals.get(key, 0.0))) for key in ANALYTICS_GOALS.keys()}


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
        score = _nullable_number(row.get("Score", row.get("Points")))
        traffic_rows_payload.append(
            {
                "traffic_upload_id": traffic_upload_id,
                "report_month": report_month,
                "chapter_name": chapter_name,
                "chapter_slug": slugify(chapter_name),
                "first_name": first,
                "last_name": last,
                "member_key": member_key(first, last),
                # Reuse existing numeric column; traffic analytics is score-based.
                "referrals": score,
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
                points_value = raw.get("Score")
        if points_value is None:
            points_value = row.get("points", row.get("Points"))
        if points_value is None:
            points_value = row.get("Score")
        if points_value is None:
            points_value = row.get("referrals", row.get("Referrals"))

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
    yearly_goals: Dict[str, float],
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
    goals = {
        key: float(yearly_goals.get(key, ANALYTICS_GOALS[key]))
        for key in ANALYTICS_GOALS.keys()
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
        goal = float(goals[key])
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
        goal = float(goals[key])
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
        "yearly_goals": _public_yearly_goals_payload(goals),
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
    chapter_goals = _chapter_yearly_goals(chapter)
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
            yearly_goals=chapter_goals,
        )

    chapter_id = str(chapter_row["id"])
    weekly_upload = SUPABASE.get_latest_chapter_upload(
        chapter_id=chapter_id, report_type="weekly"
    )
    ytd_upload = SUPABASE.get_latest_chapter_upload(
        chapter_id=chapter_id, report_type="ytd"
    )
    traffic_upload = SUPABASE.get_latest_nonempty_traffic_upload()

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
        yearly_goals=chapter_goals,
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
        yearly_goals=_chapter_yearly_goals(chapter),
    )


@app.get("/")
def index(request: Request):
    guard = _page_auth_or_redirect(request)
    if guard:
        return guard
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/login")
def login_page(request: Request, next: Optional[str] = None):
    if _is_authenticated(request):
        return RedirectResponse(url=_normalize_next_path(next), status_code=303)
    return FileResponse(STATIC_DIR / "login.html")


@app.get("/analytics")
def analytics_page(request: Request):
    guard = _page_auth_or_redirect(request)
    if guard:
        return guard
    return FileResponse(STATIC_DIR / "analytics.html")


@app.get("/pin-settings")
def pin_settings_page(request: Request):
    guard = _page_auth_or_redirect(request)
    if guard:
        return guard
    return FileResponse(STATIC_DIR / "pin-settings.html")


@app.post("/api/login")
def api_login(payload: LoginPayload):
    password = (payload.password or "").strip()
    if not password:
        raise HTTPException(status_code=400, detail="PIN is required.")
    if not _password_matches(password):
        raise HTTPException(status_code=401, detail="Invalid PIN.")

    response = JSONResponse(
        {
            "status": "ok",
            "next": _normalize_next_path(payload.next),
        }
    )
    _set_auth_cookie(response)
    return response


@app.post("/api/logout")
def api_logout():
    response = JSONResponse({"status": "ok"})
    response.delete_cookie(key=AUTH_COOKIE_NAME, path="/")
    return response


@app.post("/api/chapter-pin/change")
def change_chapter_pin(
    payload: ChapterPinChangePayload,
    _auth: None = Depends(_require_api_auth),
):
    chapter = (payload.chapter or "").strip()
    current_pin = (payload.current_pin or "").strip()
    new_pin = (payload.new_pin or "").strip()
    confirm_new_pin = (payload.confirm_new_pin or "").strip()

    if not chapter:
        raise HTTPException(status_code=400, detail="Chapter is required.")
    if not SUPABASE:
        raise HTTPException(status_code=503, detail=SUPABASE_REQUIRED_DETAIL)
    if not current_pin:
        raise HTTPException(status_code=400, detail="Current PIN is required.")
    if not new_pin:
        raise HTTPException(status_code=400, detail="New PIN is required.")
    if not confirm_new_pin:
        raise HTTPException(status_code=400, detail="Confirm your new PIN.")
    if not hmac.compare_digest(new_pin, confirm_new_pin):
        raise HTTPException(status_code=400, detail="New PIN and confirmation do not match.")
    if not CHAPTER_PIN_PATTERN.fullmatch(new_pin):
        raise HTTPException(status_code=400, detail="New PIN must use numbers only.")
    if len(new_pin) < CHAPTER_PIN_MIN_LENGTH:
        raise HTTPException(
            status_code=400,
            detail=f"New PIN must be at least {CHAPTER_PIN_MIN_LENGTH} digits.",
        )
    if len(new_pin) > CHAPTER_PIN_MAX_LENGTH:
        raise HTTPException(
            status_code=400,
            detail=f"New PIN must be at most {CHAPTER_PIN_MAX_LENGTH} digits.",
        )
    if hmac.compare_digest(current_pin, new_pin):
        raise HTTPException(status_code=400, detail="New PIN must be different from current PIN.")

    try:
        expected_pin = _expected_chapter_upload_pin(chapter)
    except SupabaseError as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Unable to verify current chapter PIN from Supabase: {exc}",
        ) from exc
    if not hmac.compare_digest(current_pin, expected_pin):
        raise HTTPException(status_code=403, detail="Current PIN is incorrect.")

    try:
        _set_chapter_upload_pin(chapter, new_pin)
    except SupabaseError as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Unable to save chapter PIN to Supabase: {exc}",
        ) from exc

    return {
        "status": "ok",
        "chapter": chapter,
        "chapter_slug": slugify(chapter),
    }


@app.get("/api/chapter-goals")
def chapter_goals(chapter: str, _auth: None = Depends(_require_api_auth)) -> Dict[str, object]:
    chapter = (chapter or "").strip()
    if not chapter:
        raise HTTPException(status_code=400, detail="Chapter is required.")
    if not SUPABASE:
        raise HTTPException(status_code=503, detail=SUPABASE_REQUIRED_DETAIL)

    try:
        goals = _chapter_yearly_goals(chapter)
    except SupabaseError as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Unable to load chapter yearly goals from Supabase: {exc}",
        ) from exc

    return {
        "status": "ok",
        "chapter": chapter,
        "chapter_slug": slugify(chapter),
        "yearly_goals": _public_yearly_goals_payload(goals),
    }


@app.post("/api/chapter-goals/change")
def change_chapter_goals(
    payload: ChapterGoalsUpdatePayload,
    _auth: None = Depends(_require_api_auth),
) -> Dict[str, object]:
    chapter = (payload.chapter or "").strip()
    current_pin = (payload.current_pin or "").strip()
    if not chapter:
        raise HTTPException(status_code=400, detail="Chapter is required.")
    if not SUPABASE:
        raise HTTPException(status_code=503, detail=SUPABASE_REQUIRED_DETAIL)
    if not current_pin:
        raise HTTPException(status_code=400, detail="Current PIN is required.")

    goals: Dict[str, float] = {
        "visitors": float(payload.visitors),
        "one_to_ones": float(payload.one_to_ones),
        "referrals": float(payload.referrals),
        "ceu": float(payload.ceu),
        "tyfcb": float(payload.tyfcb),
    }
    _validate_yearly_goals_input(goals)

    try:
        expected_pin = _expected_chapter_upload_pin(chapter)
    except SupabaseError as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Unable to verify current chapter PIN from Supabase: {exc}",
        ) from exc
    if not hmac.compare_digest(current_pin, expected_pin):
        raise HTTPException(status_code=403, detail="Current PIN is incorrect.")

    try:
        _set_chapter_yearly_goals(chapter, goals)
    except SupabaseError as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Unable to save chapter yearly goals to Supabase: {exc}",
        ) from exc

    return {
        "status": "ok",
        "chapter": chapter,
        "chapter_slug": slugify(chapter),
        "yearly_goals": _public_yearly_goals_payload(goals),
    }


@app.get("/api/chapters")
def chapters(_auth: None = Depends(_require_api_auth)) -> List[str]:
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
def analytics(chapter: str, _auth: None = Depends(_require_api_auth)) -> Dict[str, object]:
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
    _auth: None = Depends(_require_api_auth),
    chapter: str = Form(...),
    report_type: str = Form(...),
    chapter_pin: str = Form(...),
    file: UploadFile = File(...),
):
    chapter = (chapter or "").strip()
    report_type = (report_type or "").strip().lower()
    chapter_pin = (chapter_pin or "").strip()

    if not chapter:
        raise HTTPException(status_code=400, detail="Chapter is required.")

    if report_type not in {"weekly", "ytd", "traffic"}:
        raise HTTPException(status_code=400, detail="Invalid report type.")
    if not SUPABASE:
        raise HTTPException(status_code=503, detail=SUPABASE_REQUIRED_DETAIL)
    if not chapter_pin:
        raise HTTPException(status_code=400, detail="Chapter PIN is required.")
    try:
        expected_pin = _expected_chapter_upload_pin(chapter)
    except SupabaseError as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Unable to verify chapter PIN from Supabase: {exc}",
        ) from exc
    if not hmac.compare_digest(chapter_pin, expected_pin):
        raise HTTPException(status_code=403, detail="Invalid chapter PIN.")

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

        if not rows:
            raise HTTPException(
                status_code=400,
                detail=(
                    "No traffic-light member rows were detected in this PDF. "
                    "Upload a BNI Traffic Lights report PDF."
                ),
            )

        parsed_rows = rows
        chapters_detected = sorted(
            {
                str(row.get("Chapter", "")).strip()
                for row in rows
                if str(row.get("Chapter", "")).strip()
            }
        )
        validation = {
            "kind": "traffic_lights_pdf",
            "rows_parsed": len(rows),
            "columns_loaded": ["Chapter", "First Name", "Last Name", "Score"],
            "chapters_detected": chapters_detected,
            "chapters_detected_count": len(chapters_detected),
            "score_average": (
                _round_total(
                    sum(_as_number(row.get("Score", row.get("Points"))) for row in rows)
                    / len(rows)
                )
                if rows
                else 0
            ),
            "score_max": (
                _round_total(
                    max(_as_number(row.get("Score", row.get("Points"))) for row in rows)
                )
                if rows
                else 0
            ),
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
    _auth: None = Depends(_require_api_auth),
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
