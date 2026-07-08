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
const { fetchInstagramFollowersAndFollowing } = require("./instagram");

const RATE_LIMIT = {
  jitterMaxMs: 5 * 1000,
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
  let canProceed = true;
  let watcherStatus;

  mutateDb(db => {
    const watcher = getWatcher(db);
    watcherStatus = watcher;

    if (!watcher.targetUsername && !watcher.username) {
      result = { ok: false, skipped: true, reason: "no_username" };
      canProceed = false;
      return;
    }

    if (!watcher.running && !manual) {
      result = { ok: false, skipped: true, reason: "paused" };
      canProceed = false;
      return;
    }

    if (watcher.syncInProgress) {
      result = { ok: false, skipped: true, reason: "in_progress" };
      canProceed = false;
      return;
    }

    if (!manual && cooldownRemainingMs(watcher) > 0) {
      result = { ok: false, skipped: true, reason: "cooldown" };
      canProceed = false;
      return;
    }


    watcher.syncInProgress = true;
    watcher.connected = true;
    updateWatcher(db, refreshHealth(watcher));
    const targetUser = watcher.targetUsername || watcher.username;
    addLog(db, "info", manual ? "Manual sync started" : "Scheduled sync started", `@${targetUser} via ${source}`);
  });

  if (!canProceed) return result;

  const jitter = manual ? 0 : applyJitter(0);
  if (jitter) await new Promise(r => setTimeout(r, jitter));

  try {
    const targetUser = normalizeUsername(watcherStatus.targetUsername || watcherStatus.username);
    let followerPool, followingPool;

    if (watcherStatus.adminSessionId) {
      // Real Instagram scraping using the logged-in session ID
      const data = await fetchInstagramFollowersAndFollowing(targetUser, watcherStatus.adminSessionId);
      followerPool = data.followers;
      followingPool = data.following;
    } else {
      // Simulator Demo mode fallback
      const dbSnapshot = readDb();
      const latest = latestSnapshot(dbSnapshot);
      followerPool = uniqueUsernames([
        ...(latest?.followers || []),
        targetUser + ".friend",
        "fresh.creator",
        "local.watch"
      ]);
      followingPool = uniqueUsernames([
        ...(latest?.following || []),
        "brand.archive",
        "visual.notes"
      ]);
    }

    mutateDb(db => {
      const watcher = getWatcher(db);
      const latest = latestSnapshot(db);
      
      let finalFollowers = followerPool;
      let finalFollowing = followingPool;

      if (!watcher.adminSessionId) {
        // Simulation drop a follower sometimes to simulate activity
        finalFollowers = followerPool.filter((_, index) => index !== 1 || Math.random() > 0.5);
      }

      const nextSig = snapshotSignature(finalFollowers, finalFollowing);
      const prevSig = latest ? snapshotSignature(latest.followers, latest.following) : null;
      const unchanged = prevSig && prevSig === nextSig;

      if (!unchanged) {
        db.snapshots.push(makeSnapshot(`Watcher sync @${targetUser}`, finalFollowers, finalFollowing));
      }

      updateWatcher(db, refreshHealth({
        ...watcher,
        connected: true,
        lastSync: new Date().toISOString(),
        consecutiveErrors: 0,
        rateLimitUntil: null,
        syncInProgress: false
      }));

      if (unchanged) {
        addLog(db, "info", "Sync OK — no changes", `@${targetUser} unchanged, snapshot skipped to save storage`);
      } else {
        addLog(db, "success", "Sync completed", `${finalFollowers.length} followers, ${finalFollowing.length} following`);
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

function saveWatcherSettings({ adminUsername, adminSessionId, targetUsername, interval }) {
  return mutateDb(db => {
    const patch = {};
    if (adminUsername !== undefined) patch.adminUsername = adminUsername.trim();
    if (adminSessionId !== undefined) patch.adminSessionId = adminSessionId.trim();
    if (targetUsername !== undefined) {
      patch.targetUsername = normalizeUsername(targetUsername);
      patch.username = patch.targetUsername; // backwards compatibility
    }
    if (interval !== undefined) patch.interval = interval;
    
    const activeWatcher = { ...getWatcher(db), ...patch };
    patch.connected = Boolean(activeWatcher.targetUsername || activeWatcher.username);
    patch.consecutiveErrors = 0;
    patch.rateLimitUntil = null;
    
    updateWatcher(db, refreshHealth({ ...getWatcher(db), ...patch }));
    
    const displayUser = patch.targetUsername || getWatcher(db).targetUsername || getWatcher(db).username || "nobody";
    addLog(db, "info", "Watcher settings saved", `@${displayUser} every ${patch.interval || getWatcher(db).interval}`);
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
    storageLimits: { maxSnapshots: config.maxSnapshots, maxLogs: config.maxLogs },
    storageType: (config.gistId && config.githubToken) ? "gist" : "local"
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
