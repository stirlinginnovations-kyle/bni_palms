import {
  ANALYTICS_GOALS,
  REFERRALS_TOTAL_COLUMN,
  asNumber,
  nullableNumber,
  roundTotal,
} from "./common.mjs";

export function defaultYearlyGoals() {
  return {
    visitors: Number(ANALYTICS_GOALS.visitors),
    one_to_ones: Number(ANALYTICS_GOALS.one_to_ones),
    referrals: Number(ANALYTICS_GOALS.referrals),
    ceu: Number(ANALYTICS_GOALS.ceu),
    tyfcb: Number(ANALYTICS_GOALS.tyfcb),
  };
}

export function validateYearlyGoalsInput(goals) {
  const labels = {
    visitors: "Visitors",
    one_to_ones: "One to Ones",
    referrals: "Referrals",
    ceu: "CEU",
    tyfcb: "TYFCB",
  };
  for (const [key, label] of Object.entries(labels)) {
    const value = goals?.[key];
    const isNumber = typeof value === "number" && Number.isFinite(value);
    if (!isNumber) {
      const error = new Error(`${label} yearly goal must be a number.`);
      error.statusCode = 400;
      throw error;
    }
    if (value < 0) {
      const error = new Error(`${label} yearly goal cannot be negative.`);
      error.statusCode = 400;
      throw error;
    }
  }
}

export function publicYearlyGoalsPayload(goals) {
  const payload = {};
  for (const key of Object.keys(ANALYTICS_GOALS)) {
    payload[key] = roundTotal(Number(goals?.[key] || 0));
  }
  return payload;
}

export function normalizeMemberRows(rows) {
  const normalized = [];
  for (const row of rows || []) {
    const first = String(row?.first_name ?? row?.["First Name"] ?? "").trim();
    const last = String(row?.last_name ?? row?.["Last Name"] ?? "").trim();
    normalized.push({
      first_name: first,
      last_name: last,
      member_key: String(row?.member_key || "").trim(),
      v: asNumber(row?.v ?? row?.V),
      ceu: asNumber(row?.ceu ?? row?.CEU),
      one_to_one: asNumber(row?.one_to_one ?? row?.["1-2-1"]),
      referrals_total: asNumber(
        row?.referrals_total ?? row?.[REFERRALS_TOTAL_COLUMN],
      ),
      tyfcb: asNumber(row?.tyfcb ?? row?.TYFCB),
    });
  }
  return normalized;
}

export function normalizeTrafficRows(rows) {
  const normalized = [];
  for (const row of rows || []) {
    const first = String(row?.first_name ?? row?.["First Name"] ?? "").trim();
    const last = String(row?.last_name ?? row?.["Last Name"] ?? "").trim();

    const raw = row?.raw && typeof row.raw === "object" ? row.raw : {};
    let pointsValue = raw?.Points;
    if (pointsValue === undefined || pointsValue === null) {
      pointsValue = raw?.Score;
    }
    if (pointsValue === undefined || pointsValue === null) {
      pointsValue = row?.points ?? row?.Points;
    }
    if (pointsValue === undefined || pointsValue === null) {
      pointsValue = row?.Score;
    }
    if (pointsValue === undefined || pointsValue === null) {
      pointsValue = row?.referrals ?? row?.Referrals;
    }

    normalized.push({
      first_name: first,
      last_name: last,
      member_key: String(row?.member_key || "").trim(),
      referrals: asNumber(row?.referrals ?? row?.Referrals),
      points: nullableNumber(pointsValue),
    });
  }
  return normalized;
}

function sumMetric(rows, key) {
  let total = 0;
  for (const row of rows || []) {
    total += asNumber(row?.[key]);
  }
  return roundTotal(total);
}

function memberDisplayName(first, last) {
  const f = String(first || "").trim();
  const l = String(last || "").trim();
  if (l && f) {
    return `${l}, ${f}`;
  }
  return f || l;
}

