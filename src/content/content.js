let selectedPlaylistId = null;
let headerInitInFlight = false;
let refreshIntervalId = null;
let ytConfig = null;

function showToast(text) {
  const toast = document.getElementById('ocp-toast');
  if (toast) {
    toast.textContent = text;
    toast.hidden = false;
    setTimeout(() => { toast.hidden = true; }, 3000);
  } else {
    alert(text);
  }
}
// --- Settings ---
// Persisted in chrome.storage.local under `ocpSettings`. Defaults apply when
// the key is missing (fresh install) or a new field is added in an update.
const DEFAULT_SETTINGS = { preventDuplicates: true };
let ocpSettings = { ...DEFAULT_SETTINGS };

function loadSettings() {
  return new Promise(resolve => {
    chrome.storage.local.get(['ocpSettings'], (res) => {
      ocpSettings = { ...DEFAULT_SETTINGS, ...(res.ocpSettings || {}) };
      resolve(ocpSettings);
    });
  });
}

function saveSettings(patch) {
  ocpSettings = { ...ocpSettings, ...patch };
  chrome.storage.local.set({ ocpSettings });
}

// Keep the in-memory copy in sync if another tab/popup mutates settings.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.ocpSettings) {
    ocpSettings = { ...DEFAULT_SETTINGS, ...(changes.ocpSettings.newValue || {}) };
  }
});

// --- Message Listener for Popup Communication ---
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'CREATE_PLAYLIST') {
    createPlaylistAPI(msg.playlistName).then(playlistId => {
      if (playlistId) {
        sendResponse({ playlistId });
      } else {
        sendResponse({ error: 'Create failed — check console' });
      }
    }).catch(e => {
      console.error('[YT-OneClick] Create playlist failed:', e);
      sendResponse({
        error: e.message || 'Create failed',
        code: e.code || null,
      });
    });
    return true; // Keep message channel open for async response
  }

  if (msg.action === 'GET_PLAYLISTS') {
    nuclearSyncPlaylists().then(playlists => {
      chrome.storage.local.set({
        syncedPlaylists: playlists,
        syncedPlaylistsUpdatedAt: Date.now(),
      });
      sendResponse({ playlists });
    }).catch(e => {
      console.error('[YT-OneClick] GET_PLAYLISTS failed:', e);
      sendResponse({ error: e.message, playlists: [] });
    });
    return true; // Keep message channel open for async response
  }

  if (msg.action === 'BULK_ADD_START') {
    const onProgress = (done, total) => {
      // Broadcast to any listeners (popup). Swallow errors — popup may be closed.
      try {
        chrome.runtime.sendMessage({ action: 'BULK_ADD_PROGRESS', done, total });
      } catch (e) {}
    };
    performBulkAdd(msg.playlistId, msg.playlistName, onProgress)
      .then(result => sendResponse(result))
      .catch(err => {
        console.error('[YT-OneClick] performBulkAdd failed:', err);
        sendResponse({ error: err.message || 'Bulk add failed' });
      });
    return true;
  }

  if (msg.action === 'SETTINGS_UPDATED') {
    ocpSettings = { ...DEFAULT_SETTINGS, ...(msg.settings || {}) };
    return false;
  }

  if (msg.action === 'PLAYLIST_CHANGED') {
    selectedPlaylistId = msg.playlistId;
    const select = document.getElementById('yt-playlist-select');
    if (select) select.value = msg.playlistId;
    return false;
  }
});

