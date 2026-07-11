const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const config = require("./config");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const DB_FILE = path.join(DATA_DIR, "db.json");

const SYNC_INTERVALS = {
  "5m": 5 * 60 * 1000,
  "10m": 10 * 60 * 1000,
  "15m": 15 * 60 * 1000,
  "30m": 30 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000
};

const DEMO_FOLLOWERS = ["maya.design", "roni.studio", "david.ai", "noa.moves", "eden.photo", "lior.codes", "tal.travel", "yuval.fm", "bar.style", "shira.art", "amit.design", "neta.fit"];
const DEMO_FOLLOWING = ["maya.design", "roni.studio", "david.ai", "noa.moves", "eden.photo", "brand.lab", "visual.archive", "music.daily", "studio.eden", "coffee.telaviv", "amit.design", "creator.tools", "neta.fit"];

function defaultWatcher() {
  return {
    adminUsername: "",
    adminSessionId: "",
    targetUsername: "",
    targetUserId: "",
    username: "", // kept for backwards-compatibility checks
    interval: "30m",
    running: false,
    connected: false,
    lastSync: null,
    health: "Ready",
    rateLimitUntil: null,
    consecutiveErrors: 0,
    syncInProgress: false,
    lastError: ""
  };
}

function defaultDb() {
  const snapshots = config.skipDemoData
    ? []
    : [{
        id: crypto.randomUUID(),
        label: "Demo snapshot",
        date: new Date(Date.now() - 86400000 * 2).toISOString(),
        followers: [...DEMO_FOLLOWERS],
        following: [...DEMO_FOLLOWING]
      }];
  return {
    watcher: defaultWatcher(),
    snapshots,
    logs: [{
      id: crypto.randomUUID(),
      level: "info",
      message: "Server started",
      detail: config.isFreeTier ? "Free-tier mode: minimal storage, external cron wake" : "Instagram Watcher backend initialized",
      createdAt: new Date().toISOString()
    }]
  };
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

let dbCache = null;
let saveQueue = Promise.resolve();

async function fetchFromGist() {
  const url = `https://api.github.com/gists/${config.gistId}`;
  const response = await fetch(url, {
    headers: {
      Authorization: `token ${config.githubToken}`,
      "User-Agent": "Instagram-Watcher-App",
      Accept: "application/vnd.github+json"
    }
  });

  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  const data = await response.json();
  const file = data.files["db.json"];
  if (!file || !file.content) {
    throw new Error("db.json not found in Gist");
  }

  let parsed;
  try {
    parsed = JSON.parse(file.content);
  } catch (e) {
    parsed = {};
  }
  const watcher = { ...defaultWatcher(), ...parsed.watcher };
  if (watcher.username && !watcher.targetUsername) {
    watcher.targetUsername = watcher.username;
  }
  return {
    watcher,
    snapshots: Array.isArray(parsed.snapshots) ? parsed.snapshots : defaultDb().snapshots,
    logs: Array.isArray(parsed.logs) ? parsed.logs : []
  };
}

async function saveToGist(db) {
  const url = `https://api.github.com/gists/${config.gistId}`;
  const payload = config.compactDb ? JSON.stringify(db) : JSON.stringify(db, null, 2);
  const response = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `token ${config.githubToken}`,
      "User-Agent": "Instagram-Watcher-App",
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      files: {
        "db.json": {
          content: payload
        }
      }
    })
  });

  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }
}

async function initDb() {
  if (config.gistId && config.githubToken) {
    console.log(`Storage: initializing with GitHub Gist: ${config.gistId}`);
    try {
      dbCache = await fetchFromGist();
      console.log("Storage: database loaded from Gist successfully");
    } catch (err) {
      console.error(`Storage: failed to load from Gist, falling back to local file: ${err.message}`);
      dbCache = readLocalDb();
    }
  } else {
    console.log("Storage: Gist credentials not set. Using local file storage (ephemeral).");
    dbCache = readLocalDb();
  }
}

