const { ProxyAgent } = require("undici");

// ---------------------------------------------------------------------------
// Rotating residential proxy (IL exit node, 0.8 GB cap).
// Uses undici's ProxyAgent — required for Node 18+ built-in fetch.
// Override via PROXY_URL env var if credentials change.
// ---------------------------------------------------------------------------
const PROXY_URL =
  process.env.PROXY_URL ||
  "http://veritas_a6f5xculb-country-IL:93hdzgdoyy@ip.veritasproxy.com:8080";

const proxyAgent = new ProxyAgent(PROXY_URL);

// ---------------------------------------------------------------------------
// Instagram Android app user-agent — required for the private friendships API.
// The web Chrome UA causes 404 on /api/v1/friendships/ from server IPs.
// ---------------------------------------------------------------------------
const IG_ANDROID_UA =
  "Instagram 275.0.0.27.98 Android (29/10; 420dpi; 1080x2148; samsung; SM-G975U; beyond1q; qcom; en_US; 458617641)";

function extractDsUserId(sessionId) {
  if (!sessionId) return "";
  const decoded = decodeURIComponent(sessionId);
  const parts = decoded.split(":");
  if (parts.length > 0 && /^\d+$/.test(parts[0])) {
    return parts[0];
  }
  return "";
}

// ---------------------------------------------------------------------------
// Thin fetch wrapper that routes every request through the residential proxy.
// Error bodies are capped at 300 chars to protect the 0.8 GB quota.
// ---------------------------------------------------------------------------
function igFetch(url, options = {}) {
  return fetch(url, { ...options, dispatcher: proxyAgent });
}

const PROFILE_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "x-ig-app-id": "936619743392459",
  "Accept": "*/*",
  "Accept-Language": "en-US,en;q=0.9"
};

async function getInstagramUserId(username, sessionId) {
  const cleanUsername = String(username || "")
    .trim()
    .replace(/^@/, "")
    .toLowerCase();

  const dsUserId = extractDsUserId(sessionId);
  const cookieHeader = `sessionid=${sessionId}${dsUserId ? `; ds_user_id=${dsUserId}` : ""}`;
  const url = `https://i.instagram.com/api/v1/users/web_profile_info/?username=${cleanUsername}`;
  const reqOpts = {
    headers: { ...PROFILE_HEADERS, "Cookie": cookieHeader, "Referer": `https://www.instagram.com/${cleanUsername}/` }
  };

  // One retry on 429 — wait 10 s then try once more
  for (let attempt = 1; attempt <= 2; attempt++) {
    const response = await igFetch(url, reqOpts);

    if (response.ok) {
      const data = await response.json();
      const user = data.data?.user;
      if (!user?.id) throw new Error(`User @${cleanUsername} not found, or profile is private/inaccessible.`);
      return {
        userId: user.id,
        followersCount: Number(user.edge_followed_by?.count) || 0,
        followingCount: Number(user.edge_follow?.count) || 0
      };
    }

    let detail = "";
    try { detail = (await response.text()).slice(0, 300); } catch (_) {}
    console.error(`[instagram] profile fetch HTTP ${response.status} (attempt ${attempt})${detail ? " — " + detail : ""}`);

    if (response.status === 429 && attempt === 1) {
      console.error(`[instagram] 429 rate-limit on profile fetch — waiting 10 s before retry`);
      await new Promise(r => setTimeout(r, 10_000));
      continue;
    }
    if ((response.status === 400 || response.status === 401 || response.status === 403) && detail.includes("feedback_required")) {
      throw new Error(`Instagram session flagged (HTTP ${response.status} - feedback_required). The scraping account session is being throttled or flagged. Please open Instagram in a browser/app as the admin account and resolve any checkpoint challenge, or try again later.${detail ? " — " + detail : ""}`);
    }
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      throw new Error(`Instagram session expired, invalid, or blocked (HTTP ${response.status}). Please re-copy your sessionid cookie.${detail ? " — " + detail : ""}`);
    }
    if (response.status === 404) {
      throw new Error(`Profile not found for @${cleanUsername} (HTTP 404). The account may not exist or may be inaccessible.`);
    }
    if (response.status === 429) {
      throw new Error(`Instagram rate-limit (HTTP 429) on profile fetch. Tip: look up the numeric user ID for @${cleanUsername} using an online lookup tool and enter it in settings to bypass this error.${detail ? " — " + detail : ""}`);
    }
    throw new Error(`Profile fetch failed: HTTP ${response.status}${detail ? " — " + detail : ""}`);
  }
}

