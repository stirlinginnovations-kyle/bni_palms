import path from "node:path";

import {
  AUTH_PASSWORDS,
  CHAPTER_PIN_MAX_LENGTH,
  CHAPTER_PIN_MIN_LENGTH,
  CHAPTER_UPLOAD_PINS,
  DEFAULT_CHAPTER_UPLOAD_PIN,
  DEFAULT_TRAFFIC_UPLOAD_PIN,
  REFERRAL_COLUMNS,
  REFERRALS_TOTAL_COLUMN,
  SPREADSHEET_TABLE_START_ROW,
  SUPABASE_REQUIRED_DETAIL,
  TRAFFIC_UPLOAD_PIN_SLUG,
  asNumber,
  buildAuthCookieHeader,
  buildDeleteAuthCookieHeader,
  extractColumns,
  inferTrafficReportMonth,
  isAuthenticated,
  jsonResponse,
  nullableNumber,
  normalizeNextPath,
  roundTotal,
  safeFilename,
  sampleMembers,
  secureCompare,
  slugify,
  tallyReferralColumns,
} from "./_lib/common.mjs";
import {
  buildAnalyticsPayload,
  defaultYearlyGoals,
  normalizeMemberRows,
  normalizeTrafficRows,
  publicYearlyGoalsPayload,
  validateYearlyGoalsInput,
} from "./_lib/analytics.mjs";
import {
  extractChapterSpreadsheetSummaryMetrics,
  parseChapterSpreadsheet,
  parseTrafficLightsPdf,
} from "./_lib/parsers.mjs";
import { SupabaseClient, SupabaseError } from "./_lib/supabase.mjs";

const SUPABASE = SupabaseClient.fromEnv();

function getRoutePath(pathname) {
  if (pathname.startsWith("/api/")) {
    return pathname.slice("/api/".length);
  }
  if (pathname === "/api") {
    return "";
  }
  if (pathname.startsWith("/.netlify/functions/api/")) {
    return pathname.slice("/.netlify/functions/api/".length);
  }
  if (pathname === "/.netlify/functions/api") {
    return "";
  }
  return "";
}

function requireAuth(request) {
  if (!isAuthenticated(request)) {
    return jsonResponse(401, { detail: "Login required." });
  }
  return null;
}

function supabaseOr503() {
  if (!SUPABASE) {
    return {
      error: jsonResponse(503, { detail: SUPABASE_REQUIRED_DETAIL }),
      client: null,
    };
  }
  return { error: null, client: SUPABASE };
}

function passwordMatches(candidate) {
  const text = String(candidate || "").trim();
  if (!text) {
    return false;
  }
  return AUTH_PASSWORDS.some((configured) => secureCompare(text, configured));
}

