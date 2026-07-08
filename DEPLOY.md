# Instagram Watcher — Free deploy (no credit card)

Fly.io requires a credit card. Use one of these instead.

---

## Option 1: Belmo (recommended — no card, 24/7)

[Belmo](https://belmo.io/deploy/nodejs) offers **one free always-on Node.js app**, no credit card, no sleep on idle.

1. Push this project to GitHub
2. Sign up at [belmo.io](https://belmo.io) (GitHub login)
3. **New service** → connect your repo
4. Settings:
   - **Start command:** `npm start`
   - **Port:** `3000`
   - **Env:** `DATA_DIR=/app/data` (or platform default persistent path if offered)
5. Deploy → open your `*.belmo.app` URL on your phone

---

## Option 2: JustRunMy.App (no card — zip upload)

[JustRunMy.App](https://justrunmy.app/) — free tier, no credit card, always-on container.

1. Zip this entire folder (include `package.json`, `server.js`, `lib/`, `public/`)
2. Sign up at [justrunmy.app](https://justrunmy.app/)
3. **Zip Upload** → upload the zip
4. Set **port** to `3000`, start command `npm start`
5. Add env `DATA_DIR=/data` if the panel supports it

---

## Option 3: Your PC + Cloudflare Tunnel (100% free)

Runs on your Windows PC. No hosting signup beyond a free Cloudflare account (no card for basic tunnel).

**Terminal 1 — start the app:**
```powershell
cd "E:\AI Projects\Instagram Watcher tool"
npm install
npm start
```

**Terminal 2 — expose to the internet:**
```powershell
# Install: winget install Cloudflare.cloudflared
cloudflared tunnel --url http://localhost:3000
```

Cloudflared prints a public `https://*.trycloudflare.com` URL — open it on your phone.  
Your PC must stay on; the watcher runs 24/7 locally.

For a **fixed URL**, set up a free named Cloudflare Tunnel:  
https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/

---

## Option 4: Render (free, may sleep) + cron-job.org

If Render lets you sign up without a card:

1. Push to GitHub → [Render](https://render.com) → New Web Service → connect repo
2. Build: `npm install` · Start: `npm start`
3. Add env `CRON_SECRET=your-random-secret`
4. On [cron-job.org](https://cron-job.org) (free, no card):
   - URL: `https://YOUR-APP.onrender.com/api/cron/tick?secret=your-random-secret`
   - Every **5 minutes**

This wakes Render and triggers sync checks even when the built-in scheduler is asleep.

---

## After deploy

1. Open your public URL on mobile
2. Enter Instagram username → **Save**
3. Tap **Start 24/7**
4. Check **Logs** tab to confirm syncs are running

---

## Requires credit card (skip if you don't want that)

| Platform | Notes |
|----------|-------|
| Fly.io | Always-on, but card required |
| Railway | Limited free credits, card required |
| Oracle Cloud | Free VM forever, card for verification only |

---

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP port (set by host) |
| `DATA_DIR` | `./data` | Where settings/logs are saved |
| `CRON_SECRET` | _(none)_ | Protect `/api/cron/tick` on public hosts |
