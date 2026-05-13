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
const TL_SCORE_INDEX_VISUAL = 0;
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

function summaryMetricsFromRow(row) {
  if (!row || typeof row !== "object") {
    return null;
  }
  return {
    v: roundTotal(asNumber(row?.V)),
    one_to_ones: roundTotal(asNumber(row?.["1-2-1"])),
    tyfcb: roundTotal(asNumber(row?.TYFCB)),
    ceu: roundTotal(asNumber(row?.CEU)),
    referrals_total: roundTotal(asNumber(row?.[REFERRALS_TOTAL_COLUMN])),
  };
}

export function extractChapterSpreadsheetSummaryMetrics(buffer) {
  const workbook = XLSX.read(buffer, {
    type: "buffer",
    raw: true,
    cellDates: false,
    dense: false,
  });
  const firstSheetName = workbook.SheetNames?.[0];
  if (!firstSheetName) {
    return null;
  }

  const sheet = workbook.Sheets[firstSheetName];
  if (!sheet) {
    return null;
  }

  const rows = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    raw: true,
    defval: "",
    blankrows: false,
  });
  if (!Array.isArray(rows) || rows.length < SPREADSHEET_TABLE_START_ROW) {
    return null;
  }

  const headerRow = rows[SPREADSHEET_TABLE_START_ROW - 1] || [];
  const header = headerRow.map((value) => String(value ?? "").trim());
  if (!header.includes("First Name") || !header.includes("Last Name")) {
    return null;
  }

  for (let rowIndex = SPREADSHEET_TABLE_START_ROW; rowIndex < rows.length; rowIndex += 1) {
    const values = Array.isArray(rows[rowIndex]) ? rows[rowIndex] : [];
    const hasContent = values.some((value) => value !== "" && value !== null && value !== undefined);
    if (!hasContent) {
      continue;
    }

    const firstCell = String(values[0] ?? "").trim();
    if (firstCell !== "Total") {
      continue;
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
    return summaryMetricsFromRow(row);
  }

  return null;
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
  const candidates = [
    TL_SCORE_INDEX_VISUAL,
    TL_POINTS_INDEX_CURRENT,
    TL_POINTS_INDEX_LEGACY,
  ];
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

async function renderTrafficPdfPage(pageData) {
  const textContent = await pageData.getTextContent({
    normalizeWhitespace: false,
    disableCombineTextItems: true,
  });
  const rowMap = new Map();

  for (const item of textContent.items || []) {
    const text = String(item?.str || "").trim();
    if (!text) {
      continue;
    }
    const x = Number(item?.transform?.[4] || 0);
    const y = Number(item?.transform?.[5] || 0);
    const yKey = String(Math.round(y * 10) / 10);
    if (!rowMap.has(yKey)) {
      rowMap.set(yKey, { y, items: [] });
    }
    rowMap.get(yKey).items.push({ x, text });
  }

  return Array.from(rowMap.values())
    .sort((a, b) => b.y - a.y)
    .map((row) =>
      row.items
        .sort((a, b) => a.x - b.x)
        .map((item) => item.text)
        .join(" "),
    )
    .join("\n");
}

export async function parseTrafficLightsPdf(buffer) {
  const parsed = await pdfParse(buffer, { pagerender: renderTrafficPdfPage });
  const rawText = String(parsed?.text || "");
  const lines = rawText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => Boolean(line));

  const memberRows = [];
  const numericRows = [];

  let chapter = "";
  let previousLine = "";
  let inMemberRows = false;
  let useNextLineAsChapter = false;

  for (const line of lines) {
    if (useNextLineAsChapter) {
      chapter = line;
      useNextLineAsChapter = false;
      previousLine = line;
      continue;
    }

    if (line.includes("Region for")) {
      const chapterMatch = line.match(/[A-Z]{2} .+? Region for/);
      const detectedChapter = chapterMatch
        ? line.slice(0, chapterMatch.index).trim()
        : previousLine.trim();
      if (detectedChapter && detectedChapter !== "Traffic Lights") {
        chapter = detectedChapter;
      } else {
        useNextLineAsChapter = true;
      }
      inMemberRows = false;
      previousLine = line;
      continue;
    }

    if (line.startsWith("Launched")) {
      inMemberRows = true;
      previousLine = line;
      continue;
    }

    if (
      line.includes("Chapter Totals") ||
      line.startsWith("Designed and produced") ||
      line.startsWith("To protect") ||
      line.includes("Personal Data") ||
      line.startsWith("Page ")
    ) {
      inMemberRows = false;
      previousLine = line;
      continue;
    }

    if (!inMemberRows || !line.includes(",")) {
      previousLine = line;
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
      previousLine = line;
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
    previousLine = line;
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