function memberKey(first, last) {
  const firstClean = String(first || "").replace(/[^A-Za-z0-9]/g, "").trim();
  const cleanedLast = String(last || "")
    .replace(/\bNMLS\b.*$/i, "")
    .replace(/[^A-Za-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[^A-Za-z0-9]/g, "");
  if (firstClean && cleanedLast) {
    return `${firstClean}_${cleanedLast}`;
  }
  return firstClean || cleanedLast || "";
}

async function expectedChapterUploadPin(chapter) {
  const chapterKey = slugify(chapter);
  let supabasePin = null;
  if (SUPABASE) {
    try {
      supabasePin = await SUPABASE.getChapterUploadPin({ chapterSlug: chapterKey });
    } catch (error) {
      if (!String(error || "").includes("chapter_upload_pins")) {
        throw error;
      }
    }
  }
  return supabasePin || CHAPTER_UPLOAD_PINS[chapterKey] || DEFAULT_CHAPTER_UPLOAD_PIN;
}

async function expectedTrafficUploadPin() {
  let supabasePin = null;
  if (SUPABASE) {
    try {
      supabasePin = await SUPABASE.getChapterUploadPin({
        chapterSlug: TRAFFIC_UPLOAD_PIN_SLUG,
      });
    } catch (error) {
      if (!String(error || "").includes("chapter_upload_pins")) {
        throw error;
      }
    }
  }
  return (
    supabasePin ||
    CHAPTER_UPLOAD_PINS[TRAFFIC_UPLOAD_PIN_SLUG] ||
    DEFAULT_TRAFFIC_UPLOAD_PIN
  );
}

async function chapterYearlyGoals(chapter) {
  const goals = defaultYearlyGoals();
  if (!SUPABASE) {
    return goals;
  }

  const chapterSlug = slugify(chapter);
  let row = null;
  try {
    row = await SUPABASE.getChapterYearlyGoals({ chapterSlug });
  } catch (error) {
    if (String(error || "").includes("chapter_yearly_goals")) {
      return goals;
    }
    throw error;
  }

  if (!row || typeof row !== "object") {
    return goals;
  }

  for (const key of ["visitors", "one_to_ones", "referrals", "ceu", "tyfcb"]) {
    const n = Number(row[key]);
    if (Number.isFinite(n)) {
      goals[key] = n;
    }
  }
  return goals;
}

function uploadContentType(file, reportType) {
  const guessed = String(file?.type || "").trim();
  if (guessed) {
    return guessed;
  }
  if (reportType === "traffic") {
    return "application/pdf";
  }
  const ext = path.extname(String(file?.name || "")).toLowerCase();
  if (ext === ".xlsx") {
    return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  }
  return "application/vnd.ms-excel";
}

function compactUtcTimestamp() {
  const now = new Date();
  const y = String(now.getUTCFullYear());
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  const hh = String(now.getUTCHours()).padStart(2, "0");
  const mm = String(now.getUTCMinutes()).padStart(2, "0");
  const ss = String(now.getUTCSeconds()).padStart(2, "0");
  return `${y}${m}${d}_${hh}${mm}${ss}`;
}

async function persistUploadToSupabase({
  chapter,
  chapterSlug,
  reportType,
  timestamp,
  file,
  content,
  validation,
  parsedRows,
}) {
  if (!SUPABASE) {
    throw new SupabaseError("Supabase is not configured.");
  }

  const contentType = uploadContentType(file, reportType);
  const safeOriginalName = safeFilename(file?.name || "upload");

  if (reportType === "weekly" || reportType === "ytd") {
    const chapterRow = await SUPABASE.upsertChapter({
      name: chapter,
      slug: chapterSlug,
    });
    const chapterId = String(chapterRow.id);
    const priorUploads = await SUPABASE.listChapterReportUploads({
      chapterId,
      reportType,
    });

    let chapterExt = path.extname(safeOriginalName).toLowerCase();
    if (chapterExt !== ".xls" && chapterExt !== ".xlsx") {
      chapterExt = ".xls";
    }
    const currentPath = `chapters/${chapterSlug}/${reportType}${chapterExt}`;
    const archivePath = `chapters/${chapterSlug}/archive/${reportType}/${timestamp}_${safeOriginalName}`;

    await SUPABASE.uploadObject({
      objectPath: currentPath,
      content,
      contentType,
      upsert: true,
    });
    await SUPABASE.uploadObject({
      objectPath: archivePath,
      content,
      contentType,
      upsert: false,
    });

    const uploadRow = await SUPABASE.insertChapterReportUpload({
      chapter_id: chapterRow.id,
      report_type: reportType,
      original_filename: file?.name,
      storage_bucket: SUPABASE.config.bucket,
      storage_path: archivePath,
      file_size_bytes: content.length,
      mime_type: contentType,
      validation: validation || {},
    });
    const uploadId = Number(uploadRow.id);

    const memberRowsPayload = [];
    for (const row of parsedRows || []) {
      const first = String(row?.["First Name"] || "").trim();
      const last = String(row?.["Last Name"] || "").trim();
      memberRowsPayload.push({
        upload_id: uploadId,
        chapter_id: chapterRow.id,
        report_type: reportType,
        first_name: first,
        last_name: last,
        member_key: memberKey(first, last),
        p: nullableNumber(row?.P),
        a: nullableNumber(row?.A),
        l: nullableNumber(row?.L),
        m: nullableNumber(row?.M),
        s: nullableNumber(row?.S),
        rgi: nullableNumber(row?.RGI),
        rgo: nullableNumber(row?.RGO),
        rri: nullableNumber(row?.RRI),
        rro: nullableNumber(row?.RRO),
        v: nullableNumber(row?.V),
        one_to_one: nullableNumber(row?.["1-2-1"]),
        tyfcb: nullableNumber(row?.TYFCB),
        ceu: nullableNumber(row?.CEU),
        referrals_total: nullableNumber(row?.[REFERRALS_TOTAL_COLUMN]) || 0,
        raw: row,
      });
    }
    const inserted = await SUPABASE.insertChapterReportMemberRows(memberRowsPayload);

    await SUPABASE.deleteChapterReportUploadsExcept({
      chapterId,
      reportType,
      keepUploadId: uploadId,
    });

    for (const prior of priorUploads || []) {
      const priorPath = String(prior?.storage_path || "").trim();
      if (priorPath && priorPath !== archivePath) {
        await SUPABASE.deleteObject({ objectPath: priorPath });
      }
    }

    for (const ext of [".xls", ".xlsx"]) {
      const previousCurrent = `chapters/${chapterSlug}/${reportType}${ext}`;
      if (previousCurrent !== currentPath) {
        await SUPABASE.deleteObject({ objectPath: previousCurrent });
      }
    }

    return {
      table: "chapter_report_uploads",
      record_id: uploadId,
      current_storage_path: currentPath,
      archive_storage_path: archivePath,
      parsed_member_rows_inserted: inserted,
    };
  }

  const reportMonth = inferTrafficReportMonth(file?.name || "");
  const monthKey = reportMonth.slice(0, 7);
  const currentPath = `traffic_lights/${monthKey}/traffic.pdf`;
  const archivePath = `traffic_lights/archive/${monthKey}/${timestamp}_${safeOriginalName}`;

  await SUPABASE.uploadObject({
    objectPath: currentPath,
    content,
    contentType,
    upsert: true,
  });
  await SUPABASE.uploadObject({
    objectPath: archivePath,
    content,
    contentType,
    upsert: false,
  });

  const uploadRow = await SUPABASE.upsertTrafficLightUpload({
    report_month: reportMonth,
    original_filename: file?.name,
    storage_bucket: SUPABASE.config.bucket,
    storage_path: currentPath,
    file_size_bytes: content.length,
    mime_type: contentType,
    validation: validation || {},
  });
  const trafficUploadId = Number(uploadRow.id);

  await SUPABASE.deleteTrafficLightMemberRows(trafficUploadId);
  const trafficRowsPayload = [];
  for (const row of parsedRows || []) {
    const chapterName = String(row?.Chapter || "").trim();
    const first = String(row?.["First Name"] || "").trim();
    const last = String(row?.["Last Name"] || "").trim();
    const score = nullableNumber(row?.Score ?? row?.Points);
    trafficRowsPayload.push({
      traffic_upload_id: trafficUploadId,
      report_month: reportMonth,
      chapter_name: chapterName,
      chapter_slug: slugify(chapterName),
      first_name: first,
      last_name: last,
      member_key: memberKey(first, last),
      referrals: score,
      raw: row,
    });
  }
  const inserted = await SUPABASE.insertTrafficLightMemberRows(trafficRowsPayload);

  return {
    table: "traffic_light_uploads",
    record_id: trafficUploadId,
    report_month: reportMonth,
    current_storage_path: currentPath,
    archive_storage_path: archivePath,
    parsed_member_rows_inserted: inserted,
  };
}

async function loadSupabaseAnalytics(chapter) {
  if (!SUPABASE) {
    throw new SupabaseError("Supabase is not configured.");
  }

  const chapterSlug = slugify(chapter);
  const chapterGoals = await chapterYearlyGoals(chapter);
  const chapterRow = await SUPABASE.getChapterBySlug(chapterSlug);
  if (!chapterRow) {
    return buildAnalyticsPayload({
      chapter,
      chapterSlug,
      source: "supabase",
      weeklyRows: [],
      ytdRows: [],
      trafficRows: [],
      weeklyUploadedAt: null,
      ytdUploadedAt: null,
      trafficUploadedAt: null,
      trafficReportMonth: null,
      yearlyGoals: chapterGoals,
    });
  }

  const chapterId = String(chapterRow.id);
  const weeklyUpload = await SUPABASE.getLatestChapterUpload({
    chapterId,
    reportType: "weekly",
  });
  const ytdUpload = await SUPABASE.getLatestChapterUpload({
    chapterId,
    reportType: "ytd",
  });
  const trafficUpload = await SUPABASE.getLatestNonemptyTrafficUpload();

  const weeklyRows = normalizeMemberRows(
    weeklyUpload
      ? await SUPABASE.getChapterMemberRowsForUpload(Number(weeklyUpload.id))
      : [],
  );
  const ytdRows = normalizeMemberRows(
    ytdUpload ? await SUPABASE.getChapterMemberRowsForUpload(Number(ytdUpload.id)) : [],
  );
  const trafficRows = normalizeTrafficRows(
    trafficUpload
      ? await SUPABASE.getTrafficRowsForUpload({
          trafficUploadId: Number(trafficUpload.id),
          chapterSlug,
        })
      : [],
  );

  return buildAnalyticsPayload({
    chapter: String(chapterRow.name || chapter),
    chapterSlug,
    source: "supabase",
    weeklyRows,
    ytdRows,
    weeklySummaryOverrides: summaryOverridesFromValidation(weeklyUpload?.validation),
    ytdSummaryOverrides: summaryOverridesFromValidation(ytdUpload?.validation),
    trafficRows,
    weeklyUploadedAt: weeklyUpload?.uploaded_at || null,
    ytdUploadedAt: ytdUpload?.uploaded_at || null,
    trafficUploadedAt: trafficUpload?.uploaded_at || null,
    trafficReportMonth: trafficUpload?.report_month || null,
    yearlyGoals: chapterGoals,
  });
}

function summaryOverridesFromValidation(validation) {
  const metrics = validation?.summary_row_metrics;
  if (!metrics || typeof metrics !== "object") {
    return null;
  }
  const overrides = {};
  const mapping = [
    ["visitors", "v"],
    ["ceu", "ceu"],
    ["one_to_ones", "one_to_ones"],
    ["referrals", "referrals_total"],
    ["tyfcb", "tyfcb"],
  ];
  for (const [targetKey, sourceKey] of mapping) {
    const value = nullableNumber(metrics?.[sourceKey]);
    if (value !== null) {
      overrides[targetKey] = value;
    }
  }
  return Object.keys(overrides).length ? overrides : null;
}

function parseNumericPin(pin) {
  return /^\d+$/.test(String(pin || "").trim());
}

function uploadResponsePath(chapterSlug, reportType, timestamp, fileName) {
  const ext = path.extname(fileName).toLowerCase();
  const stem = safeFilename(path.basename(fileName, ext));
  return `uploads/${chapterSlug}/${reportType}/${timestamp}_${stem}${ext}`;
}

async function parseJsonRequest(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function failure(status, detail) {
  return jsonResponse(status, { detail: String(detail || "Request failed.") });
}

export default async function handler(request) {
  const url = new URL(request.url);
  const route = getRoutePath(url.pathname);
  const method = request.method.toUpperCase();

  if (route === "login" && method === "POST") {
    const payload = await parseJsonRequest(request);
    const password = String(payload?.password || "").trim();
    if (!password) {
      return failure(400, "Password is required.");
    }
    if (!passwordMatches(password)) {
      return failure(401, "Invalid password.");
    }
    const next = normalizeNextPath(payload?.next);
    return jsonResponse(
      200,
      { status: "ok", next },
      {
        "set-cookie": buildAuthCookieHeader(),
      },
    );
  }

  if (route === "logout" && method === "POST") {
    return jsonResponse(
      200,
      { status: "ok" },
      {
        "set-cookie": buildDeleteAuthCookieHeader(),
      },
    );
  }

  if (route === "session" && method === "GET") {
    if (!isAuthenticated(request)) {
      return failure(401, "Login required.");
    }
    return jsonResponse(200, { status: "ok" });
  }

  const authFailure = requireAuth(request);
  if (authFailure) {
    return authFailure;
  }

  if (route === "chapters" && method === "GET") {
    const { error } = supabaseOr503();
    if (error) {
      return error;
    }
    try {
      const chapters = await SUPABASE.listActiveChapters();
      return jsonResponse(200, chapters);
    } catch (supabaseError) {
      return failure(502, `Failed to load chapters from Supabase: ${supabaseError}`);
    }
  }

  if (route === "analytics" && method === "GET") {
    const chapter = String(url.searchParams.get("chapter") || "").trim();
    if (!chapter) {
      return failure(400, "Chapter is required.");
    }
    const { error } = supabaseOr503();
    if (error) {
      return error;
    }
    try {
      return jsonResponse(200, await loadSupabaseAnalytics(chapter));
    } catch (supabaseError) {
      return failure(502, `Failed to load analytics from Supabase: ${supabaseError}`);
    }
  }

  if (route === "chapter-pin/change" && method === "POST") {
    const payload = await parseJsonRequest(request);
    const chapter = String(payload?.chapter || "").trim();
    const currentPin = String(payload?.current_pin || "").trim();
    const newPin = String(payload?.new_pin || "").trim();
    const confirmNewPin = String(payload?.confirm_new_pin || "").trim();

    if (!chapter) {
      return failure(400, "Chapter is required.");
    }
    const { error } = supabaseOr503();
    if (error) {
      return error;
    }
    if (!currentPin) {
      return failure(400, "Current PIN is required.");
    }
    if (!newPin) {
      return failure(400, "New PIN is required.");
    }
    if (!confirmNewPin) {
      return failure(400, "Confirm your new PIN.");
    }
    if (!secureCompare(newPin, confirmNewPin)) {
      return failure(400, "New PIN and confirmation do not match.");
    }
    if (!parseNumericPin(newPin)) {
      return failure(400, "New PIN must use numbers only.");
    }
    if (newPin.length < CHAPTER_PIN_MIN_LENGTH) {
      return failure(400, `New PIN must be at least ${CHAPTER_PIN_MIN_LENGTH} digits.`);
    }
    if (newPin.length > CHAPTER_PIN_MAX_LENGTH) {
      return failure(400, `New PIN must be at most ${CHAPTER_PIN_MAX_LENGTH} digits.`);
    }
    if (secureCompare(currentPin, newPin)) {
      return failure(400, "New PIN must be different from current PIN.");
    }

    let expectedPin;
    try {
      expectedPin = await expectedChapterUploadPin(chapter);
    } catch (supabaseError) {
      return failure(
        500,
        `Unable to verify current chapter PIN from Supabase: ${supabaseError}`,
      );
    }
    if (!secureCompare(currentPin, expectedPin)) {
      return failure(403, "Current PIN is incorrect.");
    }

    try {
      await SUPABASE.upsertChapterUploadPin({
        chapterSlug: slugify(chapter),
        chapterName: chapter,
        chapterPin: newPin,
      });
    } catch (supabaseError) {
      return failure(500, `Unable to save chapter PIN to Supabase: ${supabaseError}`);
    }

    return jsonResponse(200, {
      status: "ok",
      chapter,
      chapter_slug: slugify(chapter),
    });
  }

  if (route === "chapter-goals" && method === "GET") {
    const chapter = String(url.searchParams.get("chapter") || "").trim();
    if (!chapter) {
      return failure(400, "Chapter is required.");
    }
    const { error } = supabaseOr503();
    if (error) {
      return error;
    }

    try {
      const goals = await chapterYearlyGoals(chapter);
      return jsonResponse(200, {
        status: "ok",
        chapter,
        chapter_slug: slugify(chapter),
        yearly_goals: publicYearlyGoalsPayload(goals),
      });
    } catch (supabaseError) {
      return failure(
        500,
        `Unable to load chapter yearly goals from Supabase: ${supabaseError}`,
      );
    }
  }

  if (route === "chapter-goals/change" && method === "POST") {
    const payload = await parseJsonRequest(request);
    const chapter = String(payload?.chapter || "").trim();
    const currentPin = String(payload?.current_pin || "").trim();
    if (!chapter) {
      return failure(400, "Chapter is required.");
    }
    const { error } = supabaseOr503();
    if (error) {
      return error;
    }
    if (!currentPin) {
      return failure(400, "Current PIN is required.");
    }

    const goals = {
      visitors: Number(payload?.visitors),
      one_to_ones: Number(payload?.one_to_ones),
      referrals: Number(payload?.referrals),
      ceu: Number(payload?.ceu),
      tyfcb: Number(payload?.tyfcb),
    };
    try {
      validateYearlyGoalsInput(goals);
    } catch (validationError) {
      return failure(validationError.statusCode || 400, validationError.message);
    }

    let expectedPin;
    try {
      expectedPin = await expectedChapterUploadPin(chapter);
    } catch (supabaseError) {
      return failure(
        500,
        `Unable to verify current chapter PIN from Supabase: ${supabaseError}`,
      );
    }
    if (!secureCompare(currentPin, expectedPin)) {
      return failure(403, "Current PIN is incorrect.");
    }

    try {
      await SUPABASE.upsertChapterYearlyGoals({
        chapterSlug: slugify(chapter),
        chapterName: chapter,
        visitors: goals.visitors,
        oneToOnes: goals.one_to_ones,
        referrals: goals.referrals,
        ceu: goals.ceu,
        tyfcb: goals.tyfcb,
      });
    } catch (supabaseError) {
      const errorText = String(supabaseError || "").toLowerCase();
      if (
        errorText.includes("chapter_yearly_goals") &&
        (errorText.includes("could not find the table") || errorText.includes("404"))
      ) {
        return failure(
          503,
          "Yearly goals table is not configured in Supabase yet. Run supabase/schema.sql in Supabase SQL Editor, then retry.",
        );
      }
      return failure(500, `Unable to save chapter yearly goals to Supabase: ${supabaseError}`);
    }

    return jsonResponse(200, {
      status: "ok",
      chapter,
      chapter_slug: slugify(chapter),
      yearly_goals: publicYearlyGoalsPayload(goals),
    });
  }

  if (route === "upload" && method === "POST") {
    const { error } = supabaseOr503();
    if (error) {
      return error;
    }

    let form;
    try {
      form = await request.formData();
    } catch {
      return failure(400, "Invalid upload payload.");
    }

    const chapter = String(form.get("chapter") || "").trim();
    const reportType = String(form.get("report_type") || "").trim().toLowerCase();
    const chapterPin = String(form.get("chapter_pin") || "").trim();
    const file = form.get("file");

    if (!chapter) {
      return failure(400, "Chapter is required.");
    }
    if (!["weekly", "ytd", "traffic"].includes(reportType)) {
      return failure(400, "Invalid report type.");
    }
    if (!chapterPin) {
      return failure(400, reportType === "traffic" ? "Traffic Lights PIN is required." : "Chapter PIN is required.");
    }

    let expectedPin;
    try {
      expectedPin =
        reportType === "traffic"
          ? await expectedTrafficUploadPin()
          : await expectedChapterUploadPin(chapter);
    } catch (supabaseError) {
      return failure(
        500,
        reportType === "traffic"
          ? `Unable to verify Traffic Lights PIN from Supabase: ${supabaseError}`
          : `Unable to verify chapter PIN from Supabase: ${supabaseError}`,
      );
    }
    if (!secureCompare(chapterPin, expectedPin)) {
      return failure(403, reportType === "traffic" ? "Invalid Traffic Lights PIN." : "Invalid chapter PIN.");
    }

    if (!file || typeof file !== "object" || typeof file.arrayBuffer !== "function") {
      return failure(400, "Missing file.");
    }
    const fileName = String(file.name || "").trim();
    if (!fileName) {
      return failure(400, "Missing file.");
    }

    const ext = path.extname(fileName).toLowerCase();
    if ((reportType === "weekly" || reportType === "ytd") && ![".xls", ".xlsx"].includes(ext)) {
      return failure(400, "Weekly/YTD must be .xls or .xlsx.");
    }
    if (reportType === "traffic" && ext !== ".pdf") {
      return failure(400, "Traffic Lights must be .pdf.");
    }

    const content = Buffer.from(await file.arrayBuffer());
    if (!content.length) {
      return failure(400, "Uploaded file is empty.");
    }

    const timestamp = compactUtcTimestamp();
    const chapterSlug = slugify(chapter);
    let validation = null;
    let parsedRows = [];

    if (reportType === "weekly" || reportType === "ytd") {
      let rows;
      try {
        rows = parseChapterSpreadsheet(content);
      } catch {
        return failure(400, `Unable to parse ${reportType.toUpperCase()} Excel report.`);
      }

      parsedRows = rows;
      const summaryRowMetrics = extractChapterSpreadsheetSummaryMetrics(content);
      const columnsLoaded = extractColumns(rows);
      const referralTally = tallyReferralColumns(rows);
      const referralTotal = roundTotal(
        REFERRAL_COLUMNS.reduce((acc, col) => acc + Number(referralTally[col] || 0), 0),
      );
      const memberSummary = {
        v: roundTotal(rows.reduce((acc, row) => acc + asNumber(row?.V), 0)),
        one_to_ones: roundTotal(
          rows.reduce((acc, row) => acc + asNumber(row?.["1-2-1"]), 0),
        ),
        tyfcb: roundTotal(rows.reduce((acc, row) => acc + asNumber(row?.TYFCB), 0)),
        ceu: roundTotal(rows.reduce((acc, row) => acc + asNumber(row?.CEU), 0)),
        referrals_total: roundTotal(
          rows.reduce(
            (acc, row) => acc + asNumber(row?.[REFERRALS_TOTAL_COLUMN]),
            0,
          ),
        ),
      };
      const summaryMetrics = summaryRowMetrics || memberSummary;

      validation = {
        kind: "chapter_spreadsheet",
        rows_parsed: rows.length,
        columns_loaded: columnsLoaded,
        table_start_row: SPREADSHEET_TABLE_START_ROW,
        referral_columns: [...REFERRAL_COLUMNS],
        row_referrals_total_column: REFERRALS_TOTAL_COLUMN,
        referral_tally: referralTally,
        referrals_total: referralTotal,
        summary_row_metrics: summaryRowMetrics,
        key_metrics_summary: [
          {
            key: "v",
            label: "V",
            value: summaryMetrics.v,
          },
          {
            key: "one_to_ones",
            label: "1-2-1's",
            value: summaryMetrics.one_to_ones,
          },
          {
            key: "tyfcb",
            label: "TYFCB",
            value: summaryMetrics.tyfcb,
          },
          {
            key: "ceu",
            label: "CEU",
            value: summaryMetrics.ceu,
          },
          {
            key: "referrals_total",
            label: "Referrals Total",
            value: summaryMetrics.referrals_total,
          },
        ],
        sample_members: sampleMembers(rows),
      };
    } else if (reportType === "traffic") {
      let rows;
      try {
        rows = await parseTrafficLightsPdf(content);
      } catch {
        return failure(400, "Unable to parse Traffic Lights PDF report.");
      }
      if (!rows.length) {
        return failure(
          400,
          "No traffic-light member rows were detected in this PDF. Upload a BNI Traffic Lights report PDF.",
        );
      }

      parsedRows = rows;
      const chaptersDetected = Array.from(
        new Set(
          rows
            .map((row) => String(row?.Chapter || "").trim())
            .filter((chapterName) => Boolean(chapterName)),
        ),
      ).sort();

      validation = {
        kind: "traffic_lights_pdf",
        rows_parsed: rows.length,
        columns_loaded: ["Chapter", "First Name", "Last Name", "Score"],
        chapters_detected: chaptersDetected,
        chapters_detected_count: chaptersDetected.length,
        score_average: rows.length
          ? roundTotal(
              rows.reduce(
                (acc, row) => acc + asNumber(row?.Score ?? row?.Points),
                0,
              ) / rows.length,
            )
          : 0,
        score_max: rows.length
          ? roundTotal(
              Math.max(
                ...rows.map((row) => asNumber(row?.Score ?? row?.Points)),
              ),
            )
          : 0,
        sample_members: sampleMembers(rows),
      };
    }

    let supabaseResult;
    try {
      supabaseResult = await persistUploadToSupabase({
        chapter,
        chapterSlug,
        reportType,
        timestamp,
        file,
        content,
        validation,
        parsedRows,
      });
      if (
        reportType === "traffic" &&
        validation &&
        supabaseResult &&
        supabaseResult.report_month
      ) {
        validation.report_month = supabaseResult.report_month;
      }
    } catch (supabaseError) {
      return failure(500, `Report parsed but failed to persist to Supabase: ${supabaseError}`);
    }

    return jsonResponse(200, {
      status: "ok",
      path: uploadResponsePath(chapterSlug, reportType, timestamp, fileName),
      validation,
      storage_backend: "supabase",
      supabase: supabaseResult,
    });
  }

  return failure(404, "Not found.");
}
