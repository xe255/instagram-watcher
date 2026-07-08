async function getInstagramUserId(username, sessionId) {
  const cleanUsername = String(username || "")
    .trim()
    .replace(/^@/, "")
    .toLowerCase();

  const url = `https://i.instagram.com/api/v1/users/web_profile_info/?username=${cleanUsername}`;
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Cookie": `sessionid=${sessionId}`,
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
  const userId = data.data?.user?.id;
  if (!userId) {
    throw new Error(`User @${cleanUsername} not found, or profile is private/inaccessible.`);
  }
  return userId;
}

async function getInstagramRelation(userId, relationType, sessionId, limit = 5000) {
  let list = [];
  let nextMaxId = "";
  let hasNext = true;

  while (hasNext && list.length < limit) {
    const url = `https://i.instagram.com/api/v1/friendships/${userId}/${relationType}/?count=100${nextMaxId ? `&max_id=${nextMaxId}` : ""}`;
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Cookie": `sessionid=${sessionId}`,
        "x-ig-app-id": "936619743392459",
        "Accept": "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://www.instagram.com/"
      }
    });

    if (!response.ok) {
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
  const userId = await getInstagramUserId(username, sessionId);
  
  // Safe sequential execution to avoid rate limits
  const followers = await getInstagramRelation(userId, "followers", sessionId);
  await new Promise(r => setTimeout(r, 1500));
  const following = await getInstagramRelation(userId, "following", sessionId);

  return { followers, following };
}

module.exports = {
  fetchInstagramFollowersAndFollowing
};
