const loginForm = document.getElementById("loginForm");
const loginMessage = document.getElementById("loginMessage");
const togglePassword = document.getElementById("togglePassword");
const passwordInput = document.getElementById("password");
const submitBtn = document.getElementById("submitBtn");

const params = new URLSearchParams(window.location.search);
const rawNext = String(params.get("next") || "/").trim();
const nextPath =
  rawNext.startsWith("/") && !rawNext.startsWith("//") && !rawNext.startsWith("/api/")
    ? rawNext
    : "/";

function setMessage(text, tone = "default") {
  loginMessage.textContent = text;
  loginMessage.classList.remove("warning", "success");
  if (tone === "warning") {
    loginMessage.classList.add("warning");
  }
  if (tone === "success") {
    loginMessage.classList.add("success");
  }
}

togglePassword.addEventListener("click", () => {
  const nextType = passwordInput.type === "password" ? "text" : "password";
  passwordInput.type = nextType;
  togglePassword.textContent = nextType === "password" ? "Show" : "Hide";
});

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const password = String(passwordInput.value || "").trim();
  if (!password) {
    setMessage("Enter your password.", "warning");
    return;
  }

  submitBtn.disabled = true;
  submitBtn.textContent = "Signing In...";
  setMessage("Checking access...", "default");

  try {
    const response = await fetch("/api/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ password, next: nextPath }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.detail || "Unable to sign in.");
    }

    setMessage("Access granted. Redirecting...", "success");
    const target =
      typeof payload.next === "string" && payload.next.startsWith("/")
        ? payload.next
        : nextPath;
    window.location.assign(target || "/");
  } catch (error) {
    setMessage(error.message || "Unable to sign in.", "warning");
    submitBtn.disabled = false;
    submitBtn.textContent = "Sign In";
  }
});