function buildTrafficDistribution(rows) {
  const buckets = {
    club100: 0,
    green: 0,
    red: 0,
    yellow: 0,
  };
  const clubMembers = [];
  let total = 0;

  for (const row of rows || []) {
    total += 1;
    const points = nullableNumber(row?.points);
    const score = points !== null ? points : 0;

    if (score >= 100) {
      buckets.club100 += 1;
      const name = memberDisplayName(row?.first_name, row?.last_name);
      if (name) {
        clubMembers.push(name);
      }
    } else if (score >= 60) {
      buckets.green += 1;
    } else if (score >= 40) {
      buckets.yellow += 1;
    } else {
      buckets.red += 1;
    }
  }

  const pct = (count) => {
    if (total <= 0) {
      return 0;
    }
    return Number(((count / total) * 100).toFixed(1));
  };

  const distribution = [
    {
      key: "club100",
      label: "100 percent Club",
      count: buckets.club100,
      pct: pct(buckets.club100),
      color: "#6ca0ff",
    },
    {
      key: "green",
      label: "Green",
      count: buckets.green,
      pct: pct(buckets.green),
      color: "#9abf4f",
    },
    {
      key: "red",
      label: "Red",
      count: buckets.red,
      pct: pct(buckets.red),
      color: "#e84a4a",
    },
    {
      key: "yellow",
      label: "Yellow",
      count: buckets.yellow,
      pct: pct(buckets.yellow),
      color: "#e9c53a",
    },
  ];

  const uniqueClubMembers = Array.from(new Set(clubMembers.filter(Boolean))).sort();
  return { distribution, clubMembers: uniqueClubMembers };
}

function generatedAtIsoUtc() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function buildAnalyticsPayload({
  chapter,
  chapterSlug,
  source,
  weeklyRows,
  ytdRows,
  trafficRows,
  weeklyUploadedAt,
  ytdUploadedAt,
  trafficUploadedAt,
  trafficReportMonth,
  yearlyGoals,
}) {
  const weeklySummary = {
    visitors: sumMetric(weeklyRows, "v"),
    ceu: sumMetric(weeklyRows, "ceu"),
    one_to_ones: sumMetric(weeklyRows, "one_to_one"),
    referrals: sumMetric(weeklyRows, "referrals_total"),
    tyfcb: sumMetric(weeklyRows, "tyfcb"),
  };
  const ytdSummary = {
    visitors: sumMetric(ytdRows, "v"),
    ceu: sumMetric(ytdRows, "ceu"),
    one_to_ones: sumMetric(ytdRows, "one_to_one"),
    referrals: sumMetric(ytdRows, "referrals_total"),
    tyfcb: sumMetric(ytdRows, "tyfcb"),
  };
  const goals = {
    visitors: Number(yearlyGoals?.visitors ?? ANALYTICS_GOALS.visitors),
    one_to_ones: Number(yearlyGoals?.one_to_ones ?? ANALYTICS_GOALS.one_to_ones),
    referrals: Number(yearlyGoals?.referrals ?? ANALYTICS_GOALS.referrals),
    ceu: Number(yearlyGoals?.ceu ?? ANALYTICS_GOALS.ceu),
    tyfcb: Number(yearlyGoals?.tyfcb ?? ANALYTICS_GOALS.tyfcb),
  };

  const barOrder = [
    ["ceu", "CEU"],
    ["referrals", "Referrals"],
    ["one_to_ones", "One to Ones"],
    ["visitors", "Visitors"],
    ["tyfcb", "TYFCB"],
  ];
  const barMetrics = barOrder.map(([key, label]) => ({
    key,
    label,
    current: roundTotal(asNumber(ytdSummary[key])),
    goal: roundTotal(goals[key]),
  }));

  const tableOrder = [
    ["visitors", "Visitors"],
    ["one_to_ones", "One to Ones"],
    ["referrals", "Referrals"],
    ["ceu", "CEU"],
    ["tyfcb", "TYFCB"],
  ];
  const ytdMetrics = tableOrder.map(([key, label]) => {
    const current = asNumber(ytdSummary[key]);
    const goal = Number(goals[key]) || 0;
    const pctToGoal = goal > 0 ? Number(((current / goal) * 100).toFixed(1)) : 0;
    return {
      key,
      metric: label,
      current: roundTotal(current),
      yearly_goal: roundTotal(goal),
      pct_to_goal: pctToGoal,
    };
  });

  const trafficParts = buildTrafficDistribution(trafficRows);
  return {
    chapter,
    chapter_slug: chapterSlug,
    source,
    generated_at: generatedAtIsoUtc(),
    updated_at: {
      weekly_uploaded_at: weeklyUploadedAt || null,
      ytd_uploaded_at: ytdUploadedAt || null,
      traffic_uploaded_at: trafficUploadedAt || null,
      traffic_report_month: trafficReportMonth || null,
    },
    has_data: {
      weekly: Boolean(weeklyRows?.length),
      ytd: Boolean(ytdRows?.length),
      traffic: Boolean(trafficRows?.length),
    },
    weekly_summary: weeklySummary,
    ytd_summary: ytdSummary,
    yearly_goals: publicYearlyGoalsPayload(goals),
    bar_metrics: barMetrics,
    ytd_metrics: ytdMetrics,
    traffic_distribution: trafficParts.distribution,
    club_members: trafficParts.clubMembers,
  };
}

