import { describe, it, expect } from 'vitest';
import { Window } from 'happy-dom';

const window = new Window();
global.document = window.document;
global.URL = window.URL;

// Function to test (copied here for simplicity in this specific setup)
function scrapeVideoIds() {
  const videoElements = document.querySelectorAll('ytd-video-renderer, ytd-grid-video-renderer, ytd-rich-item-renderer, ytd-playlist-video-renderer, ytd-compact-video-renderer, ytd-rich-grid-media, ytd-reel-item-renderer');
  const ids = [];
  videoElements.forEach(el => {
    const urlEl = el.querySelector('a#video-title, a#video-title-link, #title a, a.yt-simple-endpoint');
    if (urlEl?.href) {
      try {
        const url = new URL(urlEl.href);
        let vid = url.searchParams.get('v');
        const shortsMatch = url.pathname.match(/^\/shorts\/([^/]+)/);
        if (!vid && shortsMatch) vid = shortsMatch[1];
        if (vid) {
          ids.push({ id: vid, element: el });
        }
      } catch (e) {}
    }
  });
  return ids;
}

// Function from content.js
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
    return null;
  }
}

// Function from content.js — case-insensitive, trimmed duplicate check.
function findDuplicatePlaylist(existing, title) {
  const target = (title || '').trim().toLowerCase();
  if (!target) return null;
  return existing.find(p => (p.title || '').trim().toLowerCase() === target) || null;
}

// Function from content.js
function scanForPlaylists(obj, bucket) {
  if (!obj || typeof obj !== 'object') return;
  
  const title = obj.title?.simpleText || obj.title?.runs?.[0]?.text
    || obj.formattedTitle?.simpleText || obj.playlistTitle?.simpleText;

  let id = obj.playlistId || obj.navigationEndpoint?.watchEndpoint?.playlistId;

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

describe('scrapeVideoIds', () => {
  it('should find video IDs from ytd-video-renderer', () => {
    document.body.innerHTML = `
      <ytd-video-renderer>
        <a id="video-title" href="https://www.youtube.com/watch?v=abc123">Title 1</a>
      </ytd-video-renderer>
      <ytd-video-renderer>
        <a id="video-title" href="https://www.youtube.com/watch?v=def456">Title 2</a>
      </ytd-video-renderer>
    `;
    const videos = scrapeVideoIds();
    expect(videos).toHaveLength(2);
    expect(videos[0].id).toBe('abc123');
    expect(videos[1].id).toBe('def456');
  });

  it('should handle different renderer types', () => {
    document.body.innerHTML = `
      <ytd-grid-video-renderer>
        <a id="video-title" href="https://www.youtube.com/watch?v=grid1">Grid Video</a>
      </ytd-grid-video-renderer>
      <ytd-rich-item-renderer>
        <a id="video-title-link" href="https://www.youtube.com/watch?v=rich2">Rich Video</a>
      </ytd-rich-item-renderer>
    `;
    const videos = scrapeVideoIds();
    expect(videos).toHaveLength(2);
    expect(videos.map(v => v.id)).toContain('grid1');
    expect(videos.map(v => v.id)).toContain('rich2');
  });

  it('should ignore links without video IDs', () => {
    document.body.innerHTML = `
      <ytd-video-renderer>
        <a id="video-title" href="https://www.youtube.com/about">About Page</a>
      </ytd-video-renderer>
    `;
    const videos = scrapeVideoIds();
    expect(videos).toHaveLength(0);
  });

  it('should extract video IDs from shorts paths with and without trailing slash', () => {
    document.body.innerHTML = `
      <ytd-reel-item-renderer>
        <a id="video-title" href="https://www.youtube.com/shorts/abcDEF123/">Short 1</a>
      </ytd-reel-item-renderer>
      <ytd-reel-item-renderer>
        <a id="video-title" href="https://www.youtube.com/shorts/xyz789">Short 2</a>
      </ytd-reel-item-renderer>
    `;
    const videos = scrapeVideoIds();
    expect(videos).toHaveLength(2);
    expect(videos.map(v => v.id)).toContain('abcDEF123');
    expect(videos.map(v => v.id)).toContain('xyz789');
  });
});

describe('extractYTInitialData', () => {
  it('should extract valid JSON regardless of internal braces', () => {
    const html = `<html><body><script>var ytInitialData = {"a": {"b": "}"}, "c": {}};</script></body></html>`;
    const data = extractYTInitialData(html);
    expect(data).toBeDefined();
    expect(data.a.b).toBe("}");
    expect(data.c).toBeDefined();
  });

  it('should ignore false markers or broken structures', () => {
    expect(extractYTInitialData('random html')).toBeNull();
    // Incomplete JSON with no closing brace
    expect(extractYTInitialData('var ytInitialData = {"something": "here" ;')).toBeNull();
  });
});

describe('findDuplicatePlaylist', () => {
  const existing = [
    { id: 'PL1', title: 'My Music' },
    { id: 'PL2', title: 'Workouts' },
    { id: 'WL', title: 'Watch Later' },
  ];

  it('detects an exact name match', () => {
    expect(findDuplicatePlaylist(existing, 'Workouts')).toEqual({ id: 'PL2', title: 'Workouts' });
  });

  it('is case-insensitive', () => {
    expect(findDuplicatePlaylist(existing, 'my music')).toEqual({ id: 'PL1', title: 'My Music' });
    expect(findDuplicatePlaylist(existing, 'WATCH LATER')).toEqual({ id: 'WL', title: 'Watch Later' });
  });

  it('ignores surrounding whitespace on both sides', () => {
    expect(findDuplicatePlaylist(existing, '   Workouts  ')).toEqual({ id: 'PL2', title: 'Workouts' });
    const padded = [{ id: 'PL3', title: '  Chill  ' }];
    expect(findDuplicatePlaylist(padded, 'chill')).toEqual({ id: 'PL3', title: '  Chill  ' });
  });

  it('returns null when no duplicate exists', () => {
    expect(findDuplicatePlaylist(existing, 'New Playlist')).toBeNull();
  });

  it('returns null for empty or whitespace-only input', () => {
    expect(findDuplicatePlaylist(existing, '')).toBeNull();
    expect(findDuplicatePlaylist(existing, '   ')).toBeNull();
  });

  it('handles empty existing list', () => {
    expect(findDuplicatePlaylist([], 'Anything')).toBeNull();
  });
});

describe('scanForPlaylists', () => {
  it('should extract direct playlistId', () => {
    const map = new Map();
    scanForPlaylists({ playlistId: 'PL123', title: { simpleText: 'My Playlist' } }, map);
    expect(map.get('PL123')).toBe('My Playlist');
  });

  it('should extract VL-prefixed browseEndpoints', () => {
    const map = new Map();
    scanForPlaylists({ 
      title: { simpleText: 'Hidden List' },
      navigationEndpoint: { browseEndpoint: { browseId: 'VLPL456' } } 
    }, map);
    expect(map.get('PL456')).toBe('Hidden List'); // Prefix removed
  });

  it('should ignore Topic playlists and handle recursion', () => {
    const map = new Map();
    // Recursion test with an ignored topic
    const deepObj = {
      layer2: {
        playlistId: 'PLTopic', title: { simpleText: 'Music - Topic' }
      },
      layer2b: {
        playlistId: 'PLReal', formattedTitle: { simpleText: 'Real Music' }
      }
    };
    scanForPlaylists({ layer1: deepObj }, map);
    expect(map.has('PLTopic')).toBe(false);
    expect(map.get('PLReal')).toBe('Real Music');
  });
});
