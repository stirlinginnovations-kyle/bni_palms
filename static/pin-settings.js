const chapterSelect = document.getElementById("chapterSelect");
const chapterCustom = document.getElementById("chapterCustom");
const pinForm = document.getElementById("pinForm");
const currentPinInput = document.getElementById("currentPin");
const newPinInput = document.getElementById("newPin");
const confirmNewPinInput = document.getElementById("confirmNewPin");
const pinMessage = document.getElementById("pinMessage");
const savePinButton = document.getElementById("savePinButton");

function redirectToLogin() {
  const next = encodeURIComponent(window.location.pathname);
  window.location.assign(`/login?next=${next}`);
}

function setMessage(text, tone = "default") {
  pinMessage.textContent = text;
  pinMessage.classList.remove("warning", "success");
  if (tone === "warning") {
    pinMessage.classList.add("warning");
  }
  if (tone === "success") {
    pinMessage.classList.add("success");
  }
}

function getChapterValue() {
  const custom = String(chapterCustom.value || "").trim();
  if (custom) return custom;
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
      return;
    }
    payload.forEach((chapter) => {
      const opt = document.createElement("option");
      opt.value = chapter;
      opt.textContent = chapter;
      chapterSelect.appendChild(opt);
    });
  } catch (error) {
    setMessage(error.message || "Unable to load chapters.", "warning");
  }
}

pinForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const chapter = getChapterValue();
  const currentPin = normalizePinInput(currentPinInput.value);
  const newPin = normalizePinInput(newPinInput.value);
  const confirmNewPin = normalizePinInput(confirmNewPinInput.value);

  if (!chapter) {
    setMessage("Select or type a chapter name first.", "warning");
    return;
  }
  if (!currentPin) {
    setMessage("Current PIN is required.", "warning");
    return;
  }
  if (!newPin) {
    setMessage("New PIN is required.", "warning");
    return;
  }
  if (!confirmNewPin) {
    setMessage("Confirm your new PIN.", "warning");
    return;
  }
  if (!isNumericPin(newPin)) {
    setMessage("New PIN must use numbers only.", "warning");
    return;
  }
  if (newPin.length < 4) {
    setMessage("New PIN must be at least 4 digits.", "warning");
    return;
  }
  if (newPin !== confirmNewPin) {
    setMessage("New PIN and confirmation do not match.", "warning");
    return;
  }
  if (newPin === currentPin) {
    setMessage("New PIN must be different from current PIN.", "warning");
    return;
  }

  savePinButton.disabled = true;
  savePinButton.textContent = "Saving PIN...";
  setMessage("Verifying current PIN and updating chapter PIN...");

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
    setMessage("Chapter PIN updated successfully.", "success");
  } catch (error) {
    setMessage(error.message || "Unable to change chapter PIN.", "warning");
  } finally {
    savePinButton.disabled = false;
    savePinButton.textContent = "Save New PIN";
  }
});

attachPinToggles();
loadChapters();
