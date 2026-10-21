# WA Quick Send

A web page that sends WhatsApp messages from your own number. A small Node server holds a linked-device session (the same mechanism as WhatsApp Web) using Baileys. The web page talks to that server.

**Read this first:** Baileys is unofficial and goes against WhatsApp's terms. Accounts can be restricted or banned. Keep it to light personal use: a few messages to people who know you, not bulk or cold messages. Default limits are 6 per minute and 100 per day.

## Run it locally first

Requires Node 20 or newer.

```bash
npm install
cp .env.example .env      # then set APP_PASSWORD (12+ characters)
npm run dev
```

1. Open http://localhost:3000 and sign in with `APP_PASSWORD`.
2. A QR code appears. On your phone: WhatsApp, Settings, Linked devices, Link a device, scan it.
3. Status turns to **Connected**. Enter a number and message, then Send.

The session is saved in `./auth`, so you only scan once.

## Use it from the PC (deploy)

The PC needs to reach the server over HTTPS, so the server must run somewhere that stays on. Any host that runs a Docker image with a persistent disk works (Railway, Render, Fly.io, a VPS).

- Build from the included `Dockerfile`.
- Set `APP_PASSWORD` as an environment variable.
- Mount a persistent volume at `/data`. Without it you will have to re-scan the QR code after every restart.
- Keep it to a single instance. Two servers using the same session will log each other out.
- Serve it over HTTPS (hosts above do this for you). The password travels in a request header.

## Safety notes

- The `auth` folder is your logged-in WhatsApp session. Never commit it, share it, or put it in a public image. `.gitignore` and `.dockerignore` already exclude it.
- Anyone with `APP_PASSWORD` can send as your number. Use a long passphrase. After 10 wrong passwords an IP is locked out for 15 minutes.
- To disconnect: use **Unlink number** on the page, or remove the device in WhatsApp, Settings, Linked devices.
- The daily counter resets when the server restarts.

## How it works

- `src/server.ts`: Express API (`/api/status`, `/api/send`, `/api/logout`), Baileys connection, rate limits, auth.
- `public/`: the web page (plain HTML, CSS, JS).
- Messages are checked with WhatsApp first, so a number that isn't on WhatsApp returns a clear error instead of failing silently.

Baileys changes often. If linking or sending stops working after an update, run `npm update @whiskeysockets/baileys` and check its release notes.
