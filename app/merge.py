import re
from typing import Dict, Iterable, List

from .parsers import TL_COLUMNS


def _clean_last_name(last: str) -> str:
    cleaned = re.sub(r"\bNMLS\b.*$", "", last, flags=re.IGNORECASE).strip()
    cleaned = re.sub(r"[^A-Za-z0-9 ]", "", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned


def normalize_name(first: str, last: str) -> str:
    first = (first or "").strip()
    last = _clean_last_name(last or "")
    combined = f"{first} {last}".strip().lower()
    combined = re.sub(r"[^a-z0-9]", "", combined)
    return combined


def member_key(first: str, last: str) -> str:
    first_clean = re.sub(r"[^A-Za-z0-9]", "", (first or "").strip())
    last_clean = _clean_last_name(last or "")
    last_clean = re.sub(r"[^A-Za-z0-9]", "", last_clean)
    if first_clean and last_clean:
        return f"{first_clean}_{last_clean}"
    return first_clean or last_clean or ""


def index_rows(rows: Iterable[Dict[str, object]]) -> Dict[str, Dict[str, object]]:
    index: Dict[str, Dict[str, object]] = {}
    for row in rows:
        key = normalize_name(
            str(row.get("First Name", "")),
            str(row.get("Last Name", "")),
        )
        if not key:
            continue
        if key not in index:
            index[key] = row
    return index


def merge_reports(
    chapter: str,
    weekly_rows: List[Dict[str, object]],
    ytd_rows: List[Dict[str, object]],
    traffic_rows: List[Dict[str, object]],
) -> List[Dict[str, object]]:
    weekly_idx = index_rows(weekly_rows)
    ytd_idx = index_rows(ytd_rows)
    traffic_idx = index_rows(traffic_rows)

    weekly_cols = [
        c for c in (weekly_rows[0].keys() if weekly_rows else []) if c not in {"First Name", "Last Name"}
    ]
    ytd_cols = [
        c for c in (ytd_rows[0].keys() if ytd_rows else []) if c not in {"First Name", "Last Name"}
    ]

    keys = sorted(set(weekly_idx) | set(ytd_idx) | set(traffic_idx))
    merged: List[Dict[str, object]] = []

    for key in keys:
        base = weekly_idx.get(key) or ytd_idx.get(key) or traffic_idx.get(key) or {}
        first = str(base.get("First Name", "")).strip()
        last = str(base.get("Last Name", "")).strip()

        row: Dict[str, object] = {
            "MemberKey": member_key(first, last),
            "Chapter": chapter,
            "First Name": first,
            "Last Name": last,
        }

        for col in weekly_cols:
            row[f"Weekly_{col}"] = weekly_idx.get(key, {}).get(col, "")
        for col in ytd_cols:
            row[f"YTD_{col}"] = ytd_idx.get(key, {}).get(col, "")
        for col in TL_COLUMNS:
            row[f"TL_{col}"] = traffic_idx.get(key, {}).get(col, "")

        merged.append(row)

    return merged