function normalizeRelationUsername(value) {
  return String(value || "")
    .trim()
    .replace(/^@/, "")
    .toLowerCase()
    .replace(/[^a-z0-9._]/g, "");
}

async function getInstagramRelation(userId, relationType, sessionId, limit = 5000) {
  const seen = new Set();
  let nextMaxId = "";
  let hasNext = true;
  let pages = 0;
  let stalledPages = 0;
  const seenCursors = new Set();

  const dsUserId = extractDsUserId(sessionId);
  const cookieHeader = `sessionid=${sessionId}${dsUserId ? `; ds_user_id=${dsUserId}` : ""}`;

  while (hasNext && seen.size < limit) {
    const url = `https://i.instagram.com/api/v1/friendships/${userId}/${relationType}/?count=100${nextMaxId ? `&max_id=${encodeURIComponent(nextMaxId)}` : ""}`;
    const response = await igFetch(url, {
      headers: {
        // Android UA required for the friendships endpoint
        "User-Agent": IG_ANDROID_UA,
        "Cookie": cookieHeader,
        "x-ig-app-id": "936619743392459",
        "Accept": "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate",
        "X-IG-Capabilities": "3brTvw==",
        "X-IG-Connection-Type": "WIFI",
        "Referer": "https://www.instagram.com/"
      }
    });

    if (!response.ok) {
      let detail = "";
      try { detail = (await response.text()).slice(0, 300); } catch (_) {}
      const hint = detail ? ` — ${detail}` : "";
      console.error(`[instagram] friendships/${relationType} HTTP ${response.status}${hint}`);

      // If we already have a partial list and Instagram starts throttling, fail loudly
      // so we never save an incomplete snapshot as if it were complete.
      if (response.status === 400 && detail.includes("feedback_required")) {
        throw new Error(`Instagram session flagged (HTTP 400 - feedback_required). The scraping account session is being throttled or flagged. Please open Instagram in a browser/app as the admin account and resolve any checkpoint challenge, or try again later.${hint}`);
      }
      if (response.status === 404) {
        throw new Error(
          `Friendships/${relationType} returned 404. Session may be expired or proxy exit node blocked.` + hint
        );
      }
      if (response.status === 401 || response.status === 403) {
        throw new Error(`Instagram session invalid or expired (HTTP ${response.status}). Please update your sessionid cookie.${hint}`);
      }
      if (response.status === 429) {
        throw new Error(`Instagram rate limit hit (HTTP 429) on ${relationType} list after ${seen.size} users / ${pages} pages. Wait before retrying — partial lists are not saved.${hint}`);
      }
      if (response.status === 500) {
        throw new Error(`Instagram server error (HTTP 500). The target profile may be inaccessible or your session is flagged.${hint}`);
      }
      throw new Error(`Instagram lists fetch failed for friendships/${relationType}: HTTP ${response.status}${hint}`);
    }

    const data = await response.json();
    pages += 1;
    if (!Array.isArray(data.users)) {
      break;
    }

    let added = 0;
    for (const user of data.users) {
      const username = normalizeRelationUsername(user?.username);
      if (!username || seen.has(username)) continue;
      seen.add(username);
      added += 1;
    }
    console.log(`[instagram] ${relationType}: page ${pages} +${added} (unique ${seen.size})`);

    const cursor = data.next_max_id != null && data.next_max_id !== ""
      ? String(data.next_max_id)
      : "";
    const moreAvailable = data.more_available === true || Boolean(cursor);

    if (!moreAvailable) {
      hasNext = false;
      break;
    }
    if (!cursor || seenCursors.has(cursor)) {
      console.error(`[instagram] ${relationType}: pagination stalled at cursor=${cursor || "(empty)"} after ${seen.size} unique`);
      throw new Error(
        `Incomplete ${relationType} fetch: pagination stalled after ${seen.size} unique users (${pages} pages). ` +
        `Instagram stopped returning new pages — usually rate limiting. Try again later.`
      );
    }
    if (added === 0) {
      stalledPages += 1;
      if (stalledPages >= 2) {
        throw new Error(
          `Incomplete ${relationType} fetch: received ${stalledPages} pages with no new users after ${seen.size} unique. ` +
          `Aborting so a partial list is not saved.`
        );
      }
    } else {
      stalledPages = 0;
    }

    seenCursors.add(cursor);
    nextMaxId = cursor;
    hasNext = true;
    // Polite delay between paginated requests
    await new Promise(r => setTimeout(r, 1500));
  }

  return [...seen].sort((a, b) => a.localeCompare(b));
}