function readLocalDb() {
  ensureDataDir();
  if (!fs.existsSync(DB_FILE)) {
    const db = defaultDb();
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
    return db;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    const watcher = { ...defaultWatcher(), ...parsed.watcher };
    if (watcher.username && !watcher.targetUsername) {
      watcher.targetUsername = watcher.username;
    }
    return {
      watcher,
      snapshots: Array.isArray(parsed.snapshots) ? parsed.snapshots : defaultDb().snapshots,
      logs: Array.isArray(parsed.logs) ? parsed.logs : []
    };
  } catch {
    const db = defaultDb();
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
    return db;
  }
}

function writeLocalDb(db) {
  ensureDataDir();
  const payload = config.compactDb ? JSON.stringify(db) : JSON.stringify(db, null, 2);
  fs.writeFileSync(DB_FILE, payload);
}

function readDb() {
  if (dbCache) return dbCache;
  dbCache = readLocalDb();
  return dbCache;
}

function pruneDb(db) {
  if (db.snapshots.length > config.maxSnapshots) {
    db.snapshots = [...db.snapshots]
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .slice(0, config.maxSnapshots);
  }
  if (db.logs.length > config.maxLogs) db.logs.length = config.maxLogs;
}

function writeDb(db) {
  dbCache = db;
  pruneDb(dbCache);
  writeLocalDb(dbCache);
  if (config.gistId && config.githubToken) {
    saveQueue = saveQueue.then(() => saveToGist(dbCache)).catch(err => {
      console.error(`Storage: failed to save to Gist in background: ${err.message}`);
    });
  }
}

function mutateDb(fn) {
  const db = readDb();
  fn(db);
  writeDb(db);
  return db;
}

function normalizeUsername(value) {
  return String(value || "")
    .trim()
    .replace(/^@/, "")
    .replace(/^https?:\/\/(www\.)?instagram\.com\//i, "")
    .split(/[/?#]/)[0]
    .toLowerCase()
    .replace(/[^a-z0-9._]/g, "");
}

function uniqueUsernames(values) {
  return [...new Set(values.map(normalizeUsername).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function intervalToMs(interval) {
  return Math.max(SYNC_INTERVALS[interval] || SYNC_INTERVALS["5m"], SYNC_INTERVALS["5m"]);
}

function addLog(db, level, message, detail = "") {
  db.logs.unshift({
    id: crypto.randomUUID(),
    level,
    message,
    detail,
    createdAt: new Date().toISOString()
  });
  if (db.logs.length > config.maxLogs) db.logs.length = config.maxLogs;
}

function snapshotSignature(followers, following) {
  return crypto
    .createHash("sha1")
    .update(JSON.stringify({ followers, following }))
    .digest("hex");
}

function getWatcher(db) {
  const watcher = { ...defaultWatcher(), ...db.watcher };
  if (watcher.username && !watcher.targetUsername) {
    watcher.targetUsername = watcher.username;
  }
  if (!SYNC_INTERVALS[watcher.interval]) watcher.interval = "30m";
  return watcher;
}

function updateWatcher(db, patch) {
  db.watcher = { ...getWatcher(db), ...patch };
  if (!SYNC_INTERVALS[db.watcher.interval]) db.watcher.interval = "30m";
  return db.watcher;
}

function latestSnapshot(db) {
  return [...db.snapshots].sort((a, b) => new Date(b.date) - new Date(a.date))[0] || null;
}

function makeSnapshot(label, followers, following, date = new Date()) {
  return {
    id: crypto.randomUUID(),
    label,
    date: date instanceof Date ? date.toISOString() : date,
    followers: uniqueUsernames(followers),
    following: uniqueUsernames(following)
  };
}

module.exports = {
  DATA_DIR,
  SYNC_INTERVALS,
  initDb,
  readDb,
  writeDb,
  mutateDb,
  addLog,
  getWatcher,
  updateWatcher,
  latestSnapshot,
  makeSnapshot,
  normalizeUsername,
  uniqueUsernames,
  intervalToMs,
  defaultWatcher,
  snapshotSignature,
  pruneDb
};
