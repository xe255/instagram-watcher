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

async function getInstagramUserId(username, sessionId) {
  const cleanUsername = String(username || "")
    .trim()
    .replace(/^@/, "")
    .toLowerCase();

  const dsUserId = extractDsUserId(sessionId);
  const cookieHeader = `sessionid=${sessionId}${dsUserId ? `; ds_user_id=${dsUserId}` : ""}`;

  const url = `https://i.instagram.com/api/v1/users/web_profile_info/?username=${cleanUsername}`;
  const response = await igFetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      "Cookie": cookieHeader,
      "x-ig-app-id": "936619743392459",
      "Accept": "*/*",
      "Accept-Language": "en-US,en;q=0.9",
      "Referer": `https://www.instagram.com/${cleanUsername}/`
    }
  });

  if (!response.ok) {
    let detail = "";
    try { detail = (await response.text()).slice(0, 300); } catch (_) {}
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      throw new Error(`Instagram session expired, invalid, or blocked (HTTP ${response.status}). Please re-copy your sessionid cookie.${detail ? " — " + detail : ""}`);
    }
    if (response.status === 404) {
      throw new Error(`Profile not found for @${cleanUsername} (HTTP 404). The account may not exist or may be inaccessible.`);
    }
    throw new Error(`Profile fetch failed: HTTP ${response.status}${detail ? " — " + detail : ""}`);
  }

  const data = await response.json();
  const user = data.data?.user;
  if (!user?.id) {
    throw new Error(`User @${cleanUsername} not found, or profile is private/inaccessible.`);
  }

  return {
    userId: user.id,
    followersCount: Number(user.edge_followed_by?.count) || 0,
    followingCount: Number(user.edge_follow?.count) || 0
  };
}

async function getInstagramRelation(userId, relationType, sessionId, limit = 5000) {
  let list = [];
  let nextMaxId = "";
  let hasNext = true;

  const dsUserId = extractDsUserId(sessionId);
  const cookieHeader = `sessionid=${sessionId}${dsUserId ? `; ds_user_id=${dsUserId}` : ""}`;

  while (hasNext && list.length < limit) {
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

      if (response.status === 404) {
        throw new Error(
          `Friendships/${relationType} returned 404. Possible causes:\n` +
          `• Session cookie expired or was invalidated — please re-copy it\n` +
          `• Instagram is blocking this proxy exit node temporarily` +
          hint
        );
      }
      if (response.status === 401 || response.status === 403) {
        throw new Error(`Instagram session invalid or expired (HTTP ${response.status}). Please update your sessionid cookie.${hint}`);
      }
      if (response.status === 429) {
        throw new Error(`Instagram rate limit hit (HTTP 429). Please wait before retrying.${hint}`);
      }
      if (response.status === 500) {
        throw new Error(`Instagram server error (HTTP 500). The target profile may be inaccessible or your session is flagged.${hint}`);
      }
      throw new Error(`Instagram lists fetch failed for friendships/${relationType}: HTTP ${response.status}${hint}`);
    }

    const data = await response.json();
    if (!Array.isArray(data.users)) {
      break;
    }

    list.push(...data.users.map(u => u.username));
    console.log(`[instagram] ${relationType}: fetched ${list.length} so far`);

    nextMaxId = data.next_max_id;
    hasNext = !!nextMaxId;
    if (hasNext) {
      // Polite delay between paginated requests
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  return list;
}

async function fetchInstagramFollowersAndFollowing(username, sessionId) {
  const profile = await getInstagramUserId(username, sessionId);
  console.log(`[instagram] Target @${username} expects followers: ${profile.followersCount}, following: ${profile.followingCount}`);

  // Safe sequential execution to avoid rate limits
  const followers = await getInstagramRelation(profile.userId, "followers", sessionId);
  await new Promise(r => setTimeout(r, 1500));
  const following = await getInstagramRelation(profile.userId, "following", sessionId);

  // Validation check:
  // If the fetched counts are significantly lower than official profile counts,
  // throw an error to prevent saving a corrupted/truncated snapshot.
  const followerDiff = profile.followersCount - followers.length;
  const followingDiff = profile.followingCount - following.length;

  // We allow a tolerance of up to 10% (or minimum 15 accounts) for deactivated/filtered users
  const followerTolerance = Math.max(15, Math.ceil(profile.followersCount * 0.1));
  const followingTolerance = Math.max(15, Math.ceil(profile.followingCount * 0.1));

  if (followerDiff > followerTolerance) {
    throw new Error(`Sync validation failed: fetched ${followers.length} followers but profile expects ${profile.followersCount}. Pagination was likely truncated.`);
  }
  if (followingDiff > followingTolerance) {
    throw new Error(`Sync validation failed: fetched ${following.length} following but profile expects ${profile.followingCount}. Pagination was likely truncated.`);
  }

  return { followers, following };
}

module.exports = {
  fetchInstagramFollowersAndFollowing
};
