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
    parse_spreadsheetml_xls,
    parse_traffic_lights_pdf,
    tally_referral_columns,
)
from .supabase_client import SupabaseClient, SupabaseError

APP_ROOT = Path(__file__).resolve().parent.parent
STATIC_DIR = APP_ROOT / "static"
CHAPTERS_FILE = APP_ROOT / "chapters.json"
UPLOADS_DIR = APP_ROOT / "uploads"
SUPABASE = SupabaseClient.from_env()

app = FastAPI()
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


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
    file_chapters = load_chapters_file()
    if not SUPABASE:
        return file_chapters
    try:
        db_chapters = SUPABASE.list_active_chapters()
        if db_chapters:
            return db_chapters
        for chapter in file_chapters:
            SUPABASE.upsert_chapter(name=chapter, slug=slugify(chapter))
        return sorted(file_chapters)
    except SupabaseError:
        return file_chapters


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
) -> Optional[Dict[str, object]]:
    if not SUPABASE:
        return None

    content_type = _upload_content_type(upload, report_type)
    safe_original_name = safe_filename(upload.filename or "upload")

    if report_type in {"weekly", "ytd"}:
        chapter_row = SUPABASE.upsert_chapter(name=chapter, slug=chapter_slug)
        current_path = f"chapters/{chapter_slug}/{report_type}.xls"
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


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/chapters")
def chapters() -> List[str]:
    return load_chapters()


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

    if not file.filename:
        raise HTTPException(status_code=400, detail="Missing file.")

    ext = Path(file.filename).suffix.lower()
    if report_type in {"weekly", "ytd"} and ext != ".xls":
        raise HTTPException(status_code=400, detail="Weekly/YTD must be .xls.")
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
            rows = parse_spreadsheetml_xls(target_path)
        except Exception as exc:
            raise HTTPException(
                status_code=400,
                detail=f"Unable to parse {report_type.upper()} SpreadsheetML report.",
            ) from exc

        parsed_rows = rows
        columns_loaded = _extract_columns(rows)
        referral_tally = tally_referral_columns(rows)
        referral_total = _round_total(
            sum(float(referral_tally[col]) for col in REFERRAL_COLUMNS)
        )

        validation = {
            "kind": "spreadsheetml_xls",
            "rows_parsed": len(rows),
            "columns_loaded": columns_loaded,
            "table_start_row": SPREADSHEET_TABLE_START_ROW,
            "referral_columns": list(REFERRAL_COLUMNS),
            "row_referrals_total_column": REFERRALS_TOTAL_COLUMN,
            "referral_tally": referral_tally,
            "referrals_total": referral_total,
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

    supabase_result = None
    if SUPABASE:
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
        "storage_backend": "supabase" if supabase_result else "local",
    }
    if supabase_result:
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

        weekly_rows = parse_spreadsheetml_xls(weekly_path)
        ytd_rows = parse_spreadsheetml_xls(ytd_path)
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
