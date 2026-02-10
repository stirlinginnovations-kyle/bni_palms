import re
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Dict, List

from PyPDF2 import PdfReader

SPREADSHEET_NS = {"ss": "urn:schemas-microsoft-com:office:spreadsheet"}


def _row_values(row: ET.Element) -> List[str]:
    values: List[str] = []
    col_idx = 1
    for cell in row.findall("ss:Cell", SPREADSHEET_NS):
        idx = cell.get("{urn:schemas-microsoft-com:office:spreadsheet}Index")
        if idx:
            idx_int = int(idx)
            while col_idx < idx_int:
                values.append("")
                col_idx += 1
        data = cell.find("ss:Data", SPREADSHEET_NS)
        values.append(data.text if data is not None else "")
        col_idx += 1
    return values


def _parse_value(value: str):
    if value is None:
        return ""
    text = str(value).strip()
    if text == "":
        return ""
    if text.endswith("%"):
        num = text[:-1].strip()
        try:
            return float(num)
        except ValueError:
            return text
    cleaned = text.replace(",", "")
    if re.fullmatch(r"\d+", cleaned):
        try:
            return int(cleaned)
        except ValueError:
            return text
    if re.fullmatch(r"\d*\.\d+", cleaned):
        try:
            return float(cleaned)
        except ValueError:
            return text
    return text


def parse_spreadsheetml_xls(path: Path) -> List[Dict[str, object]]:
    tree = ET.parse(path)
    root = tree.getroot()
    worksheet = root.find("ss:Worksheet", SPREADSHEET_NS)
    if worksheet is None:
        return []
    table = worksheet.find("ss:Table", SPREADSHEET_NS)
    if table is None:
        return []

    rows = table.findall("ss:Row", SPREADSHEET_NS)
    header: List[str] = []
    data_rows: List[Dict[str, object]] = []

    for row in rows:
        values = _row_values(row)
        if not header:
            if "First Name" in values and "Last Name" in values:
                header = [v.strip() if v else "" for v in values]
            continue

        if not any(v not in ("", None) for v in values):
            continue

        first_cell = (values[0] or "").strip()
        if first_cell in {"Visitors", "BNI", "Total"}:
            break

        row_dict: Dict[str, object] = {}
        for idx, col in enumerate(header):
            if not col:
                continue
            cell_value = values[idx] if idx < len(values) else ""
            if col in {"First Name", "Last Name"}:
                row_dict[col] = str(cell_value).strip()
            else:
                row_dict[col] = _parse_value(cell_value)
        data_rows.append(row_dict)

    return data_rows


TL_COLUMNS = [
    "S",
    "ML",
    "A",
    "P",
    "Wks",
    "TYFCB",
    "CEUs",
    "Points",
    "Given",
    "Recd",
    "121",
    "Vis",
    "Referrals",
    "AttendancePct",
    "Attendance",
    "ReferralsPts",
    "ReferralsAPW",
    "CEUsPts",
    "CEUsAPW",
    "121Pts",
    "121APW",
    "VisitorsPts",
    "VisitorsAPW",
]


def parse_traffic_lights_pdf(path: Path) -> List[Dict[str, object]]:
    reader = PdfReader(str(path))
    rows: List[Dict[str, object]] = []

    num_re = re.compile(r"^\d[\d,]*$")
    dec_re = re.compile(r"^\d*\.\d+$")
    pct_re = re.compile(r"^\d+%$")

    def is_num(tok: str) -> bool:
        return bool(num_re.match(tok) or dec_re.match(tok) or pct_re.match(tok))

    for page in reader.pages:
        text = page.extract_text() or ""
        lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
        if not lines:
            continue

        header = lines[0]
        m = re.search(r"[A-Z]{2} .+? Region for", header)
        if m:
            chapter = header[: m.start()].strip()
        else:
            chapter = header.split("Region for")[0].strip()

        try:
            start = next(i for i, l in enumerate(lines) if l.startswith("Launched"))
        except StopIteration:
            start = 0

        for line in lines[start + 1 :]:
            if (
                "Chapter Totals" in line
                or line.startswith("Designed and produced")
                or line.startswith("To protect")
                or "Personal Data" in line
            ):
                break
            if "," not in line:
                continue

            tokens = line.split()
            num_tokens: List[str] = []
            i = len(tokens) - 1
            while i >= 0 and len(num_tokens) < 23:
                tok = tokens[i]
                if is_num(tok):
                    num_tokens.append(tok)
                    i -= 1
                else:
                    break

            if len(num_tokens) != 23:
                continue

            name_tokens = tokens[: i + 1]
            name = " ".join(name_tokens)
            if "," in name:
                last, first = name.split(",", 1)
                last = last.strip()
                first = first.strip()
            else:
                last = name.strip()
                first = ""

            nums = list(reversed(num_tokens))
            row: Dict[str, object] = {
                "Chapter": chapter,
                "First Name": first,
                "Last Name": last,
            }
            for col, val in zip(TL_COLUMNS, nums):
                row[col] = _parse_value(val)
            rows.append(row)

    return rows
