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

function redirectToLogin() {
  const next = encodeURIComponent(window.location.pathname);
  window.location.assign(`/login?next=${next}`);
}

async function ensureAuthenticated() {
  const response = await fetch("/api/session", { cache: "no-store" });
  if (response.status === 401) {
    redirectToLogin();
    return false;
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.detail || "Unable to verify login session.");
  }
  return true;
}

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
  metaText.textContent = "";
  metaText.style.display = "none";
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

  metrics.forEach((metric) => {
    const currentValue = Math.max(0, Number(metric.current || 0));
    const goalValue = Math.max(0, Number(metric.goal || 0));
    const ratioToGoal = goalValue > 0 ? currentValue / goalValue : 0;
    const currentHeightPct =
      currentValue <= 0 ? 0 : Math.max(Math.min(ratioToGoal * 100, 100), 2);
    const goalHeightPct = goalValue > 0 ? 100 : 0;

    const group = document.createElement("article");
    group.className = "bar-group";

    const pair = document.createElement("div");
    pair.className = "bar-pair";

    const currentBar = document.createElement("div");
    currentBar.className = "bar current";
    currentBar.style.height = `${currentHeightPct}%`;
    currentBar.title =
      goalValue > 0
        ? `${metric.label} current: ${formatNumber(currentValue)} (${(
            ratioToGoal * 100
          ).toFixed(1)}% of goal)`
        : `${metric.label} current: ${formatNumber(currentValue)}`;

    const goalBar = document.createElement("div");
    goalBar.className = "bar goal";
    goalBar.style.height = `${goalHeightPct}%`;
    goalBar.title = `${metric.label} goal: ${formatNumber(goalValue)}`;

    pair.appendChild(currentBar);
    pair.appendChild(goalBar);

    const label = document.createElement("div");
    label.className = "bar-label";
    label.textContent = metric.label;

    const values = document.createElement("div");
    values.className = "bar-values";
    values.textContent =
      goalValue > 0
        ? `Current ${formatNumber(currentValue)} / Goal ${formatNumber(goalValue)} (${(
            ratioToGoal * 100
          ).toFixed(1)}%)`
        : `Current ${formatNumber(currentValue)} / Goal not set`;

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
  metaText.textContent = "";
  metaText.style.display = "none";
  try {
    const response = await fetch(`/api/analytics?chapter=${encodeURIComponent(chapter)}`);
    if (response.status === 401) {
      redirectToLogin();
      return;
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.detail || "Unable to load analytics.");
    }
    renderPayload(payload);
  } catch (error) {
    metaText.style.display = "block";
    metaText.textContent = error.message || "Unable to load analytics.";
  }
}

async function loadChapters() {
  const response = await fetch("/api/chapters");
  if (response.status === 401) {
    redirectToLogin();
    return;
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.detail || "Unable to load chapters.");
  }
  if (!Array.isArray(payload)) {
    throw new Error("Invalid chapter response.");
  }
  const chapters = payload;

  chapterSelect.innerHTML = "";
  if (!chapters.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No chapters found";
    chapterSelect.appendChild(option);
    metaText.style.display = "block";
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

async function init() {
  try {
    const authenticated = await ensureAuthenticated();
    if (!authenticated) return;
    await loadChapters();
  } catch (error) {
    metaText.style.display = "block";
    metaText.textContent = error.message || "Unable to load chapters.";
  }
}

init();
