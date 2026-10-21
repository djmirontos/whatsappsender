import "dotenv/config";
import { createHash, timingSafeEqual } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import pino from "pino";
import QRCode from "qrcode";
import { z } from "zod";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  type WASocket,
} from "@whiskeysockets/baileys";

// ---------- config ----------

function intEnv(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const APP_PASSWORD = process.env.APP_PASSWORD ?? "";
if (APP_PASSWORD.length < 12) {
  console.error("Set APP_PASSWORD in .env (at least 12 characters). Anyone with it can send as your number.");
  process.exit(1);
}

const PORT = intEnv("PORT", 3000);
const AUTH_DIR = path.resolve(process.env.AUTH_DIR ?? "./auth");
const MAX_PER_MINUTE = intEnv("MAX_PER_MINUTE", 6);
const MAX_PER_DAY = intEnv("MAX_PER_DAY", 100);
const TRUST_PROXY = process.env.TRUST_PROXY === "1";

const log = pino({ level: process.env.LOG_LEVEL ?? "info" });
const baileysLogger = log.child({ module: "baileys" }, { level: "warn" });

// ---------- message store ----------

interface StoredMessage {
  id: string;
  jid: string;
  fromMe: boolean;
  text: string;
  timestamp: number; // ms
}

const chatStore = new Map<string, StoredMessage[]>();
const MAX_MSGS_PER_CHAT = 200;

function storeMessage(msg: StoredMessage): boolean {
  const list = chatStore.get(msg.jid) ?? [];
  if (list.some((m) => m.id === msg.id)) return false;
  list.push(msg);
  if (list.length > MAX_MSGS_PER_CHAT) list.shift();
  chatStore.set(msg.jid, list);
  return true;
}

// ---------- SSE ----------

const sseClients = new Set<Response>();

function broadcastSSE(payload: object): void {
  const chunk = "data: " + JSON.stringify(payload) + "\n\n";
  for (const res of sseClients) {
    try { res.write(chunk); } catch { sseClients.delete(res); }
  }
}

// ---------- helpers ----------

function tsToMs(ts: unknown): number {
  if (ts == null) return Date.now();
  if (typeof ts === "number") return ts * 1000;
  if (typeof ts === "object" && "toNumber" in (ts as object)) {
    return (ts as { toNumber(): number }).toNumber() * 1000;
  }
  return Date.now();
}

function extractText(raw: { message?: unknown }): string {
  const m = raw.message as Record<string, unknown> | null | undefined;
  if (!m) return "[no content]";
  if (typeof m["conversation"] === "string") return m["conversation"];
  const ext = m["extendedTextMessage"] as { text?: string } | undefined;
  if (ext?.text) return ext.text;
  const img = m["imageMessage"] as { caption?: string } | undefined;
  if (img) return img.caption ? `[Photo] ${img.caption}` : "[Photo]";
  const vid = m["videoMessage"] as { caption?: string } | undefined;
  if (vid) return vid.caption ? `[Video] ${vid.caption}` : "[Video]";
  if (m["audioMessage"]) return "[Voice message]";
  const doc = m["documentMessage"] as { fileName?: string } | undefined;
  if (doc) return `[Document: ${doc.fileName ?? "file"}]`;
  if (m["stickerMessage"]) return "[Sticker]";
  if (m["contactMessage"]) return "[Contact]";
  if (m["locationMessage"]) return "[Location]";
  return "[Unsupported message]";
}

// ---------- WhatsApp connection ----------

type Status = "starting" | "connecting" | "qr" | "open" | "logged_out";

let sock: WASocket | null = null;
let status: Status = "starting";
let qrDataUrl: string | null = null;
let me: string | null = null;
let attempts = 0;
let reconnectTimer: NodeJS.Timeout | null = null;

function scheduleReconnect(delayMs: number): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => { reconnectTimer = null; void connect(); }, delayMs);
}