function assertListComplete(label, fetched, expectedCount, previousCount = 0) {
  const count = fetched.length;
  if (expectedCount > 0) {
    // Allow a small gap for restricted/private accounts Instagram hides from list endpoints.
    const tolerance = Math.max(8, Math.ceil(expectedCount * 0.03));
    if (count + tolerance < expectedCount) {
      throw new Error(
        `Incomplete ${label} fetch: got ${count} usernames but profile shows ${expectedCount}. ` +
        `Partial lists are not saved (would create fake unfollow events). Wait out rate limits and retry.`
      );
    }
  }
  if (previousCount >= 30) {
    // A sudden >10% drop mid-sync is almost always an incomplete page fetch.
    const minVsPrev = Math.floor(previousCount * 0.9);
    if (count < minVsPrev) {
      throw new Error(
        `Incomplete ${label} fetch: got ${count}, previous good sync had ${previousCount}. ` +
        `Refusing to save a short list. Wait and retry.`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Main entry point. Accepts an optional cachedUserId to skip the profile
// fetch (web_profile_info) when the userId is already known and persisted.
// Returns { followers, following, resolvedUserId, followersCount, followingCount }.
// ---------------------------------------------------------------------------
async function fetchInstagramFollowersAndFollowing(username, sessionId, cachedUserId = null, previous = {}) {
  let userId = cachedUserId || null;
  let followersCount = 0;
  let followingCount = 0;

  // Prefer a fresh profile count so we can detect truncated follower pages.
  // If this 429s but we have a cached userId, continue and validate against the previous snapshot instead.
  try {
    console.log(`[instagram] Fetching profile counts for @${username}`);
    const profile = await getInstagramUserId(username, sessionId);
    userId = profile.userId;
    followersCount = profile.followersCount;
    followingCount = profile.followingCount;
    console.log(`[instagram] @${username} userId=${userId} (followers: ${followersCount}, following: ${followingCount})`);
  } catch (err) {
    if (!userId) throw err;
    console.error(`[instagram] Profile count fetch failed — using cached userId=${userId}: ${err.message}`);
  }

  // Fetch followers; if 404 and we used a cached ID, force a fresh profile fetch and retry once
  let followers;
  try {
    followers = await getInstagramRelation(userId, "followers", sessionId);
  } catch (err) {
    if (cachedUserId && err.message.includes("404")) {
      console.error(`[instagram] 404 with cached userId=${userId} — invalidating cache and retrying profile fetch`);
      const profile = await getInstagramUserId(username, sessionId);
      userId = profile.userId;
      followersCount = profile.followersCount;
      followingCount = profile.followingCount;
      followers = await getInstagramRelation(userId, "followers", sessionId);
    } else {
      throw err;
    }
  }

  assertListComplete("followers", followers, followersCount, previous.followersCount || 0);

  await new Promise(r => setTimeout(r, 1500));
  const following = await getInstagramRelation(userId, "following", sessionId);
  assertListComplete("following", following, followingCount, previous.followingCount || 0);

  console.log(
    `[instagram] Complete lists for @${username}: ${followers.length}/${followersCount || "?"} followers, ` +
    `${following.length}/${followingCount || "?"} following`
  );

  return {
    followers,
    following,
    resolvedUserId: userId,
    followersCount,
    followingCount
  };
}

module.exports = {
  fetchInstagramFollowersAndFollowing
};
