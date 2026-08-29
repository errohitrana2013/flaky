// Token storage for the admin pages.
//
// localStorage with an explicit 24h expiry, not sessionStorage: re-typing a
// 48-character token on every page refresh is friction with no security payoff
// on a machine you already trust. The expiry is enforced on read, so a stale
// entry cannot outlive the day even if the browser keeps it.
//
// Trade-off worth knowing: this writes the admin token to disk, where
// sessionStorage kept it in memory for one tab. On a shared or public machine,
// use Forget — it clears the entry immediately.
const KEY = "flaky_admin";
const TTL_MS = 24 * 60 * 60 * 1000;

function saveToken(token) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ token, expires: Date.now() + TTL_MS }));
  } catch { /* private windows throw; the page still works, just without memory */ }
}

function loadToken() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const { token, expires } = JSON.parse(raw);
    if (!token || !expires || Date.now() > expires) { clearToken(); return null; }
    return token;
  } catch { return null; }
}

function clearToken() {
  try { localStorage.removeItem(KEY); } catch { /* nothing to do */ }
}

function tokenExpiresIn() {
  try {
    const { expires } = JSON.parse(localStorage.getItem(KEY) || "{}");
    if (!expires) return "";
    const hours = Math.max(0, Math.round((expires - Date.now()) / 3600000));
    return hours >= 1 ? `signed in · ${hours}h left` : "signed in · under an hour left";
  } catch { return ""; }
}

// Wired by both pages: show how long the session has left, and let it be ended.
function wireSessionControls(onForget) {
  const label = document.getElementById("session");
  const button = document.getElementById("forget");
  if (!label || !button) return;
  const text = tokenExpiresIn();
  if (!text) return;
  label.textContent = "· " + text;
  button.hidden = false;
  button.addEventListener("click", () => { clearToken(); onForget(); });
}