async function performBulkAdd(playlistId, playlistName, onProgress = null) {
  const videoElements = document.querySelectorAll('ytd-video-renderer, ytd-grid-video-renderer, ytd-rich-item-renderer, ytd-playlist-video-renderer, ytd-compact-video-renderer, ytd-rich-grid-media, ytd-reel-item-renderer');
  const videoIds = new Set();

  videoElements.forEach(el => {
    const urlEl = el.querySelector('a#video-title, a#video-title-link, #title a, a.yt-simple-endpoint');
    if (urlEl?.href) {
      try {
        const url = new URL(urlEl.href);
        let vid = url.searchParams.get('v');
        const shortsMatch = url.pathname.match(/^\/shorts\/([^/]+)/);
        if (!vid && shortsMatch) vid = shortsMatch[1];
        if (vid) videoIds.add(vid);
      } catch (e) {}
    }
  });

  if (videoIds.size === 0) return { message: 'No videos found on this page.' };

  const total = videoIds.size;
  let processed = 0;
  let successCount = 0;
  let skippedCount = 0;
  if (onProgress) onProgress(0, total);
  for (const videoId of videoIds) {
    if (ocpSettings.preventDuplicates) {
      const already = await isVideoInPlaylist(playlistId, videoId);
      if (already) {
        skippedCount++;
        processed++;
        if (onProgress) onProgress(processed, total);
        continue;
      }
    }
    const success = await addVideoToPlaylistAPI(playlistId, videoId);
    if (success) successCount++;
    processed++;
    if (onProgress) onProgress(processed, total);
  }

  const suffix = skippedCount > 0 ? ` (${skippedCount} already in playlist)` : '';
  return { message: `Added ${successCount} videos to "${playlistName}"${suffix}` };
}

// --- Config Discovery ---
// YouTube pages call ytcfg.set() multiple times across different <script> tags.
// We must merge ALL calls to get INNERTUBE_API_KEY, INNERTUBE_CONTEXT, SESSION_INDEX, etc.
function getYTConfig() {
  const config = {};
  const scripts = document.querySelectorAll('script');
  for (const script of scripts) {
    const text = script.textContent;
    let searchPos = 0;
    while (true) {
      const setIdx = text.indexOf('ytcfg.set(', searchPos);
      if (setIdx === -1) break;
      const objStart = setIdx + 'ytcfg.set('.length;
      // Track brace depth to find the matching closing brace
      let depth = 0;
      let objEnd = -1;
      for (let i = objStart; i < text.length; i++) {
        if (text[i] === '{') depth++;
        else if (text[i] === '}') {
          depth--;
          if (depth === 0) { objEnd = i + 1; break; }
        }
      }
      if (objEnd > objStart) {
        try {
          Object.assign(config, JSON.parse(text.substring(objStart, objEnd)));
        } catch (e) {}
      }
      searchPos = objEnd > objStart ? objEnd : setIdx + 10;
    }
  }
  if (Object.keys(config).length === 0) {
    console.warn('[YT-OneClick] ytcfg.set() scraping found nothing');
  }
  return config;
}

// --- SAPISIDHASH Authentication ---
// YouTube requires an Authorization header with a SAPISIDHASH token for all
// authenticated InnerTube API calls (especially mutations like adding to playlists).
// Format: SAPISIDHASH <timestamp>_<SHA1(timestamp + " " + SAPISID + " " + origin)>
async function generateSAPISIDHASH() {
  const cookieStr = document.cookie;
  const sapisid =
    cookieStr.match(/(?:^|;\s*)SAPISID=([^;]+)/)?.[1] ??
    cookieStr.match(/(?:^|;\s*)__Secure-3PAPISID=([^;]+)/)?.[1] ??
    cookieStr.match(/(?:^|;\s*)__Secure-1PAPISID=([^;]+)/)?.[1];
  if (!sapisid) return null;
  const timestamp = Math.floor(Date.now() / 1000);
  const input = `${timestamp} ${sapisid} https://www.youtube.com`;
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(input));
  const hash = Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0')).join('');
  return `SAPISIDHASH ${timestamp}_${hash}`;
}

