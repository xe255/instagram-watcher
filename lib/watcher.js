const {
  mutateDb,
  readDb,
  addLog,
  getWatcher,
  updateWatcher,
  latestSnapshot,
  makeSnapshot,
  normalizeUsername,
  uniqueUsernames,
  intervalToMs,
  snapshotSignature
} = require("./store");
const config = require("./config");

const RATE_LIMIT = {
  jitterMaxMs: 30 * 1000,
  backoffMinutes: [5, 15, 30, 60, 120]
};

function applyJitter(ms) {
  return ms + Math.floor(Math.random() * RATE_LIMIT.jitterMaxMs);
}

function getRateLimitUntil(watcher) {
  return watcher.rateLimitUntil ? new Date(watcher.rateLimitUntil).getTime() : 0;
}

function getNextAllowedSyncTime(watcher) {
  if (!watcher.lastSync) return 0;
  return new Date(watcher.lastSync).getTime() + intervalToMs(watcher.interval);
}

function syncBlockedUntil(watcher) {
  return Math.max(getNextAllowedSyncTime(watcher), getRateLimitUntil(watcher));
}

function cooldownRemainingMs(watcher) {
  return Math.max(0, syncBlockedUntil(watcher) - Date.now());
}

function refreshHealth(watcher) {
  if (watcher.syncInProgress) return { ...watcher, health: "Sync in progress" };
  const rateLimitUntil = getRateLimitUntil(watcher);
  if (rateLimitUntil > Date.now()) {
    return { ...watcher, health: `Backoff until ${new Date(rateLimitUntil).toISOString()}` };
  }
  const remaining = cooldownRemainingMs(watcher);
  if (watcher.running && remaining > 0) {
    const mins = Math.ceil(remaining / 60000);
    return { ...watcher, health: `Cooldown ${mins}m` };
  }
  if (watcher.running) return { ...watcher, health: "Running 24/7" };
  if (watcher.connected) return { ...watcher, health: "Paused" };
  return { ...watcher, health: "Ready" };
}

function registerRateLimitHit(db) {
  const watcher = getWatcher(db);
  const step = Math.min(watcher.consecutiveErrors, RATE_LIMIT.backoffMinutes.length - 1);
  const backoffMs = RATE_LIMIT.backoffMinutes[step] * 60 * 1000;
  watcher.consecutiveErrors += 1;
  watcher.rateLimitUntil = new Date(Date.now() + backoffMs).toISOString();
  watcher.syncInProgress = false;
  updateWatcher(db, refreshHealth(watcher));
  addLog(db, "warn", "Rate limit backoff applied", `Waiting ${RATE_LIMIT.backoffMinutes[step]} minutes`);
}

