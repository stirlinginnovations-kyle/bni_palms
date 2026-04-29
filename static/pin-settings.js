const chapterSelect = document.getElementById("chapterSelect");

const pinForm = document.getElementById("pinForm");
const currentPinInput = document.getElementById("currentPin");
const newPinInput = document.getElementById("newPin");
const confirmNewPinInput = document.getElementById("confirmNewPin");
const pinMessage = document.getElementById("pinMessage");
const savePinButton = document.getElementById("savePinButton");

const goalsForm = document.getElementById("goalsForm");
const goalVisitorsInput = document.getElementById("goalVisitors");
const goalOneToOnesInput = document.getElementById("goalOneToOnes");
const goalReferralsInput = document.getElementById("goalReferrals");
const goalCeuInput = document.getElementById("goalCeu");
const goalTyfcbInput = document.getElementById("goalTyfcb");
const goalsMessage = document.getElementById("goalsMessage");
const saveGoalsButton = document.getElementById("saveGoalsButton");

let goalsRequestToken = 0;

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

function setMessage(target, text, tone = "default") {
  if (!target) return;
  target.textContent = text;
  target.classList.remove("warning", "success");
  if (tone === "warning") {
    target.classList.add("warning");
  }
  if (tone === "success") {
    target.classList.add("success");
  }
}

function getChapterValue() {
  return String(chapterSelect.value || "").trim();
}

function normalizePinInput(input) {
  return String(input || "").trim();
}

function isNumericPin(value) {
  return /^\d+$/.test(value);
}

function attachPinToggles() {
  document.querySelectorAll("[data-toggle-target]").forEach((button) => {
    button.addEventListener("click", () => {
      const targetId = button.getAttribute("data-toggle-target");
      const input = document.getElementById(targetId);
      if (!input) return;
      const nextType = input.type === "password" ? "text" : "password";
      input.type = nextType;
      button.textContent = nextType === "password" ? "Show" : "Hide";
    });
  });
}

function parseGoalValue(input, label) {
  const raw = String(input.value || "").trim();
  if (!raw) {
    throw new Error(`${label} yearly goal is required.`);
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`${label} yearly goal must be a number.`);
  }
  if (value < 0) {
    throw new Error(`${label} yearly goal cannot be negative.`);
  }
  return value;
}

function setGoalInputValue(input, value) {
  const numericValue = Number(value);
  input.value = Number.isFinite(numericValue) ? String(numericValue) : "";
}

function renderGoals(goals) {
  const payload = goals || {};
  setGoalInputValue(goalVisitorsInput, payload.visitors);
  setGoalInputValue(goalOneToOnesInput, payload.one_to_ones);
  setGoalInputValue(goalReferralsInput, payload.referrals);
  setGoalInputValue(goalCeuInput, payload.ceu);
  setGoalInputValue(goalTyfcbInput, payload.tyfcb);
}

async function loadGoalsForChapter() {
  const chapter = getChapterValue();
  const requestToken = ++goalsRequestToken;
  if (!chapter) {
    renderGoals({});
    setMessage(goalsMessage, "Select a chapter to load yearly goals.");
    return;
  }

  setMessage(goalsMessage, "Loading current yearly goals...");

  try {
    const response = await fetch(`/api/chapter-goals?chapter=${encodeURIComponent(chapter)}`);
    if (response.status === 401) {
      redirectToLogin();
      return;
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.detail || "Unable to load chapter yearly goals.");
    }
    if (requestToken !== goalsRequestToken) {
      return;
    }

    renderGoals(payload.yearly_goals || {});
    setMessage(goalsMessage, "Current yearly goals loaded.", "success");
  } catch (error) {
    if (requestToken !== goalsRequestToken) {
      return;
    }
    renderGoals({});
    setMessage(
      goalsMessage,
      error.message || "Unable to load chapter yearly goals.",
      "warning",
    );
  }
}

async function loadChapters() {
  try {
    const res = await fetch("/api/chapters");
    if (res.status === 401) {
      redirectToLogin();
      return;
    }
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(payload.detail || "Unable to load chapters.");
    }
    if (!Array.isArray(payload)) {
      throw new Error("Chapters response was not a list.");
    }

    chapterSelect.innerHTML = "";
    if (!payload.length) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "No chapters loaded";
      chapterSelect.appendChild(opt);
      setMessage(pinMessage, "No chapters found in Supabase.", "warning");
      setMessage(goalsMessage, "No chapters found in Supabase.", "warning");
      return;
    }

    payload.forEach((chapter) => {
      const opt = document.createElement("option");
      opt.value = chapter;
      opt.textContent = chapter;
      chapterSelect.appendChild(opt);
    });

    await loadGoalsForChapter();
  } catch (error) {
    const message = error.message || "Unable to load chapters.";
    setMessage(pinMessage, message, "warning");
    setMessage(goalsMessage, message, "warning");
  }
}

pinForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const chapter = getChapterValue();
  const currentPin = normalizePinInput(currentPinInput.value);
  const newPin = normalizePinInput(newPinInput.value);
  const confirmNewPin = normalizePinInput(confirmNewPinInput.value);

  if (!chapter) {
    setMessage(pinMessage, "Select a chapter first.", "warning");
    return;
  }
  if (!currentPin) {
    setMessage(pinMessage, "Current PIN is required.", "warning");
    return;
  }
  if (!newPin) {
    setMessage(pinMessage, "New PIN is required.", "warning");
    return;
  }
  if (!confirmNewPin) {
    setMessage(pinMessage, "Confirm your new PIN.", "warning");
    return;
  }
  if (!isNumericPin(newPin)) {
    setMessage(pinMessage, "New PIN must use numbers only.", "warning");
    return;
  }
  if (newPin.length < 4) {
    setMessage(pinMessage, "New PIN must be at least 4 digits.", "warning");
    return;
  }
  if (newPin !== confirmNewPin) {
    setMessage(pinMessage, "New PIN and confirmation do not match.", "warning");
    return;
  }
  if (newPin === currentPin) {
    setMessage(pinMessage, "New PIN must be different from current PIN.", "warning");
    return;
  }

  savePinButton.disabled = true;
  savePinButton.textContent = "Saving PIN...";
  setMessage(pinMessage, "Verifying current PIN and updating chapter PIN...");

  try {
    const response = await fetch("/api/chapter-pin/change", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chapter,
        current_pin: currentPin,
        new_pin: newPin,
        confirm_new_pin: confirmNewPin,
      }),
    });
    if (response.status === 401) {
      redirectToLogin();
      return;
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.detail || "Unable to change chapter PIN.");
    }

    currentPinInput.value = "";
    newPinInput.value = "";
    confirmNewPinInput.value = "";
    setMessage(pinMessage, "Chapter PIN updated successfully.", "success");
  } catch (error) {
    setMessage(pinMessage, error.message || "Unable to change chapter PIN.", "warning");
  } finally {
    savePinButton.disabled = false;
    savePinButton.textContent = "Save New PIN";
  }
});

goalsForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const chapter = getChapterValue();
  if (!chapter) {
    setMessage(goalsMessage, "Select a chapter first.", "warning");
    return;
  }

  let goals;
  try {
    goals = {
      visitors: parseGoalValue(goalVisitorsInput, "Visitors"),
      one_to_ones: parseGoalValue(goalOneToOnesInput, "One to Ones"),
      referrals: parseGoalValue(goalReferralsInput, "Referrals"),
      ceu: parseGoalValue(goalCeuInput, "CEU"),
      tyfcb: parseGoalValue(goalTyfcbInput, "TYFCB"),
    };
  } catch (error) {
    setMessage(goalsMessage, error.message || "Invalid yearly goals.", "warning");
    return;
  }

  saveGoalsButton.disabled = true;
  saveGoalsButton.textContent = "Saving Goals...";
  setMessage(goalsMessage, "Verifying PIN and saving yearly goals...");

  const confirmSave = window.confirm(
    `Save yearly goals for ${chapter}?\n\n` +
      `Visitors: ${goals.visitors}\n` +
      `One to Ones: ${goals.one_to_ones}\n` +
      `Referrals: ${goals.referrals}\n` +
      `CEU: ${goals.ceu}\n` +
      `TYFCB: ${goals.tyfcb}`,
  );
  if (!confirmSave) {
    saveGoalsButton.disabled = false;
    saveGoalsButton.textContent = "Save Yearly Goals";
    setMessage(goalsMessage, "Yearly goal update canceled.");
    return;
  }

  const currentPin = normalizePinInput(
    window.prompt(`Enter current chapter PIN for "${chapter}":`) || "",
  );
  if (!currentPin) {
    saveGoalsButton.disabled = false;
    saveGoalsButton.textContent = "Save Yearly Goals";
    setMessage(goalsMessage, "Current PIN is required to save yearly goals.", "warning");
    return;
  }

  try {
    const response = await fetch("/api/chapter-goals/change", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chapter,
        current_pin: currentPin,
        ...goals,
      }),
    });
    if (response.status === 401) {
      redirectToLogin();
      return;
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.detail || "Unable to save chapter yearly goals.");
    }

    renderGoals(payload.yearly_goals || goals);
    setMessage(goalsMessage, "Chapter yearly goals updated successfully.", "success");
  } catch (error) {
    setMessage(
      goalsMessage,
      error.message || "Unable to save chapter yearly goals.",
      "warning",
    );
  } finally {
    saveGoalsButton.disabled = false;
    saveGoalsButton.textContent = "Save Yearly Goals";
  }
});

chapterSelect.addEventListener("change", () => {
  loadGoalsForChapter();
});

async function init() {
  attachPinToggles();
  try {
    const authenticated = await ensureAuthenticated();
    if (!authenticated) return;
    await loadChapters();
  } catch (error) {
    const message = error.message || "Unable to load chapters.";
    setMessage(pinMessage, message, "warning");
    setMessage(goalsMessage, message, "warning");
  }
}

init();