async function callYoutubeInternal(endpoint, body = {}) {
  if (!ytConfig || !ytConfig.INNERTUBE_API_KEY) ytConfig = getYTConfig();
  const apiKey = ytConfig.INNERTUBE_API_KEY || ytConfig.apiKey;
  const context = ytConfig.INNERTUBE_CONTEXT || ytConfig.context;

  const headers = {
    'Content-Type': 'application/json',
    'X-Goog-AuthUser': ytConfig.SESSION_INDEX || '0',
    'X-Goog-Visitor-Id': ytConfig.VISITOR_DATA || '',
    'X-Youtube-Client-Name': String(ytConfig.INNERTUBE_CONTEXT_CLIENT_NAME || '1'),
    'X-Youtube-Client-Version': ytConfig.INNERTUBE_CLIENT_VERSION || '2.20240501.00.00',
  };

  if (!ytConfig.INNERTUBE_CLIENT_VERSION) {
    console.warn('[YT-OneClick] INNERTUBE_CLIENT_VERSION missing, using fallback');
  }

  // Attach SAPISIDHASH — required for authenticated/mutation endpoints
  const authHash = await generateSAPISIDHASH();
  if (authHash) {
    headers['Authorization'] = authHash;
  }

  const res = await fetch(`https://www.youtube.com/youtubei/v1/${endpoint}?key=${apiKey}`, {
    method: 'POST',
    credentials: 'include',
    headers,
    body: JSON.stringify({ context, ...body })
  });
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data.error?.message || 'InnerTube API Error');
    err.code = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

function scanForPlaylists(obj, bucket) {
  if (!obj || typeof obj !== 'object') return;
  
  const title = obj.title?.simpleText || obj.title?.runs?.[0]?.text
    || obj.formattedTitle?.simpleText || obj.playlistTitle?.simpleText;

  // Extract playlist ID from multiple possible locations
  let id = obj.playlistId || obj.navigationEndpoint?.watchEndpoint?.playlistId;

  // browseEndpoint uses VL prefix (e.g., VLPL...) — strip it to get actual playlist ID
  if (!id) {
    const browseId = obj.navigationEndpoint?.browseEndpoint?.browseId;
    if (browseId?.startsWith('VLPL')) {
      id = browseId.substring(2);
    } else if (browseId?.startsWith('PL')) {
      id = browseId;
    }
  }

  if (id && title && (id.startsWith('PL') || id === 'WL')) {
    if (!title.includes(' - Topic')) {
      bucket.set(id, title);
    }
  }

  for (const key in obj) {
    if (key === 'trackingParams' || key === 'clickTrackingParams') continue;
    scanForPlaylists(obj[key], bucket);
  }
}

