const { readDb, getWatcher } = require("./store");
const { performSync } = require("./watcher");

const TICK_MS = 30 * 1000;
let timer = null;

function startScheduler() {
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
  }, TICK_MS);
  timer.unref?.();
  console.log(`[scheduler] Running every ${TICK_MS / 1000}s`);
}

function stopScheduler() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = { startScheduler, stopScheduler };