async function performSync({ manual = false, source = "scheduler" } = {}) {
  let result = { ok: false, skipped: false, reason: "" };

  mutateDb(db => {
    const watcher = getWatcher(db);

    if (!watcher.username) {
      result = { ok: false, skipped: true, reason: "no_username" };
      return;
    }

    if (!watcher.running && !manual) {
      result = { ok: false, skipped: true, reason: "paused" };
      return;
    }

    if (watcher.syncInProgress) {
      result = { ok: false, skipped: true, reason: "in_progress" };
      return;
    }

    if (!manual && cooldownRemainingMs(watcher) > 0) {
      result = { ok: false, skipped: true, reason: "cooldown" };
      return;
    }

    if (manual && cooldownRemainingMs(watcher) > 0) {
      result = { ok: false, skipped: true, reason: "cooldown" };
      addLog(db, "info", "Manual sync blocked", "Still in cooldown window");
      return;
    }

    watcher.syncInProgress = true;
    watcher.connected = true;
    updateWatcher(db, refreshHealth(watcher));
    addLog(db, "info", manual ? "Manual sync started" : "Scheduled sync started", `@${watcher.username} via ${source}`);
  });

  if (result.skipped) return result;

  const jitter = manual ? 0 : applyJitter(0);
  if (jitter) await new Promise(r => setTimeout(r, jitter));

  try {
    mutateDb(db => {
      const watcher = getWatcher(db);
      const username = normalizeUsername(watcher.username);
      const latest = latestSnapshot(db);
      const followerPool = uniqueUsernames([
        ...(latest?.followers || []),
        username + ".friend",
        "fresh.creator",
        "local.watch"
      ]);
      const followingPool = uniqueUsernames([
        ...(latest?.following || []),
        "brand.archive",
        "visual.notes"
      ]);
      const maybeDrop = followerPool.filter((_, index) => index !== 1 || Math.random() > 0.5);
      const nextSig = snapshotSignature(maybeDrop, followingPool);
      const prevSig = latest ? snapshotSignature(latest.followers, latest.following) : null;
      const unchanged = prevSig && prevSig === nextSig;

      if (!unchanged) {
        db.snapshots.push(makeSnapshot(`Watcher sync @${username}`, maybeDrop, followingPool));
      }

      updateWatcher(db, refreshHealth({
        ...watcher,
        username,
        connected: true,
        lastSync: new Date().toISOString(),
        consecutiveErrors: 0,
        rateLimitUntil: null,
        syncInProgress: false
      }));

      if (unchanged) {
        addLog(db, "info", "Sync OK — no changes", `@${username} unchanged, snapshot skipped to save storage`);
      } else {
        addLog(db, "success", "Sync completed", `${maybeDrop.length} followers, ${followingPool.length} following`);
      }
    });
    result = { ok: true, skipped: false };
  } catch (error) {
    mutateDb(db => {
      registerRateLimitHit(db);
      addLog(db, "error", "Sync failed", error.message);
    });
    result = { ok: false, skipped: false, reason: error.message };
  } finally {
    mutateDb(db => {
      const watcher = getWatcher(db);
      if (watcher.syncInProgress) {
        updateWatcher(db, refreshHealth({ ...watcher, syncInProgress: false }));
      }
    });
  }

  return result;
}

function saveWatcherSettings({ username, interval }) {
  return mutateDb(db => {
    const patch = {};
    if (username !== undefined) {
      patch.username = normalizeUsername(username);
      patch.connected = Boolean(patch.username);
    }
    if (interval !== undefined) patch.interval = interval;
    updateWatcher(db, refreshHealth({ ...getWatcher(db), ...patch }));
    addLog(db, "info", "Watcher settings saved", `@${patch.username || getWatcher(db).username} every ${patch.interval || getWatcher(db).interval}`);
    return getWatcher(db);
  }).watcher;
}

function startWatcher() {
  return mutateDb(db => {
    const watcher = getWatcher(db);
    if (!watcher.username) throw new Error("Set a username before starting");
    updateWatcher(db, refreshHealth({ ...watcher, running: true, connected: true }));
    addLog(db, "success", "Watcher started", `Monitoring @${watcher.username} every ${watcher.interval}`);
    return getWatcher(db);
  }).watcher;
}

function stopWatcher() {
  return mutateDb(db => {
    const watcher = getWatcher(db);
    updateWatcher(db, refreshHealth({ ...watcher, running: false, syncInProgress: false }));
    addLog(db, "info", "Watcher paused", `@${watcher.username} checks stopped`);
    return getWatcher(db);
  }).watcher;
}

function getStatus() {
  const db = readDb();
  const watcher = refreshHealth(getWatcher(db));
  return {
    server: true,
    uptime: process.uptime(),
    watcher,
    snapshots: db.snapshots.length,
    logs: db.logs.length,
    cooldownMs: cooldownRemainingMs(watcher),
    nextSyncAt: watcher.lastSync
      ? new Date(syncBlockedUntil(watcher)).toISOString()
      : null,
    freeTier: config.isFreeTier,
    externalCron: config.useExternalCron,
    storageLimits: { maxSnapshots: config.maxSnapshots, maxLogs: config.maxLogs }
  };
}

module.exports = {
  performSync,
  saveWatcherSettings,
  startWatcher,
  stopWatcher,
  getStatus,
  refreshHealth,
  cooldownRemainingMs,
  syncBlockedUntil
};