// Extract ytInitialData JSON from raw HTML using brace-depth tracking.
// The regex approach ({.*?}) fails because non-greedy matching truncates the massive JSON blob.
function extractYTInitialData(html) {
  const marker = 'var ytInitialData = ';
  const start = html.indexOf(marker);
  if (start === -1) return null;
  const jsonStart = start + marker.length;
  let depth = 0;
  let inString = false;
  let escape = false;
  let jsonEnd = -1;
  for (let i = jsonStart; i < html.length; i++) {
    const char = html[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (char === '\\' && inString) {
      escape = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (!inString) {
      if (char === '{') depth++;
      else if (char === '}') {
        depth--;
        if (depth === 0) { jsonEnd = i + 1; break; }
      }
    }
  }
  if (jsonEnd <= jsonStart) return null;
  try {
    return JSON.parse(html.substring(jsonStart, jsonEnd));
  } catch (e) {
    console.warn('[YT-OneClick] ytInitialData JSON parse failed', e);
    return null;
  }
}

async function nuclearSyncPlaylists() {
  const playlistMap = new Map();
  playlistMap.set('WL', 'Watch Later');

  // Method 1: Scrape ytInitialData from playlist/library HTML pages
  const htmlSources = [
    'https://www.youtube.com/feed/playlists',
    'https://www.youtube.com/feed/library',
  ];
  for (const url of htmlSources) {
    try {
      const response = await fetch(url, { credentials: 'include' });
      const html = await response.text();
      const data = extractYTInitialData(html);
      if (data) scanForPlaylists(data, playlistMap);
    } catch (e) { console.warn(`[YT-OneClick] HTML scrape failed for ${url}`, e); }
  }

  // Method 2: InnerTube browse API with multiple browse IDs
  const browseIds = ['FEplaylists', 'FEplaylist_aggregation', 'FElibrary'];
  for (const browseId of browseIds) {
    try {
      const data = await callYoutubeInternal('browse', { browseId });
      scanForPlaylists(data, playlistMap);
    } catch (e) {}
  }

  // Method 3: InnerTube guide API (sidebar playlists)
  try {
    const guideData = await callYoutubeInternal('guide');
    scanForPlaylists(guideData, playlistMap);
  } catch (e) {}

  // Method 4: "Save to playlist" dialog — the most reliable source
  // This is the exact endpoint YouTube's own Save button uses, and it returns ALL user playlists.
  try {
    let probeVideoId = null;
    const anyLink = document.querySelector('a[href*="watch?v="]');
    if (anyLink?.href) {
      try { probeVideoId = new URL(anyLink.href).searchParams.get('v'); } catch (e) {}
    }
    if (!probeVideoId) probeVideoId = 'dQw4w9WgXcQ'; // fallback: well-known video
    const saveData = await callYoutubeInternal('playlist/get_add_to_playlist', {
      videoIds: [probeVideoId],
      excludeWatchLater: false,
    });
    scanForPlaylists(saveData, playlistMap);
  } catch (e) { console.warn('[YT-OneClick] get_add_to_playlist failed', e); }

  return Array.from(playlistMap.entries()).map(([id, title]) => ({ id, title }));
}

// Case-insensitive, whitespace-trimmed duplicate check. Returns the matching
// playlist object from `existing` or null. Kept pure so the test suite can
// cover it without touching the network.
function findDuplicatePlaylist(existing, title) {
  const target = (title || '').trim().toLowerCase();
  if (!target) return null;
  return existing.find(p => (p.title || '').trim().toLowerCase() === target) || null;
}

async function createPlaylistAPI(title) {
  // Refuse to create a playlist that already exists under the same name.
  // We run a fresh sync rather than trusting the cache so the check is
  // authoritative at the moment of creation.
  const existing = await nuclearSyncPlaylists();
  const dup = findDuplicatePlaylist(existing, title);
  if (dup) {
    const err = new Error(`A playlist named "${dup.title}" already exists.`);
    err.code = 'DUPLICATE_PLAYLIST';
    throw err;
  }
  const data = await callYoutubeInternal('playlist/create', { title, privacyStatus: 'PRIVATE' });
  return data.playlistId;
}

// Returns true if `videoId` is already in `playlistId`.
// Uses the same InnerTube endpoint YouTube's own "Save" dialog uses — it
// returns every user playlist with a membership flag for the probed video.
// Fails open (returns false) on any error so we never block a legitimate add.
async function isVideoInPlaylist(playlistId, videoId) {
  try {
    const data = await callYoutubeInternal('playlist/get_add_to_playlist', {
      videoIds: [videoId],
      excludeWatchLater: false,
    });
    let found = false;
    const walk = (obj) => {
      if (found || !obj || typeof obj !== 'object') return;
      const r = obj.playlistAddToOptionRenderer;
      if (r && r.playlistId === playlistId) {
        // YouTube has used both shapes historically; accept either.
        if (r.selectionState === 'PLAYLIST_ADD_TO_OPTION_SELECTION_STATE_SELECTED'
            || r.containsSelectedVideos === 'ALL') {
          found = true;
          return;
        }
      }
      for (const k in obj) {
        if (k === 'trackingParams' || k === 'clickTrackingParams') continue;
        walk(obj[k]);
      }
    };
    walk(data);
    return found;
  } catch (e) {
    console.warn('[YT-OneClick] isVideoInPlaylist failed', e);
    return false;
  }
}

async function addVideoToPlaylistAPI(playlistId, videoId) {
  const endpoints = ['browse/edit_playlist', 'playlist/edit'];
  for (const endpoint of endpoints) {
    try {
      const data = await callYoutubeInternal(endpoint, {
        playlistId,
        actions: [{ action: 'ACTION_ADD_VIDEO', addedVideoId: videoId }]
      });

      // Reject explicit errors
      if (data.error) {
        console.warn(`[YT-OneClick] ${endpoint} error:`, data.error);
        continue;
      }

      // YouTube returns STATUS_SUCCEEDED (not STATUS_SUCCESS)
      if (data.status === 'STATUS_SUCCEEDED' ||
          data.status === 'STATUS_SUCCESS' ||
          data.playlistEditResults) {
        return true;
      }
    } catch (e) {
      if (e.code === 401 || e.code === 403) {
        const err = new Error('YouTube session expired');
        err.code = 'AUTH_EXPIRED';
        throw err;
      }
      console.warn(`[YT-OneClick] ${endpoint} failed:`, e);
    }
  }
  return false;
}

function injectButtons() {
  // Broad selector for any video container
  const videoElements = document.querySelectorAll('ytd-video-renderer, ytd-grid-video-renderer, ytd-rich-item-renderer, ytd-playlist-video-renderer, ytd-compact-video-renderer, ytd-rich-grid-media, ytd-reel-item-renderer');
  
  videoElements.forEach(el => {
    if (el.querySelector('.yt-one-click-add-btn')) return;

    // Target the menu container - this is stable and next to 3 dots
    const menu = el.querySelector('#menu-container, #menu.ytd-video-renderer, #menu.ytd-grid-video-renderer, #menu.ytd-rich-grid-media, #menu.ytd-compact-video-renderer, .menu.ytd-reel-item-renderer, ytd-menu-renderer');
    if (!menu) return;

    const btn = document.createElement('button');
    btn.className = 'yt-one-click-add-btn';
    btn.textContent = '+';
    
    const stop = (e) => { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); };

    btn.addEventListener('click', async (e) => {
      stop(e);
      if (btn.disabled || !selectedPlaylistId) {
        if (!selectedPlaylistId) showToast("Please select a playlist first!");
        return;
      }

      const urlEl = el.querySelector('a#video-title, a#video-title-link, #title a, a.yt-simple-endpoint');
      if (!urlEl || !urlEl.href) return;
      
      const url = new URL(urlEl.href);
      let videoId = url.searchParams.get('v');
      const shortsMatch = url.pathname.match(/^\/shorts\/([^/]+)/);
      if (!videoId && shortsMatch) videoId = shortsMatch[1];
      if (!videoId) return;

      btn.textContent = '';
      btn.dataset.state = 'loading';
      btn.disabled = true;

      try {
        if (ocpSettings.preventDuplicates) {
          const already = await isVideoInPlaylist(selectedPlaylistId, videoId);
          if (already) {
            btn.dataset.state = 'skipped';
            btn.title = 'Already in playlist';
            btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
            return;
          }
        }
        const success = await addVideoToPlaylistAPI(selectedPlaylistId, videoId);
        if (success) {
          btn.dataset.state = 'success';
          btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
        } else {
          btn.dataset.state = 'error';
          btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
          setTimeout(() => { 
            btn.textContent = '+';
            btn.dataset.state = ''; 
            btn.disabled = false; 
          }, 2000);
        }
      } catch (err) {
        btn.dataset.state = 'error';
        if (err.code === 'AUTH_EXPIRED') {
          btn.title = 'YouTube session expired — reload the page or sign in again';
          btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4"/><circle cx="12" cy="16" r="0.5"/></svg>';
        } else {
          btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4"/><circle cx="12" cy="16" r="0.5"/></svg>';
          setTimeout(() => { 
            btn.textContent = '+';
            btn.dataset.state = ''; 
            btn.disabled = false; 
          }, 2000);
          return;
        }
        btn.disabled = false;
      }
    }, true);

    btn.addEventListener('mousedown', stop, true);
    
    // Inject into the menu renderer if possible, otherwise prepend to menu
    const renderer = menu.querySelector('ytd-menu-renderer') || menu;
    renderer.prepend(btn);
  });
}

function waitForMasthead() {
  return new Promise((resolve) => {
    const check = () => {
      const end = document.querySelector('ytd-masthead #end') || document.querySelector('#end.ytd-masthead');
      if (end) return resolve(end);
      setTimeout(check, 300);
    };
    check();
  });
}

async function initHeaderPanel() {
  if (headerInitInFlight) return;
  if (document.getElementById('ocp-header-toggle')) return;
  headerInitInFlight = true;

  try {
    const mastheadEnd = await waitForMasthead();
    if (document.getElementById('ocp-header-toggle')) return;

    if (refreshIntervalId) clearInterval(refreshIntervalId);

  // Toggle Button
  const toggle = document.createElement('button');
  toggle.id = 'ocp-header-toggle';
  toggle.setAttribute('aria-label', 'One-Click Playlist');
  toggle.setAttribute('title', 'One-Click Playlist');
  toggle.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 12H3"/><path d="M16 6H3"/><path d="M16 18H3"/><path d="M18 9v6"/><path d="M21 12h-6"/></svg>`;

  // Wrapper (for relative positioning)
  const wrapper = document.createElement('div');
  wrapper.id = 'ocp-header-wrapper';
  wrapper.appendChild(toggle);

  // Dropdown Panel
  const panel = document.createElement('div');
  panel.id = 'yt-bulk-add-overlay';
  panel.hidden = true;
  panel.innerHTML = `
    <div class="ocp-title">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="6" y="3" width="12" height="18" rx="2"/>
        <path d="M10 8h4"/>
        <path d="M10 12h4"/>
        <path d="M10 16h4"/>
      </svg>
      <span class="ocp-title-text">One-Click Add</span>
    </div>

    <div class="ocp-form-group">
      <label class="ocp-label" for="yt-playlist-select">Active Playlist</label>
      <select id="yt-playlist-select" aria-label="Select playlist"></select>
    </div>

    <div class="ocp-form-group">
      <label class="ocp-label ocp-label-create">Create New Playlist</label>
      <div class="ocp-create-row">
        <input type="text" id="yt-create-name" placeholder="New playlist name" aria-label="New playlist name">
        <button id="yt-create-btn">Create</button>
      </div>
    </div>

    <button id="ocp-bulk-add-btn" class="ocp-btn-primary">Bulk Add to Playlist</button>
    <div id="ocp-bulk-progress" class="ocp-progress" hidden>
      <div class="ocp-progress-track">
        <div id="ocp-bulk-progress-fill" class="ocp-progress-fill"></div>
      </div>
      <div id="ocp-bulk-progress-label" class="ocp-progress-label">0 / 0</div>
    </div>
    <div id="ocp-toast" class="ocp-toast" hidden></div>
  `;
wrapper.appendChild(panel);

mastheadEnd.prepend(wrapper);

// Toggle show/hide
toggle.addEventListener('click', (e) => {
e.stopPropagation();
panel.hidden = !panel.hidden;
toggle.classList.toggle('ocp-active', !panel.hidden);
});

// Close on outside click
document.addEventListener('click', (e) => {
if (!wrapper.contains(e.target) && !panel.hidden) {
  panel.hidden = true;
  toggle.classList.remove('ocp-active');
}
});

// Wire up controls
const select = panel.querySelector('#yt-playlist-select');
const createNameInput = panel.querySelector('#yt-create-name');
const createBtn = panel.querySelector('#yt-create-btn');
const bulkAddBtn = panel.querySelector('#ocp-bulk-add-btn');
const progressEl = panel.querySelector('#ocp-bulk-progress');
const progressFill = panel.querySelector('#ocp-bulk-progress-fill');
const progressLabel = panel.querySelector('#ocp-bulk-progress-label');

bulkAddBtn.onclick = async () => {
if (!selectedPlaylistId) {
  progressEl.hidden = false;
  progressFill.style.width = '0%';
  progressLabel.textContent = 'Select a playlist first';
  return;
}
const selectedText = select.options[select.selectedIndex].textContent;
bulkAddBtn.disabled = true;
bulkAddBtn.textContent = 'Processing...';
progressEl.hidden = false;
progressFill.style.width = '0%';
progressLabel.textContent = 'Scanning…';
try {
  const result = await performBulkAdd(selectedPlaylistId, selectedText, (done, total) => {
    const pct = total > 0 ? (done / total) * 100 : 0;
    progressFill.style.width = pct + '%';
    progressLabel.textContent = `${done} / ${total}`;
  });
  // Leave bar visible; surface the summary inline next to the count.
  if (result?.message) {
    progressLabel.textContent = result.message;
  }
  bulkAddBtn.textContent = 'Done ✓';
} catch (e) {
  console.error(e);
  progressLabel.textContent = 'Bulk add failed';
  bulkAddBtn.textContent = 'Bulk Add to Playlist';
}
setTimeout(() => {
  bulkAddBtn.disabled = false;
  bulkAddBtn.textContent = 'Bulk Add to Playlist';
}, 1500);
};

  async function refreshList(autoId = null) {
    const playlists = await nuclearSyncPlaylists();
    // Cache synced playlists so the toolbar popup can populate its dropdown
    // even when opened from a non-YouTube tab.
    chrome.storage.local.set({
      syncedPlaylists: playlists,
      syncedPlaylistsUpdatedAt: Date.now(),
    });
    chrome.storage.local.get(['lastSelectedPlaylistId'], (res) => {
      select.innerHTML = '<option value="">— Choose —</option>';
      playlists.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.id; opt.textContent = p.title; select.appendChild(opt);
      });
      const idToSelect = autoId || res.lastSelectedPlaylistId;
      if (idToSelect) {
        select.value = idToSelect;
        selectedPlaylistId = select.value;
        chrome.storage.local.set({ lastSelectedPlaylistId: selectedPlaylistId });
      }
    });
  }

  select.onchange = () => {
    selectedPlaylistId = select.value;
    chrome.storage.local.set({ lastSelectedPlaylistId: selectedPlaylistId });
    
    // Notify popup/others if they are open
    try {
      chrome.runtime.sendMessage({ action: 'PLAYLIST_CHANGED', playlistId: selectedPlaylistId });
    } catch (e) {}

    // Clear any lingering progress bar from a previous bulk add.
    progressEl.hidden = true;
    progressFill.style.width = '0%';
    progressLabel.textContent = '0 / 0';
  };

  function flashCreateError(label) {
    createBtn.textContent = label;
    setTimeout(() => { createBtn.textContent = 'Create'; }, 2000);
  }

  createBtn.onclick = async () => {
    const name = createNameInput.value.trim();
    if (!name) return;
    createBtn.disabled = true;
    createBtn.textContent = 'Creating…';
    try {
      const playlistId = await createPlaylistAPI(name);
      if (playlistId) {
        createNameInput.value = '';
        await refreshList(playlistId);
        createBtn.textContent = 'Create';
        
        // Notify popup
        try {
          chrome.runtime.sendMessage({ action: 'PLAYLIST_CHANGED', playlistId });
        } catch (e) {}
      } else {
        flashCreateError('Failed');
      }
    } catch (e) {
      console.error('[YT-OneClick] Create playlist failed:', e);
      if (e.code === 'DUPLICATE_PLAYLIST') {
        showToast(e.message);
        flashCreateError('Exists');
      } else {
        flashCreateError('Failed');
      }
    } finally {
      createBtn.disabled = false;
    }
  };

  refreshIntervalId = setInterval(() => refreshList(), 5 * 60 * 1000);
  refreshList();
  } finally {
    headerInitInFlight = false;
  }
}

// One-time cleanup of the now-removed storage keys.
chrome.storage.local.remove(['manualPlaylists', 'recentPlaylists']);

loadSettings();
initHeaderPanel();
injectButtons();
const observer = new MutationObserver(() => {
  injectButtons();
  if (!document.getElementById('ocp-header-toggle')) {
    initHeaderPanel();
  }
});
observer.observe(document.body, { childList: true, subtree: true });

