const loginForm = document.getElementById("loginForm");
const loginMessage = document.getElementById("loginMessage");
const togglePassword = document.getElementById("togglePassword");
const passwordInput = document.getElementById("password");

togglePassword.addEventListener("click", () => {
  const nextType = passwordInput.type === "password" ? "text" : "password";
  passwordInput.type = nextType;
  togglePassword.textContent = nextType === "password" ? "Show" : "Hide";
});

loginForm.addEventListener("submit", (event) => {
  event.preventDefault();

  const formData = new FormData(loginForm);
  const email = String(formData.get("email") || "").trim();
  const password = String(formData.get("password") || "").trim();

  if (!email || !password) {
    loginMessage.textContent = "Enter both email and password to preview this flow.";
    loginMessage.classList.add("warning");
    return;
  }

  loginMessage.textContent =
    "Login is staged but intentionally disabled. Auth + paywall checks will be wired in a future release.";
  loginMessage.classList.add("warning");
});
