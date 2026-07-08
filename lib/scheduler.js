const config = require("./config");
const { readDb, getWatcher } = require("./store");
const { performSync } = require("./watcher");

let timer = null;

function startScheduler() {
  if (config.useExternalCron) {
    console.log("[scheduler] Free tier: using external cron wake (/api/cron/tick)");
    return;
  }
  if (timer) return;
  timer = setInterval(async () => {
    try {
      const db = readDb();
      const watcher = getWatcher(db);
      if (!watcher.running || !watcher.username || watcher.syncInProgress) return;
      await performSync({ manual: false, source: "scheduler" });
    } catch (error) {
      console.error("[scheduler]", error.message);
    }
  }, config.schedulerTickMs);
  timer.unref?.();
  console.log(`[scheduler] Running every ${config.schedulerTickMs / 1000}s`);
}

function stopScheduler() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = { startScheduler, stopScheduler };