async function connect(): Promise<void> {
  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    const socket = makeWASocket({
      version,
      auth: state,
      logger: baileysLogger,
      browser: Browsers.macOS("Desktop"),
      markOnlineOnConnect: false,
    });
    sock = socket;

    socket.ev.on("creds.update", saveCreds);
    socket.ev.on("connection.update", (update) => { void handleConnectionUpdate(socket, update); });

    socket.ev.on("messages.upsert", ({ messages, type }) => {
      if (socket !== sock) return;
      if (type !== "notify" && type !== "append") return;
      for (const raw of messages) {
        if (!raw.message) continue;
        const jid = raw.key.remoteJid;
        if (!jid || jid.endsWith("@broadcast")) continue;
        // skip protocol / key-distribution messages
        const m = raw.message as Record<string, unknown>;
        if (m["protocolMessage"] || m["senderKeyDistributionMessage"]) continue;

        const stored: StoredMessage = {
          id: raw.key.id ?? `${jid}-${Date.now()}`,
          jid,
          fromMe: raw.key.fromMe ?? false,
          text: extractText(raw),
          timestamp: tsToMs(raw.messageTimestamp),
        };
        if (storeMessage(stored)) {
          broadcastSSE({ type: "message", jid, message: stored });
        }
      }
    });
  } catch (err) {
    log.error({ err }, "failed to start WhatsApp connection");
    attempts += 1;
    scheduleReconnect(Math.min(30_000, 2_000 * attempts));
  }
}

async function handleConnectionUpdate(
  socket: WASocket,
  update: { connection?: string; qr?: string; lastDisconnect?: { error?: Error } },
): Promise<void> {
  if (socket !== sock) return;

  if (update.qr) {
    qrDataUrl = await QRCode.toDataURL(update.qr, { margin: 2, width: 280 });
    status = "qr";
    broadcastSSE({ type: "status", status, qr: qrDataUrl });
  }

  if (update.connection === "connecting" && status !== "qr") {
    status = "connecting";
    broadcastSSE({ type: "status", status });
  }

  if (update.connection === "open") {
    status = "open";
    qrDataUrl = null;
    attempts = 0;
    me = socket.user?.id.split(":")[0]?.split("@")[0] ?? null;
    log.info({ me }, "WhatsApp connected");
    broadcastSSE({ type: "status", status, me });
  }

  if (update.connection === "close") {
    const code = (update.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output
      ?.statusCode;
    sock = null;
    qrDataUrl = null;
    me = null;

    if (code === DisconnectReason.loggedOut) {
      log.warn("logged out from the phone, clearing session");
      status = "logged_out";
      broadcastSSE({ type: "status", status });
      await rm(AUTH_DIR, { recursive: true, force: true });
      attempts = 0;
      scheduleReconnect(1_000);
    } else {
      status = "connecting";
      attempts += 1;
      log.warn({ code, attempts }, "connection closed, reconnecting");
      broadcastSSE({ type: "status", status });
      scheduleReconnect(Math.min(30_000, 2_000 * attempts));
    }
  }
}

// ---------- rate limits ----------

const sentAt: number[] = [];

function checkSendLimit(now: number): string | null {
  while (sentAt.length > 0 && now - (sentAt[0] ?? now) > 86_400_000) sentAt.shift();
  if (sentAt.length >= MAX_PER_DAY) return `Daily limit of ${MAX_PER_DAY} messages reached.`;
  const lastMinute = sentAt.filter((t) => now - t < 60_000).length;
  if (lastMinute >= MAX_PER_MINUTE) return `Slow down: at most ${MAX_PER_MINUTE} messages per minute.`;
  return null;
}

const authFailures = new Map<string, { count: number; resetAt: number }>();
const MAX_AUTH_FAILURES = 10;
const AUTH_WINDOW_MS = 15 * 60_000;

// ---------- http ----------

const sha256 = (value: string): Buffer => createHash("sha256").update(value).digest();
const passwordHash = sha256(APP_PASSWORD);

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const ip = req.ip ?? "unknown";
  const now = Date.now();
  const entry = authFailures.get(ip);

  if (entry && entry.resetAt > now && entry.count >= MAX_AUTH_FAILURES) {
    res.status(429).json({ error: "Too many wrong passwords. Try again in 15 minutes." });
    return;
  }

  const header = req.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";

  if (!timingSafeEqual(sha256(token), passwordHash)) {
    const fresh = entry && entry.resetAt > now ? entry : { count: 0, resetAt: now + AUTH_WINDOW_MS };
    fresh.count += 1;
    authFailures.set(ip, fresh);
    res.status(401).json({ error: "Wrong password." });
    return;
  }

  authFailures.delete(ip);
  next();
}

