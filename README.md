# Instagram Watcher

24/7 Instagram follower watcher with rate-limit-safe scheduling, mobile UI, server persistence, and activity logs.

## Quick start (local)

```bash
npm install
npm start
```

Open **http://localhost:3000** on your phone or desktop.

## How it works

1. **Save** your Instagram username and check interval (default: every **30 minutes** — do not use 5m with a real session)
2. **Start 24/7** — the server runs checks in the background, even when you close the browser
3. **Pause** anytime from the dashboard — your settings stay saved
4. **Logs tab** — see every sync, start/stop, and error
5. **Import** official Instagram export files as a fallback

Rate-limit protection: interval cooldown, spam-flag detection (`feedback_required`), auto-pause + multi-hour backoff, and manual sync blocked while backoff is active.

---

## Free hosting — NO credit card

Fly.io requires a credit card. **Use one of these instead:**

| Option | 24/7? | Card? | How |
|--------|-------|-------|-----|
| **[Belmo](https://belmo.io/deploy/nodejs)** | Yes | No | Connect GitHub repo, `npm start`, port 3000 |
| **[JustRunMy.App](https://justrunmy.app/)** | Yes | No | Zip upload, port 3000 |
| **Your PC + Cloudflare Tunnel** | Yes* | No | `npm start` + `cloudflared tunnel --url http://localhost:3000` |
| **Render + [cron-job.org](https://cron-job.org)** | Mostly** | Maybe | Ping `/api/cron/tick` every 5 min |

\*While your PC is on  
\*\*Render free tier sleeps; external cron wakes it and runs sync

**Full step-by-step:** see **[DEPLOY.md](./DEPLOY.md)**

### Fastest path (Belmo)

1. Push this repo to GitHub
2. Sign up at [belmo.io](https://belmo.io) — no credit card
3. New Node service → connect repo → start command `npm start` → port `3000`
4. Open your app URL, save username, tap **Start 24/7**

### Run on your PC (zero signup)

```powershell
npm start
# second terminal:
cloudflared tunnel --url http://localhost:3000
```

Use the `trycloudflare.com` URL on your phone.

---

## Mobile usage

- Bottom navigation on phones: **Home**, **Lists**, **Logs**, **Data**
- Touch-friendly buttons (44px targets)
- Safe area support for iPhone notches
- Add to Home Screen (Safari/Chrome) for an app-like icon

---

## API endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/status` | Server + watcher status |
| PUT | `/api/watcher` | Save username & interval |
| POST | `/api/watcher/start` | Start 24/7 monitoring |
| POST | `/api/watcher/stop` | Pause monitoring |
| POST | `/api/watcher/sync` | Manual sync (respects cooldown) |
| GET/POST | `/api/cron/tick` | External cron trigger (optional `CRON_SECRET`) |
| GET | `/api/logs` | Activity logs |
| GET | `/api/snapshots` | All snapshots |

---

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP port |
| `DATA_DIR` | `./data` | Where db.json is stored |
| `CRON_SECRET` | _(none)_ | Secret for `/api/cron/tick?secret=...` |

---

## Requires credit card (optional)

| Platform | Notes |
|----------|-------|
| Fly.io | Always-on VM — see `fly.toml` if you have a card |
| Railway | Limited free credits |
| Oracle Cloud | Free VM forever, card for verification |

---

## Project structure

```
server.js           Express server + API
lib/store.js        JSON file persistence
lib/watcher.js      Sync logic + rate limits
lib/scheduler.js    Background 24/7 scheduler
public/index.html   Mobile-friendly dashboard
DEPLOY.md           No-card hosting guide
Dockerfile          Container deploys
```

---

## Notes

- The sync engine currently simulates follower updates (prototype). Wire in a compliant Instagram data source when ready — the scheduler, logs, and rate-limit layer are production-ready.
- Without a server, the app falls back to browser-only mode (IndexedDB) — checks only run while the tab is open.
