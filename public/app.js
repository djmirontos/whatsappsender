(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const KEY = "wa:pw";

  // ---------- state ----------

  let password = "";
  try { password = sessionStorage.getItem(KEY) || ""; } catch {}

  let connected = false;
  let currentJid = null;
  let sseController = null;

  const conversations = new Map(); // jid -> { jid, lastMessage }
  const messages = new Map();      // jid -> StoredMessage[]

  // ---------- api ----------

  async function api(path, options = {}) {
    const res = await fetch(path, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + password,
        ...(options.headers ?? {}),
      },
    });
    let body = null;
    try { body = await res.json(); } catch {}
    if (res.status === 401) { signOut("Wrong password."); throw new Error("unauthorized"); }
    if (!res.ok) throw new Error(body?.error || `Request failed (${res.status}).`);
    return body;
  }

  // ---------- auth ----------

  function showLogin(msg) {
    stopSSE();
    $("login-screen").hidden = false;
    $("app-screen").hidden = true;
    const err = $("login-error");
    err.hidden = !msg;
    err.textContent = msg || "";
    setTimeout(() => $("password").focus(), 0);
  }

  function signOut(msg) {
    password = "";
    currentJid = null;
    conversations.clear();
    messages.clear();
    try { sessionStorage.removeItem(KEY); } catch {}
    showLogin(msg);
  }

  $("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const pw = $("password").value.trim();
    if (!pw) return;
    password = pw;
    try {
      await api("/api/status");
      try { sessionStorage.setItem(KEY, password); } catch {}
      $("password").value = "";
      $("login-screen").hidden = true;
      $("app-screen").hidden = false;
      await loadInitialData();
      startSSE();
    } catch (err) {
      if (err.message !== "unauthorized") {
        const el = $("login-error");
        el.textContent = err.message;
        el.hidden = false;
      }
    }
  });

  $("signout-btn").addEventListener("click", () => signOut(""));

  $("unlink-btn").addEventListener("click", async () => {
    if (!confirm("Unlink this number from the server? You'll need to scan a new QR code to reconnect.")) return;
    try { await api("/api/logout", { method: "POST" }); }
    catch (err) { if (err.message !== "unauthorized") alert(err.message); }
  });

  // ---------- status / SSE ----------

  const STATUS_LABEL = {
    starting: "Starting", connecting: "Connecting", qr: "Link needed",
    open: "Connected", logged_out: "Unlinked",
  };

  function applyStatus({ status, me, qr }) {
    const badge = $("badge");
    badge.textContent = STATUS_LABEL[status] ?? status;
    badge.dataset.state = status;

    connected = status === "open";
    $("me-num").textContent = me ? "+" + me : "";
    $("unlink-btn").hidden = !connected;
    updateSendState();

    const showQR = status === "qr" && !!qr;
    $("qr-overlay").hidden = !showQR;
    if (showQR) $("qr-img").src = qr;
    else $("qr-img").src = "";
  }

  function stopSSE() {
    if (sseController) { sseController.abort(); sseController = null; }
  }

  async function startSSE() {
    while (true) {
      if (!password) break;
      try {
        const controller = new AbortController();
        sseController = controller;
        const resp = await fetch("/api/stream", {
          headers: { "Authorization": "Bearer " + password },
          signal: controller.signal,
        });
        if (!resp.ok || !resp.body) { await sleep(5000); continue; }
        const reader = resp.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const parts = buf.split("\n\n");
          buf = parts.pop() ?? "";
          for (const part of parts) {
            for (const line of part.split("\n")) {
              if (line.startsWith("data: ")) {
                try { handleSSE(JSON.parse(line.slice(6))); } catch {}
              }
            }
          }
        }
      } catch (err) {
        if (err?.name === "AbortError") break;
      }
      await sleep(3000);
    }
  }

  function handleSSE(data) {
    if (data.type === "status") {
      applyStatus(data);
    } else if (data.type === "message") {
      const { jid, message } = data;
      ingestMessage(jid, message);
    }
  }

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  // ---------- data loading ----------

  async function loadInitialData() {
    try {
      const [statusData, convData] = await Promise.all([
        api("/api/status"),
        api("/api/conversations"),
      ]);
      applyStatus(statusData);
      for (const conv of convData) {
        conversations.set(conv.jid, conv);
      }
      renderConvList();
    } catch (err) {
      if (err.message !== "unauthorized") console.warn("loadInitialData:", err.message);
    }
  }

  async function loadMessages(jid) {
    if (messages.has(jid)) return;
    try {
      const msgs = await api("/api/messages/" + encodeURIComponent(jid));
      messages.set(jid, msgs);
    } catch (err) {
      if (err.message !== "unauthorized") console.warn("loadMessages:", err.message);
      messages.set(jid, []);
    }
  }

  // ---------- conversations ----------

  function ingestMessage(jid, msg) {
    // store in message cache
    const list = messages.get(jid) ?? [];
    if (!list.some((m) => m.id === msg.id)) {
      list.push(msg);
      messages.set(jid, list);
    }
    // update conversation preview
    const conv = conversations.get(jid) ?? { jid, lastMessage: null };
    conv.lastMessage = msg;
    conversations.set(jid, conv);
    renderConvList();
    // append bubble if this chat is open
    if (jid === currentJid) {
      appendBubble(msg, true);
    }
  }

  function jidDisplay(jid) {
    return "+" + jid.replace(/@.*$/, "");
  }

  function renderConvList() {
    const list = $("conv-list");
    const empty = $("conv-empty");
    list.innerHTML = "";

    const sorted = Array.from(conversations.values())
      .sort((a, b) => (b.lastMessage?.timestamp ?? 0) - (a.lastMessage?.timestamp ?? 0));

    empty.hidden = sorted.length > 0;

    for (const conv of sorted) {
      const item = document.createElement("div");
      item.className = "conv-item" + (conv.jid === currentJid ? " active" : "");
      item.dataset.jid = conv.jid;

      const name = document.createElement("div");
      name.className = "conv-name";
      name.textContent = jidDisplay(conv.jid);

      const preview = document.createElement("div");
      preview.className = "conv-preview";
      if (conv.lastMessage) {
        preview.textContent = (conv.lastMessage.fromMe ? "You: " : "") + conv.lastMessage.text;
      }

      const timeEl = document.createElement("div");
      timeEl.className = "conv-time";
      if (conv.lastMessage) timeEl.textContent = fmtTime(conv.lastMessage.timestamp);

      item.appendChild(name);
      item.appendChild(preview);
      item.appendChild(timeEl);
      item.addEventListener("click", () => void openChat(conv.jid));
      list.appendChild(item);
    }
  }

  // ---------- chat view ----------

  async function openChat(jid) {
    currentJid = jid;
    $("empty-state").hidden = true;
    $("chat-view").hidden = false;
    $("chat-contact").textContent = jidDisplay(jid);
    $("message-list").innerHTML = "";
    $("compose-error").hidden = true;
    $("compose-text").value = "";
    updateSendState();
    renderConvList(); // refresh active highlight

    await loadMessages(jid);
    const msgs = messages.get(jid) ?? [];
    $("message-list").innerHTML = "";
    for (const msg of msgs) appendBubble(msg, false);
    scrollBottom();
    $("compose-text").focus();
  }

  function appendBubble(msg, animate) {
    const list = $("message-list");
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;

    // deduplicate DOM
    if (list.querySelector(`[data-id="${CSS.escape(msg.id)}"]`)) return;

    const wrap = document.createElement("div");
    wrap.className = "msg " + (msg.fromMe ? "out" : "in");
    wrap.dataset.id = msg.id;
    if (animate) wrap.style.opacity = "0";

    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.textContent = msg.text;

    const time = document.createElement("div");
    time.className = "msg-time";
    time.textContent = fmtTime(msg.timestamp);

    wrap.appendChild(bubble);
    wrap.appendChild(time);
    list.appendChild(wrap);

    if (animate) {
      requestAnimationFrame(() => {
        wrap.style.transition = "opacity 0.15s";
        wrap.style.opacity = "1";
      });
    }

    if (nearBottom || msg.fromMe) scrollBottom();
  }

  function scrollBottom() {
    const list = $("message-list");
    list.scrollTop = list.scrollHeight;
  }

  // ---------- compose ----------

  function updateSendState() {
    const text = $("compose-text")?.value.trim() ?? "";
    const btn = $("compose-send");
    if (btn) btn.disabled = !connected || !text || !currentJid;
  }

  $("compose-text").addEventListener("input", () => {
    updateSendState();
    autoGrow($("compose-text"));
  });

  $("compose-text").addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      void doSend();
    }
  });

  $("compose-form").addEventListener("submit", (e) => {
    e.preventDefault();
    void doSend();
  });

  async function doSend() {
    if (!connected || !currentJid) return;
    const text = $("compose-text").value.trim();
    if (!text) return;

    const jid = currentJid;
    const to = jid.replace(/@.*$/, "");

    $("compose-text").value = "";
    $("compose-text").style.height = "";
    updateSendState();
    $("compose-error").hidden = true;

    try {
      const result = await api("/api/send", {
        method: "POST",
        body: JSON.stringify({ to, message: text }),
      });
      // Optimistically show the message; SSE will also deliver it — dedup by id prevents doubles
      const localMsg = {
        id: result.id ?? ("local-" + Date.now()),
        jid: result.jid ?? jid,
        fromMe: true,
        text,
        timestamp: Date.now(),
      };
      ingestMessage(localMsg.jid, localMsg);
    } catch (err) {
      if (err.message !== "unauthorized") {
        const el = $("compose-error");
        el.textContent = err.message;
        el.hidden = false;
        // restore the text so the user doesn't lose their message
        $("compose-text").value = text;
        updateSendState();
      }
    }
  }

  function autoGrow(el) {
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 120) + "px";
  }

  // ---------- new chat ----------

  $("new-chat-btn").addEventListener("click", () => {
    const panel = $("new-chat-panel");
    const showing = !panel.hidden;
    panel.hidden = showing;
    if (!showing) {
      $("new-number").value = "";
      $("new-chat-error").hidden = true;
      $("new-number").focus();
    }
  });

  $("new-chat-cancel").addEventListener("click", () => {
    $("new-chat-panel").hidden = true;
  });

  $("new-number").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); openNewChat(); }
  });

  $("new-chat-open").addEventListener("click", openNewChat);

  function openNewChat() {
    const raw = $("new-number").value.replace(/\D/g, "");
    const err = $("new-chat-error");
    if (raw.length < 8 || raw.length > 15) {
      err.textContent = "Enter a valid number with country code — digits only, 8 to 15 digits (e.g. 12125551234).";
      err.hidden = false;
      return;
    }
    err.hidden = true;
    $("new-chat-panel").hidden = true;
    const jid = raw + "@s.whatsapp.net";
    if (!conversations.has(jid)) {
      conversations.set(jid, { jid, lastMessage: null });
      renderConvList();
    }
    void openChat(jid);
  }

  // ---------- utils ----------

  function fmtTime(ms) {
    const d = new Date(ms);
    const isToday = new Date().toDateString() === d.toDateString();
    return isToday
      ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : d.toLocaleDateString([], { month: "short", day: "numeric" });
  }

  // ---------- boot ----------

  updateSendState();
  if (password) {
    $("login-screen").hidden = true;
    $("app-screen").hidden = false;
    loadInitialData().then(() => startSSE());
  } else {
    showLogin("");
  }
})();