const sendSchema = z.object({
  to: z.string().regex(/^\d{8,15}$/, "Enter the number with country code, digits only (8 to 15 digits)."),
  message: z.string().trim().min(1, "Message can't be empty.").max(4000, "Message is too long (4000 characters max)."),
});

const app = express();
if (TRUST_PROXY) app.set("trust proxy", 1);
app.disable("x-powered-by");

app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'",
  );
  next();
});
app.use(express.json({ limit: "10kb" }));

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
app.use(express.static(publicDir));

app.get("/healthz", (_req, res) => { res.json({ ok: true }); });

app.get("/api/status", requireAuth, (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ status, me, qr: qrDataUrl });
});

// Real-time SSE stream (uses fetch + ReadableStream on the client for auth header support)
app.get("/api/stream", requireAuth, (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // disable nginx buffering
  res.flushHeaders();

  // send current state immediately so the client doesn't have to poll
  res.write("data: " + JSON.stringify({ type: "status", status, me, qr: qrDataUrl }) + "\n\n");

  const hb = setInterval(() => {
    try { res.write(": heartbeat\n\n"); } catch { clearInterval(hb); sseClients.delete(res); }
  }, 25_000);

  sseClients.add(res);
  req.on("close", () => { clearInterval(hb); sseClients.delete(res); });
});

// List conversations sorted by most-recent message
app.get("/api/conversations", requireAuth, (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const convs = Array.from(chatStore.entries())
    .map(([jid, msgs]) => ({ jid, lastMessage: msgs.at(-1) ?? null }))
    .sort((a, b) => (b.lastMessage?.timestamp ?? 0) - (a.lastMessage?.timestamp ?? 0));
  res.json(convs);
});

// Messages for a single conversation
app.get("/api/messages/:jid", requireAuth, (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const jid = decodeURIComponent(req.params["jid"] ?? "");
  res.json(chatStore.get(jid) ?? []);
});

// Send a message
app.post("/api/send", requireAuth, async (req, res) => {
  const parsed = sendSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid request." });
    return;
  }

  const socket = sock;
  if (!socket || status !== "open") {
    res.status(503).json({ error: "WhatsApp isn't connected. Check the status indicator." });
    return;
  }

  const limitMessage = checkSendLimit(Date.now());
  if (limitMessage) {
    res.status(429).json({ error: limitMessage });
    return;
  }

  const { to, message } = parsed.data;
  let jid = `${to}@s.whatsapp.net`;

  try {
    const lookup = await socket.onWhatsApp(jid);
    const hit = lookup?.[0];
    if (hit && !hit.exists) {
      res.status(404).json({ error: "That number isn't on WhatsApp. Check the country code and digits." });
      return;
    }
    if (hit?.exists && hit.jid) jid = hit.jid;
  } catch (err) {
    log.warn({ err }, "number lookup failed, sending to the plain address");
  }

  try {
    const result = await socket.sendMessage(jid, { text: message });
    sentAt.push(Date.now());
    log.info({ to }, "message sent");

    if (result) {
      const stored: StoredMessage = {
        id: result.key.id ?? `sent-${Date.now()}`,
        jid,
        fromMe: true,
        text: message,
        timestamp: Date.now(),
      };
      if (storeMessage(stored)) {
        broadcastSSE({ type: "message", jid, message: stored });
      }
    }

    res.json({ ok: true, id: result?.key.id ?? null, jid });
  } catch (err) {
    log.error({ err }, "send failed");
    res.status(502).json({ error: "WhatsApp didn't accept the message. Try again in a moment." });
  }
});

// Unlink this device
app.post("/api/logout", requireAuth, async (_req, res) => {
  const socket = sock;
  try {
    if (socket) await socket.logout();
    res.json({ ok: true });
  } catch (err) {
    log.error({ err }, "logout failed");
    res.status(500).json({ error: "Couldn't unlink. Remove the device from WhatsApp on your phone instead." });
  }
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  log.error({ err }, "unhandled request error");
  res.status(500).json({ error: "Something went wrong on the server." });
});

process.on("unhandledRejection", (err) => log.error({ err }, "unhandled rejection"));

app.listen(PORT, () => {
  log.info(`Open http://localhost:${PORT}`);
  void connect();
});
