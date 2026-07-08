function extractDsUserId(sessionId) {
  if (!sessionId) return "";
  const decoded = decodeURIComponent(sessionId);
  const parts = decoded.split(":");
  if (parts.length > 0 && /^\d+$/.test(parts[0])) {
    return parts[0];
  }
  return "";
}

async function getInstagramUserId(username, sessionId) {
  const cleanUsername = String(username || "")
    .trim()
    .replace(/^@/, "")
    .toLowerCase();

  const dsUserId = extractDsUserId(sessionId);
  const cookieHeader = `sessionid=${sessionId}${dsUserId ? `; ds_user_id=${dsUserId}` : ""}`;

  const url = `https://i.instagram.com/api/v1/users/web_profile_info/?username=${cleanUsername}`;
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Cookie": cookieHeader,
      "x-ig-app-id": "936619743392459",
      "Accept": "*/*",
      "Accept-Language": "en-US,en;q=0.9",
      "Referer": `https://www.instagram.com/${cleanUsername}/`
    }
  });

  if (!response.ok) {
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      throw new Error("Instagram session expired, invalid, or blocked. Please check your sessionid cookie and try again.");
    }
    throw new Error(`Profile fetch failed: HTTP ${response.status}`);
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
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Cookie": cookieHeader,
        "x-ig-app-id": "936619743392459",
        "Accept": "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://www.instagram.com/"
      }
    });

    if (!response.ok) {
      if (response.status === 404) {
        throw new Error("Target profile is private and your Admin/Bot account is not following it, or your Admin account has been blocked.");
      }
      if (response.status === 500) {
        throw new Error("Instagram returned 500. The target profile might be private/inaccessible to your Admin account, or your server IP has been flagged by Instagram.");
      }
      throw new Error(`Instagram lists fetch failed for friendships/${relationType}: HTTP ${response.status}`);
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
