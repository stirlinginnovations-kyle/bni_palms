import XLSX from "xlsx";
import pdfParse from "pdf-parse";

import {
  REFERRALS_TOTAL_COLUMN,
  REFERRAL_COLUMNS,
  SPREADSHEET_TABLE_START_ROW,
  asNumber,
  roundTotal,
} from "./common.mjs";

export const TL_COLUMNS = [
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
];

const TL_POINTS_INDEX_LEGACY = TL_COLUMNS.indexOf("Points");
const TL_POINTS_INDEX_CURRENT = 4;
const TL_EXPECTED_NUMERIC_FIELDS = 23;

export function parseValue(value) {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : "";
  }
  if (typeof value === "boolean") {
    return value;
  }

  const text = String(value).trim();
  if (!text) {
    return "";
  }

  if (text.endsWith("%")) {
    const numberText = text.slice(0, -1).trim();
    const n = Number(numberText);
    return Number.isFinite(n) ? n : text;
  }

  const cleaned = text.replace(/,/g, "");
  if (/^\d+$/.test(cleaned)) {
    const n = Number.parseInt(cleaned, 10);
    return Number.isFinite(n) ? n : text;
  }
  if (/^\d*\.\d+$/.test(cleaned)) {
    const n = Number.parseFloat(cleaned);
    return Number.isFinite(n) ? n : text;
  }

  return text;
}

function rowReferralsTotal(row) {
  let total = 0;
  for (const col of REFERRAL_COLUMNS) {
    total += asNumber(row?.[col]);
  }
  return roundTotal(total);
}

function parseExcelCell(value) {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  return parseValue(String(value));
}

export function parseChapterSpreadsheet(buffer) {
  const workbook = XLSX.read(buffer, {
    type: "buffer",
    raw: true,
    cellDates: false,
    dense: false,
  });
  const firstSheetName = workbook.SheetNames?.[0];
  if (!firstSheetName) {
    return [];
  }

  const sheet = workbook.Sheets[firstSheetName];
  if (!sheet) {
    return [];
  }

  const rows = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    raw: true,
    defval: "",
    blankrows: false,
  });
  if (!Array.isArray(rows) || rows.length < SPREADSHEET_TABLE_START_ROW) {
    return [];
  }

  const headerRow = rows[SPREADSHEET_TABLE_START_ROW - 1] || [];
  const header = headerRow.map((value) => String(value ?? "").trim());
  if (!header.includes("First Name") || !header.includes("Last Name")) {
    return [];
  }

  const output = [];
  for (let rowIndex = SPREADSHEET_TABLE_START_ROW; rowIndex < rows.length; rowIndex += 1) {
    const values = Array.isArray(rows[rowIndex]) ? rows[rowIndex] : [];
    const hasContent = values.some((value) => value !== "" && value !== null && value !== undefined);
    if (!hasContent) {
      continue;
    }

    const firstCell = String(values[0] ?? "").trim();
    if (firstCell === "Visitors" || firstCell === "BNI" || firstCell === "Total") {
      break;
    }

    const row = {};
    for (let idx = 0; idx < header.length; idx += 1) {
      const col = header[idx];
      if (!col) {
        continue;
      }
      const cellValue = idx < values.length ? values[idx] : "";
      if (col === "First Name" || col === "Last Name") {
        row[col] = String(cellValue ?? "").trim();
      } else {
        row[col] = parseExcelCell(cellValue);
      }
    }
    row[REFERRALS_TOTAL_COLUMN] = rowReferralsTotal(row);
    output.push(row);
  }

  return output;
}

function trafficNumericValue(token) {
  const value = parseValue(token);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function percentile(values, pct) {
  if (!values.length) {
    return 0;
  }
  const ordered = [...values].sort((a, b) => a - b);
  const idx = Math.floor((ordered.length - 1) * pct);
  return ordered[idx];
}

function selectTrafficPointsIndex(numericRows) {
  const candidates = [TL_POINTS_INDEX_CURRENT, TL_POINTS_INDEX_LEGACY];
  let bestIndex = TL_POINTS_INDEX_CURRENT;
  let bestRatio = -1;
  let bestP90 = -1;

  for (const idx of candidates) {
    const values = [];
    for (const nums of numericRows) {
      if (idx >= nums.length) {
        continue;
      }
      const number = trafficNumericValue(nums[idx]);
      if (number !== null) {
        values.push(number);
      }
    }
    if (!values.length) {
      continue;
    }

    const inRange = values.filter((v) => v >= 0 && v <= 120);
    const ratio = inRange.length / values.length;
    const p90 = percentile(inRange.length ? inRange : values, 0.9);

    if (ratio > bestRatio || (ratio === bestRatio && p90 > bestP90)) {
      bestRatio = ratio;
      bestP90 = p90;
      bestIndex = idx;
    }
  }

  return bestIndex;
}

function isNumericToken(token) {
  const text = String(token || "").trim();
  return /^\d[\d,]*$/.test(text) || /^\d*\.\d+$/.test(text) || /^\d+%$/.test(text);
}

export async function parseTrafficLightsPdf(buffer) {
  const parsed = await pdfParse(buffer);
  const rawText = String(parsed?.text || "");
  const pageTexts = rawText.includes("\f") ? rawText.split("\f") : [rawText];

  const memberRows = [];
  const numericRows = [];

  for (const pageText of pageTexts) {
    const lines = String(pageText || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => Boolean(line));
    if (!lines.length) {
      continue;
    }

    const header = lines[0];
    const chapterMatch = header.match(/[A-Z]{2} .+? Region for/);
    const chapter = chapterMatch
      ? header.slice(0, chapterMatch.index).trim()
      : header.split("Region for")[0].trim();

    let start = 0;
    const launchedIndex = lines.findIndex((line) => line.startsWith("Launched"));
    if (launchedIndex >= 0) {
      start = launchedIndex;
    }

    for (const line of lines.slice(start + 1)) {
      if (
        line.includes("Chapter Totals") ||
        line.startsWith("Designed and produced") ||
        line.startsWith("To protect") ||
        line.includes("Personal Data")
      ) {
        break;
      }
      if (!line.includes(",")) {
        continue;
      }

      const tokens = line.split(/\s+/);
      const numTokens = [];
      for (let idx = tokens.length - 1; idx >= 0; idx -= 1) {
        const token = tokens[idx];
        if (!isNumericToken(token)) {
          break;
        }
        numTokens.push(token);
      }

      if (numTokens.length < TL_EXPECTED_NUMERIC_FIELDS) {
        continue;
      }

      const trimmedNumTokens = numTokens.slice(0, TL_EXPECTED_NUMERIC_FIELDS);
      const nums = [...trimmedNumTokens].reverse();
      const nameTokens = tokens.slice(0, tokens.length - TL_EXPECTED_NUMERIC_FIELDS);
      const name = nameTokens.join(" ");
      let first = "";
      let last = "";
      if (name.includes(",")) {
        const split = name.split(",", 2);
        last = String(split[0] || "").trim();
        first = String(split[1] || "").trim();
      } else {
        last = name.trim();
      }

      memberRows.push({ chapter, first, last, nums });
      numericRows.push(nums);
    }
  }

  const pointsIndex = selectTrafficPointsIndex(numericRows);
  const output = [];
  for (const row of memberRows) {
    if (pointsIndex >= row.nums.length) {
      continue;
    }
    const scoreValue = parseValue(row.nums[pointsIndex]);
    output.push({
      Chapter: row.chapter,
      "First Name": row.first,
      "Last Name": row.last,
      Score: scoreValue,
      Points: scoreValue,
    });
  }
  return output;
}

