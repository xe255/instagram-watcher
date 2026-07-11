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
  backoffMinutes: [15, 30, 60, 120, 240],
  // feedback_required / is_spam = session-level anti-spam flag; needs hours, not minutes
  spamBackoffMinutes: [180, 360, 720]
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

function isSpamFlagError(errorMessage) {
  if (!errorMessage) return false;
  const msg = String(errorMessage).toLowerCase();
  return (
    msg.includes("feedback_required") ||
    msg.includes("\"is_spam\":true") ||
    msg.includes("is_spam\":true") ||
    msg.includes("session flagged") ||
    msg.includes("try again later")
  );
}

function registerRateLimitHit(db, errorMessage) {
  const watcher = getWatcher(db);
  const isSpamFlag = isSpamFlagError(errorMessage);

  if (isSpamFlag) {
    // feedback_required = Instagram flagged the session as spam.
    // Auto-pause the watcher to prevent repeated retries that extend the ban.
    const step = Math.min(watcher.consecutiveErrors, RATE_LIMIT.spamBackoffMinutes.length - 1);
    const backoffMs = RATE_LIMIT.spamBackoffMinutes[step] * 60 * 1000;
    const hours = Math.round(RATE_LIMIT.spamBackoffMinutes[step] / 60 * 10) / 10;
    watcher.consecutiveErrors += 1;
    watcher.rateLimitUntil = new Date(Date.now() + backoffMs).toISOString();
    watcher.syncInProgress = false;
    watcher.running = false; // auto-pause — user must manually restart after resolving
    updateWatcher(db, refreshHealth(watcher));
    addLog(db, "error", "Session flagged — watcher auto-paused",
      `Instagram anti-spam block detected. Backoff ${hours}h until ${watcher.rateLimitUntil}. ` +
      `Do not sync again yet. Open Instagram as the admin account, resolve any challenge, wait out the backoff, then re-start.`);
  } else {
    const step = Math.min(watcher.consecutiveErrors, RATE_LIMIT.backoffMinutes.length - 1);
    const backoffMs = RATE_LIMIT.backoffMinutes[step] * 60 * 1000;
    watcher.consecutiveErrors += 1;
    watcher.rateLimitUntil = new Date(Date.now() + backoffMs).toISOString();
    watcher.syncInProgress = false;
    updateWatcher(db, refreshHealth(watcher));
    addLog(db, "warn", "Rate limit backoff applied", `Waiting ${RATE_LIMIT.backoffMinutes[step]} minutes`);
  }
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

    // Always honor Instagram rate-limit / spam backoff — even for manual syncs.
    // Clearing this by retrying is what extends the ban.
    const rateLimitedUntil = getRateLimitUntil(watcher);
    if (rateLimitedUntil > Date.now()) {
      const mins = Math.ceil((rateLimitedUntil - Date.now()) / 60000);
      result = {
        ok: false,
        skipped: true,
        reason: "rate_limited",
        detail: `Instagram backoff active — wait ~${mins} more minute(s) (until ${new Date(rateLimitedUntil).toISOString()}).`
      };
      addLog(db, "warn", "Sync blocked by backoff", result.detail);
      canProceed = false;
      return;
    }

    // Normal interval cooldown only applies to scheduled/cron syncs.
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
      // Real Instagram scraping — pass cached userId + previous sizes to catch truncated pages
      const latestForCompare = latestSnapshot(readDb());
      const data = await fetchInstagramFollowersAndFollowing(
        targetUser,
        watcherStatus.adminSessionId,
        watcherStatus.targetUserId || null,
        {
          followersCount: latestForCompare?.followers?.length || 0,
          followingCount: latestForCompare?.following?.length || 0
        }
      );
      followerPool = uniqueUsernames(data.followers);
      followingPool = uniqueUsernames(data.following);
      // Persist resolved userId so future syncs can recover if profile fetch 429s
      if (data.resolvedUserId && data.resolvedUserId !== watcherStatus.targetUserId) {
        mutateDb(db => updateWatcher(db, { targetUserId: data.resolvedUserId }));
        console.log(`[watcher] Cached targetUserId=${data.resolvedUserId} for @${targetUser}`);
      }
      if (data.followersCount || data.followingCount) {
        console.log(
          `[watcher] Profile counts ${data.followersCount}/${data.followingCount} vs fetched ` +
          `${followerPool.length}/${followingPool.length}`
        );
      }
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
        syncInProgress: false,
        lastError: ""
      }));

      if (unchanged) {
        addLog(db, "info", "Sync OK — no changes", `@${targetUser} unchanged, snapshot skipped to save storage`);
      } else {
        addLog(db, "success", "Sync completed", `${finalFollowers.length} followers, ${finalFollowing.length} following`);
      }
    });
    result = { ok: true, skipped: false };
  } catch (error) {
    console.error(`[watcher] Sync failed: ${error.message}`);
    mutateDb(db => {
      registerRateLimitHit(db, error.message);
      const watcher = getWatcher(db);
      watcher.lastError = error.message;
      updateWatcher(db, watcher);
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

function saveWatcherSettings({ adminUsername, adminSessionId, targetUsername, targetUserId, interval }) {
  return mutateDb(db => {
    const patch = {};
    const currentWatcher = getWatcher(db);
    if (adminUsername !== undefined) patch.adminUsername = adminUsername.trim();
    if (adminSessionId !== undefined) patch.adminSessionId = adminSessionId.trim();
    if (targetUsername !== undefined) {
      const normalizedTarget = normalizeUsername(targetUsername);
      if (normalizedTarget !== currentWatcher.targetUsername) {
        patch.targetUsername = normalizedTarget;
        patch.username = normalizedTarget; // backwards compatibility
        patch.targetUserId = ""; // clear cached userId when target changes
      }
    }
    if (targetUserId !== undefined) {
      patch.targetUserId = String(targetUserId).trim();
    }
    if (interval !== undefined) patch.interval = interval;

    const activeWatcher = { ...currentWatcher, ...patch };
    patch.connected = Boolean(activeWatcher.targetUsername || activeWatcher.username);

    // Never clear Instagram backoff just because settings were saved (UI saves
    // before every manual sync). Only clear when the session cookie actually changes.
    const sessionChanged =
      adminSessionId !== undefined &&
      adminSessionId.trim() &&
      adminSessionId.trim() !== currentWatcher.adminSessionId;
    if (sessionChanged) {
      patch.consecutiveErrors = 0;
      patch.rateLimitUntil = null;
      patch.lastError = "";
      addLog(db, "info", "Session cookie updated — backoff cleared", "New sessionid saved; rate-limit cooldown reset.");
    }

    updateWatcher(db, refreshHealth({ ...getWatcher(db), ...patch }));

    const displayUser = patch.targetUsername || getWatcher(db).targetUsername || getWatcher(db).username || "nobody";
    addLog(db, "info", "Watcher settings saved", `@${displayUser} every ${patch.interval || getWatcher(db).interval}`);
    return getWatcher(db);
  }).watcher;
}

function startWatcher() {
  return mutateDb(db => {
    const watcher = getWatcher(db);
    if (!watcher.username && !watcher.targetUsername) {
      throw new Error("Set a username before starting");
    }
    const rateLimitedUntil = getRateLimitUntil(watcher);
    if (rateLimitedUntil > Date.now()) {
      const mins = Math.ceil((rateLimitedUntil - Date.now()) / 60000);
      throw new Error(
        `Cannot start — Instagram backoff is active for ~${mins} more minute(s). ` +
        `Open Instagram as the admin account, wait out the cooldown, then try again.`
      );
    }
    updateWatcher(db, refreshHealth({ ...watcher, running: true, connected: true }));
    addLog(db, "success", "Watcher started", `Monitoring @${watcher.targetUsername || watcher.username} every ${watcher.interval}`);
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
