const chapterSelect = document.getElementById("chapterSelect");
const reportTitle = document.getElementById("reportTitle");
const metaText = document.getElementById("metaText");

const weeklyVisitors = document.getElementById("weeklyVisitors");
const weeklyCeu = document.getElementById("weeklyCeu");
const weeklyOneToOnes = document.getElementById("weeklyOneToOnes");
const weeklyReferrals = document.getElementById("weeklyReferrals");
const weeklyTyfcb = document.getElementById("weeklyTyfcb");

const barChart = document.getElementById("barChart");
const trafficDonut = document.getElementById("trafficDonut");
const trafficDonutLabel = document.getElementById("trafficDonutLabel");
const trafficLegend = document.getElementById("trafficLegend");
const ytdTableBody = document.getElementById("ytdTableBody");
const clubMembers = document.getElementById("clubMembers");

function formatNumber(value) {
  return Number(value || 0).toLocaleString();
}

function formatCurrency(value) {
  return Number(value || 0).toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

function formatDateTime(value) {
  if (!value) return "n/a";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toLocaleString();
}

function setMeta(payload) {
  const updated = payload.updated_at || {};
  const parts = [];
  if (updated.weekly_uploaded_at) {
    parts.push(`Weekly: ${formatDateTime(updated.weekly_uploaded_at)}`);
  }
  if (updated.ytd_uploaded_at) {
    parts.push(`YTD: ${formatDateTime(updated.ytd_uploaded_at)}`);
  }
  if (updated.traffic_uploaded_at) {
    parts.push(`Traffic: ${formatDateTime(updated.traffic_uploaded_at)}`);
  }
  if (updated.traffic_report_month) {
    parts.push(`Traffic Month: ${updated.traffic_report_month}`);
  }
  if (parts.length === 0) {
    parts.push("No uploads found yet for this chapter.");
  }
  parts.push(`Source: ${payload.source}`);
  metaText.textContent = parts.join(" | ");
}

function renderWeeklyCards(payload) {
  const weekly = payload.weekly_summary || {};
  weeklyVisitors.textContent = formatNumber(weekly.visitors);
  weeklyCeu.textContent = formatNumber(weekly.ceu);
  weeklyOneToOnes.textContent = formatNumber(weekly.one_to_ones);
  weeklyReferrals.textContent = formatNumber(weekly.referrals);
  weeklyTyfcb.textContent = formatCurrency(weekly.tyfcb);
}

function renderBarChart(payload) {
  barChart.innerHTML = "";
  const metrics = payload.bar_metrics || [];
  const maxValue = Math.max(
    1,
    ...metrics.map((m) => Math.max(Number(m.current || 0), Number(m.goal || 0))),
  );

  metrics.forEach((metric) => {
    const group = document.createElement("article");
    group.className = "bar-group";

    const pair = document.createElement("div");
    pair.className = "bar-pair";

    const currentBar = document.createElement("div");
    currentBar.className = "bar current";
    currentBar.style.height = `${Math.max((Number(metric.current || 0) / maxValue) * 100, 2)}%`;
    currentBar.title = `${metric.label} current: ${formatNumber(metric.current)}`;

    const goalBar = document.createElement("div");
    goalBar.className = "bar goal";
    goalBar.style.height = `${Math.max((Number(metric.goal || 0) / maxValue) * 100, 2)}%`;
    goalBar.title = `${metric.label} goal: ${formatNumber(metric.goal)}`;

    pair.appendChild(currentBar);
    pair.appendChild(goalBar);

    const label = document.createElement("div");
    label.className = "bar-label";
    label.textContent = metric.label;

    const values = document.createElement("div");
    values.className = "bar-values";
    values.textContent = `Current ${formatNumber(metric.current)} / Goal ${formatNumber(metric.goal)}`;

    group.appendChild(pair);
    group.appendChild(label);
    group.appendChild(values);
    barChart.appendChild(group);
  });
}

function renderTraffic(payload) {
  const distribution = payload.traffic_distribution || [];
  const total = distribution.reduce((acc, item) => acc + Number(item.count || 0), 0);

  if (!distribution.length || total === 0) {
    trafficDonut.style.background = "conic-gradient(#4b5563 0 100%)";
    trafficDonutLabel.textContent = "No traffic data";
    trafficLegend.innerHTML = '<li class="empty">No traffic-light rows found.</li>';
    return;
  }

  let start = 0;
  const segments = distribution.map((item) => {
    const pct = Number(item.pct || 0);
    const end = start + pct;
    const seg = `${item.color} ${start}% ${end}%`;
    start = end;
    return seg;
  });

  if (start < 100) {
    segments.push(`#4b5563 ${start}% 100%`);
  }

  trafficDonut.style.background = `conic-gradient(${segments.join(", ")})`;
  trafficDonutLabel.textContent = `${total} members`;

  trafficLegend.innerHTML = "";
  distribution.forEach((item) => {
    const li = document.createElement("li");

    const swatch = document.createElement("em");
    swatch.style.background = item.color;

    const name = document.createElement("span");
    name.textContent = item.label;

    const stats = document.createElement("span");
    stats.textContent = `${formatNumber(item.count)} (${Number(item.pct || 0).toFixed(1)}%)`;

    li.appendChild(swatch);
    li.appendChild(name);
    li.appendChild(stats);
    trafficLegend.appendChild(li);
  });
}

function renderYtdTable(payload) {
  ytdTableBody.innerHTML = "";
  const rows = payload.ytd_metrics || [];
  rows.forEach((metric) => {
    const tr = document.createElement("tr");

    const metricTd = document.createElement("td");
    metricTd.textContent = metric.metric;

    const currentTd = document.createElement("td");
    currentTd.textContent =
      metric.key === "tyfcb"
        ? formatCurrency(metric.current)
        : formatNumber(metric.current);

    const goalTd = document.createElement("td");
    goalTd.textContent =
      metric.key === "tyfcb"
        ? formatCurrency(metric.yearly_goal)
        : formatNumber(metric.yearly_goal);

    const pctTd = document.createElement("td");
    pctTd.textContent = `${Number(metric.pct_to_goal || 0).toFixed(1)}%`;

    tr.appendChild(metricTd);
    tr.appendChild(currentTd);
    tr.appendChild(goalTd);
    tr.appendChild(pctTd);
    ytdTableBody.appendChild(tr);
  });
}

function renderClubMembers(payload) {
  const members = payload.club_members || [];
  clubMembers.innerHTML = "";
  if (!members.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No 100 percent club members for the latest traffic report.";
    clubMembers.appendChild(li);
    return;
  }

  members.forEach((member) => {
    const li = document.createElement("li");
    li.textContent = member;
    clubMembers.appendChild(li);
  });
}

function renderPayload(payload) {
  reportTitle.textContent = `BNI ${payload.chapter} Weekly Report`;
  setMeta(payload);
  renderWeeklyCards(payload);
  renderBarChart(payload);
  renderTraffic(payload);
  renderYtdTable(payload);
  renderClubMembers(payload);
}

async function loadAnalytics(chapter) {
  metaText.textContent = "Loading analytics...";
  try {
    const response = await fetch(`/api/analytics?chapter=${encodeURIComponent(chapter)}`);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.detail || "Unable to load analytics.");
    }
    renderPayload(payload);
  } catch (error) {
    metaText.textContent = error.message || "Unable to load analytics.";
  }
}

async function loadChapters() {
  const response = await fetch("/api/chapters");
  const chapters = await response.json();

  chapterSelect.innerHTML = "";
  if (!chapters.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No chapters found";
    chapterSelect.appendChild(option);
    metaText.textContent = "Upload data first, then refresh this page.";
    return;
  }

  chapters.forEach((chapter) => {
    const option = document.createElement("option");
    option.value = chapter;
    option.textContent = chapter;
    chapterSelect.appendChild(option);
  });

  await loadAnalytics(chapters[0]);
}

chapterSelect.addEventListener("change", (event) => {
  const selected = String(event.target.value || "").trim();
  if (!selected) return;
  loadAnalytics(selected);
});

loadChapters().catch(() => {
  metaText.textContent = "Unable to load chapters.";
});
