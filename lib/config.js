const isRender = Boolean(process.env.RENDER);
const isFreeTier = process.env.FREE_TIER === "true" || isRender;

module.exports = {
  isFreeTier,
  isRender,
  maxSnapshots: Number(process.env.MAX_SNAPSHOTS) || (isFreeTier ? 5 : 50),
  maxLogs: Number(process.env.MAX_LOGS) || (isFreeTier ? 50 : 500),
  useExternalCron: process.env.USE_EXTERNAL_CRON !== "false" && isFreeTier,
  schedulerTickMs: Number(process.env.SCHEDULER_TICK_MS) || (isFreeTier ? 120_000 : 30_000),
  compactDb: isFreeTier,
  skipDemoData: isFreeTier,
  gistId: process.env.GIST_ID,
  githubToken: process.env.GITHUB_TOKEN
};
