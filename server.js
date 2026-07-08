const crypto = require("crypto");
const express = require("express");
const path = require("path");
const {
  readDb,
  mutateDb,
  addLog,
  makeSnapshot,
  uniqueUsernames,
  getWatcher
} = require("./lib/store");
const {
  performSync,
  saveWatcherSettings,
  startWatcher,
  stopWatcher,
  getStatus,
  refreshHealth
} = require("./lib/watcher");
const { startScheduler } = require("./lib/scheduler");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/status", (_req, res) => {
  res.json(getStatus());
});

app.get("/api/watcher", (_req, res) => {
  const db = readDb();
  res.json(refreshHealth(getWatcher(db)));
});

app.put("/api/watcher", (req, res) => {
  try {
    const watcher = saveWatcherSettings({
      username: req.body.username,
      interval: req.body.interval
    });
    res.json(refreshHealth(watcher));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/watcher/start", (_req, res) => {
  try {
    const watcher = startWatcher();
    performSync({ manual: true, source: "start" }).catch(console.error);
    res.json(refreshHealth(watcher));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/watcher/stop", (_req, res) => {
  const watcher = stopWatcher();
  res.json(refreshHealth(watcher));
});

app.post("/api/watcher/sync", async (_req, res) => {
  const result = await performSync({ manual: true, source: "manual" });
  const db = readDb();
  res.json({ ...result, watcher: refreshHealth(getWatcher(db)) });
});

app.get("/api/snapshots", (_req, res) => {
  const db = readDb();
  res.json(db.snapshots.sort((a, b) => new Date(b.date) - new Date(a.date)));
});

app.post("/api/snapshots/import", (req, res) => {
  try {
    const { followers, following, label } = req.body;
    if (!Array.isArray(followers) || !Array.isArray(following)) {
      return res.status(400).json({ error: "followers and following arrays required" });
    }
    const snapshot = mutateDb(db => {
      const snap = makeSnapshot(
        label || `Import ${new Date().toLocaleDateString()}`,
        followers,
        following
      );
      db.snapshots.push(snap);
      addLog(db, "success", "Import saved", `${snap.followers.length} followers, ${snap.following.length} following`);
      return snap;
    }).snapshots.at(-1);
    res.json(snapshot);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get("/api/logs", (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const db = readDb();
  res.json(db.logs.slice(0, limit));
});

app.delete("/api/logs", (_req, res) => {
  mutateDb(db => {
    db.logs = [];
    addLog(db, "info", "Logs cleared", "User cleared log history");
  });
  res.json({ ok: true });
});

app.get("/api/export", (_req, res) => {
  const db = readDb();
  res.json({
    exportedAt: new Date().toISOString(),
    app: "Instagram Watcher",
    version: 2,
    watcher: getWatcher(db),
    snapshots: db.snapshots,
    logs: db.logs
  });
});

app.post("/api/restore", (req, res) => {
  try {
    const { watcher, snapshots, logs } = req.body;
    mutateDb(db => {
      if (watcher) db.watcher = { ...db.watcher, ...watcher };
      if (Array.isArray(snapshots) && snapshots.length) {
        db.snapshots = snapshots.map(s => ({
          id: s.id || crypto.randomUUID(),
          label: s.label || "Restored snapshot",
          date: s.date || new Date().toISOString(),
          followers: uniqueUsernames(s.followers || []),
          following: uniqueUsernames(s.following || [])
        }));
      }
      if (Array.isArray(logs)) db.logs = logs.slice(0, 500);
      addLog(db, "info", "Data restored", `${db.snapshots.length} snapshots loaded`);
    });
    res.json(getStatus());
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// External cron ping (for hosts that sleep, or free cron-job.org keepalive)
app.get("/api/cron/tick", async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (secret && req.query.secret !== secret) {
    return res.status(401).json({ error: "Invalid cron secret" });
  }
  const result = await performSync({ manual: false, source: "cron" });
  res.json({ ...result, status: getStatus() });
});

app.post("/api/cron/tick", async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const provided = req.query.secret || req.headers["x-cron-secret"];
    if (provided !== secret) return res.status(401).json({ error: "Invalid cron secret" });
  }
  const result = await performSync({ manual: false, source: "cron" });
  res.json({ ...result, status: getStatus() });
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Instagram Watcher running on http://localhost:${PORT}`);
  startScheduler();
});
