(() => {
  const $ = (id) => document.getElementById(id);

  const COUNTRIES = [
    ["PH", "63"], ["US", "1"], ["CA", "1"], ["GB", "44"], ["AU", "61"], ["SG", "65"], ["MY", "60"],
    ["HK", "852"], ["JP", "81"], ["KR", "82"], ["IN", "91"], ["AE", "971"], ["SA", "966"],
    ["IT", "39"], ["GR", "30"], ["DE", "49"], ["ES", "34"], ["NO", "47"], ["ZA", "27"],
  ];
  const STATUS_COPY = {
    starting: ["Starting", "Starting up…"],
    connecting: ["Connecting", "Connecting to WhatsApp…"],
    qr: ["Link needed", "Scan the code below with your phone to link your number."],
    open: ["Connected", ""],
    logged_out: ["Unlinked", "This number was unlinked. A new code will appear shortly."],
  };
  const KEY = "wa-sender:password";

  let password = "";
  try { password = sessionStorage.getItem(KEY) || ""; } catch { /* storage unavailable */ }
  let pollTimer = null;
  let connected = false;
  let sending = false;
  let lastQr = null;

  // ---------- api ----------

  async function api(path, options = {}) {
    const res = await fetch(path, {
      ...options,
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + password },
    });
    let body = null;
    try { body = await res.json(); } catch { /* empty body */ }
    if (res.status === 401) {
      signOut("Wrong password.");
      throw new Error("unauthorized");
    }
    if (!res.ok) throw new Error((body && body.error) || "Request failed (" + res.status + ").");
    return body;
  }

  // ---------- sign in / out ----------

  function showLogin(message) {
    clearTimeout(pollTimer);
    $("app").hidden = true;
    $("login").hidden = false;
    const err = $("login-error");
    err.hidden = !message;
    err.textContent = message || "";
    $("password").focus();
  }

  function signOut(message) {
    password = "";
    try { sessionStorage.removeItem(KEY); } catch { /* ignore */ }
    showLogin(message);
  }

  function showApp() {
    $("login").hidden = true;
    $("app").hidden = false;
  }

  $("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    password = $("password").value;
    if (!password) return;
    try {
      const s = await api("/api/status");
      try { sessionStorage.setItem(KEY, password); } catch { /* ignore */ }
      $("password").value = "";
      showApp();
      renderStatus(s);
      schedulePoll(s.status === "open" ? 10000 : 2000);
    } catch (err) {
      if (err.message !== "unauthorized") showLogin(err.message);
    }
  });

  $("signout").addEventListener("click", () => signOut(""));

  $("unlink").addEventListener("click", async () => {
    if (!confirm("Unlink this number from the server? You'll need to scan a new QR code to use it again.")) return;
    try {
      await api("/api/logout", { method: "POST" });
    } catch (err) {
      if (err.message !== "unauthorized") setSendMessage(err.message, false);
    }
  });

  // ---------- status ----------

  function renderStatus(s) {
    const [label, text] = STATUS_COPY[s.status] || STATUS_COPY.starting;
    const badge = $("badge");
    badge.textContent = label;
    badge.dataset.state = s.status;
    $("status-text").textContent = s.status === "open" && s.me ? "Sending as +" + s.me : text;

    connected = s.status === "open";
    $("unlink").hidden = !connected;

    const showQr = s.status === "qr" && !!s.qr;
    $("qr-block").hidden = !showQr;
    if (showQr && s.qr !== lastQr) {
      $("qr").src = s.qr;
      lastQr = s.qr;
    }
    if (!showQr) lastQr = null;
    updateSendState();
  }

  function schedulePoll(ms) {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(poll, ms);
  }

  async function poll() {
    try {
      const s = await api("/api/status");
      renderStatus(s);
      schedulePoll(s.status === "open" ? 10000 : 2000);
    } catch (err) {
      if (err.message === "unauthorized") return;
      $("status-text").textContent = "Can't reach the server. Retrying…";
      schedulePoll(5000);
    }
  }

  // ---------- send form ----------

  const ccEl = $("cc");
  COUNTRIES.forEach(([code, dial]) => {
    const o = document.createElement("option");
    o.value = dial;
    o.textContent = code + " +" + dial;
    ccEl.appendChild(o);
  });

  function computeNumber() {
    const raw = $("number").value.trim();
    const digits = raw.replace(/\D/g, "");
    if (!digits) return { empty: true, valid: false };
    let full;
    if (raw.startsWith("+")) full = digits;
    else if (digits.startsWith("00")) full = digits.replace(/^0+/, "");
    else full = ccEl.value + digits.replace(/^0+/, "");
    if (full.length < 8 || full.length > 15) {
      return { valid: false, full, reason: "That number looks too " + (full.length > 15 ? "long" : "short") + ". Check the digits." };
    }
    return { valid: true, full };
  }

  function updateSendState() {
    const r = computeNumber();
    const msg = $("message").value.trim();
    $("count").textContent = $("message").value.length + " / 4000";

    const target = $("target");
    target.textContent = "";
    if (r.valid) {
      const span = document.createElement("span");
      span.className = "target";
      span.textContent = "Sending to +" + r.full;
      target.appendChild(span);
    } else if (!r.empty) {
      const span = document.createElement("span");
      span.className = "err";
      span.textContent = r.reason;
      target.appendChild(span);
    }
    $("send").disabled = sending || !connected || !r.valid || !msg;
  }

  function setSendMessage(text, ok) {
    const err = $("send-error");
    const good = $("send-ok");
    err.hidden = ok || !text;
    good.hidden = !ok || !text;
    (ok ? good : err).textContent = text || "";
  }

  function addLog(number) {
    $("log-empty").hidden = true;
    const li = document.createElement("li");
    const n = document.createElement("span");
    n.className = "num";
    n.textContent = "+" + number;
    const t = document.createElement("span");
    t.className = "time";
    t.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    li.appendChild(n);
    li.appendChild(t);
    const list = $("log");
    list.prepend(li);
    while (list.children.length > 10) list.removeChild(list.lastChild);
  }

  async function send() {
    const r = computeNumber();
    const message = $("message").value.trim();
    if (!r.valid || !message || !connected || sending) return;
    sending = true;
    setSendMessage("", true);
    $("send").textContent = "Sending…";
    updateSendState();
    try {
      await api("/api/send", { method: "POST", body: JSON.stringify({ to: r.full, message }) });
      addLog(r.full);
      setSendMessage("Sent to +" + r.full + ".", true);
      $("message").value = "";
    } catch (err) {
      if (err.message !== "unauthorized") setSendMessage(err.message, false);
    } finally {
      sending = false;
      $("send").textContent = "Send message";
      updateSendState();
    }
  }

  $("send-form").addEventListener("submit", (e) => { e.preventDefault(); void send(); });
  $("message").addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); void send(); }
  });
  ["input", "change"].forEach((ev) => {
    ccEl.addEventListener(ev, updateSendState);
    $("number").addEventListener(ev, updateSendState);
    $("message").addEventListener(ev, updateSendState);
  });

  // ---------- boot ----------

  updateSendState();
  if (password) {
    api("/api/status")
      .then((s) => { showApp(); renderStatus(s); schedulePoll(s.status === "open" ? 10000 : 2000); })
      .catch((err) => { if (err.message !== "unauthorized") showLogin(err.message); });
  } else {
    showLogin("");
  }
})();
