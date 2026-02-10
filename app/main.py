import json
import re
from datetime import datetime
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import List

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from openpyxl import Workbook

from .merge import merge_reports
from .parsers import parse_spreadsheetml_xls, parse_traffic_lights_pdf

APP_ROOT = Path(__file__).resolve().parent.parent
STATIC_DIR = APP_ROOT / "static"
CHAPTERS_FILE = APP_ROOT / "chapters.json"
UPLOADS_DIR = APP_ROOT / "uploads"

app = FastAPI()
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


def load_chapters() -> List[str]:
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


def safe_filename(name: str) -> str:
    name = re.sub(r"[^a-zA-Z0-9._-]+", "_", name)
    return name.strip("._") or "upload"


async def save_upload(upload: UploadFile, path: Path) -> None:
    content = await upload.read()
    path.write_bytes(content)


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

    safe_name = safe_filename(Path(file.filename).stem)
    target_path = target_dir / f"{timestamp}_{safe_name}{ext}"
    await save_upload(file, target_path)

    return {"status": "ok", "path": str(target_path)}


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
