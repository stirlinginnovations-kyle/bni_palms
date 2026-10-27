import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import XLSX from "xlsx";
import {
  parseChapterSpreadsheet,
  extractChapterSpreadsheetSummaryMetrics,
} from "../netlify/functions/_lib/parsers.mjs";

const headers = ["First Name", "Last Name", "RGI", "RGO", "V", "1-2-1", "TYFCB", "CEU"];
function workbook(preamble = []) {
  const sheet = XLSX.utils.aoa_to_sheet([
    ...preamble, headers,
    ["Test", "Member", 2, 3, 4, 5, 600, 7],
    ["Visitors", "", 0, 0, 0, 0, 0, 0],
    ["BNI", "", 0, 0, 0, 0, 100, 0],
    ["Total", "", 2, 3, 4, 5, 700, 7],
  ]);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, "Report");
  return XLSX.write(book, { type: "buffer", bookType: "xlsx" });
}

for (const [name, preamble] of [
  ["row-1 headers", []],
  ["row-9 headers", Array.from({ length: 8 }, () => ["Report information"])],
  ["blank rows in preamble", [["Report"], [], ["Dates"], [], [], [], [], []]],
]) {
  test(`imports members and chapter total with ${name}`, () => {
    const buffer = workbook(preamble);
    const rows = parseChapterSpreadsheet(buffer);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]["First Name"], "Test");
    assert.equal(rows[0]["Referrals Total"], 5);
    assert.deepEqual(extractChapterSpreadsheetSummaryMetrics(buffer), {
      v: 4, one_to_ones: 5, tyfcb: 700, ceu: 7, referrals_total: 5,
    });
  });
}

test("standard SpreadsheetML XLS remains supported", () => {
  const buffer = fs.readFileSync(new URL("../references/fixtures/ytd_2026-02-25.xls", import.meta.url));
  assert.equal(parseChapterSpreadsheet(buffer).length, 38);
  assert.equal(extractChapterSpreadsheetSummaryMetrics(buffer).tyfcb, 1409141);
});

test("empty imports are rejected before any database or storage writes", async () => {
  process.env.SUPABASE_URL ||= "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_KEY ||= "test-key";
  const { SupabaseClient } = await import("../netlify/functions/_lib/supabase.mjs");
  const { buildAuthCookieHeader } = await import("../netlify/functions/_lib/common.mjs");
  const { default: handler } = await import("../netlify/functions/api.mjs");
  const original = SupabaseClient.prototype.request;
  SupabaseClient.prototype.request = async function (method, path) {
    assert.equal(method, "GET", "empty import must never write");
    assert.equal(path, "/rest/v1/chapter_upload_pins");
    return [{ chapter_pin: "test-pin" }];
  };
  try {
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([headers]), "Report");
    const form = new FormData();
    form.set("chapter", "St. Charles - MO St. Louis");
    form.set("report_type", "ytd");
    form.set("chapter_pin", "test-pin");
    form.set("file", new Blob([XLSX.write(book, { type: "buffer", bookType: "xlsx" })]), "empty.xlsx");
    const response = await handler(new Request("https://example.test/api/upload", {
      method: "POST", headers: { cookie: buildAuthCookieHeader().split(";")[0] }, body: form,
    }));
    assert.equal(response.status, 400);
    assert.match((await response.json()).detail, /No member rows/);
  } finally {
    SupabaseClient.prototype.request = original;
  }
});
