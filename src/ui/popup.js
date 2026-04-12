
const statusIndicator = document.getElementById('statusIndicator');
const statusCard = document.getElementById('statusCard');
const statusIcon = document.getElementById('statusIcon');
const statusTitle = document.getElementById('statusTitle');
const statusDetail = document.getElementById('statusDetail');
const openYoutubeBtn = document.getElementById('openYoutubeBtn');
const preventDuplicatesCheckbox = document.getElementById('preventDuplicates');

const ICON_CHECK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
const ICON_ALERT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;
const ICON_DOT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/></svg>`;

const setStatus = (state, title, detail) => {
  statusCard.classList.remove('active', 'warn');
  statusIndicator.classList.remove('active', 'error');
  openYoutubeBtn.classList.remove('visible');

  if (state === 'active') {
    statusCard.classList.add('active');
    statusIndicator.classList.add('active');
    statusIcon.innerHTML = ICON_CHECK;
  } else if (state === 'warn') {
    statusCard.classList.add('warn');
    statusIndicator.classList.add('error');
    statusIcon.innerHTML = ICON_ALERT;
    openYoutubeBtn.classList.add('visible');
  } else {
    statusIcon.innerHTML = ICON_DOT;
  }

  statusTitle.textContent = title;
  statusDetail.textContent = detail;
};

// Poll a specific tab until the content script answers GET_PLAYLISTS or we time out.
const waitForContentScript = async (tabId, timeoutMs = 15000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, { action: 'GET_PLAYLISTS' });
      if (response?.playlists) return true;
    } catch (e) { /* content script not ready yet */ }
    await new Promise(r => setTimeout(r, 400));
  }
  return false;
};

// Load settings and detect YouTube.
const loadData = async () => {
  const data = await chrome.storage.local.get(['ocpSettings']);
  const settings = data.ocpSettings || { preventDuplicates: true };
  preventDuplicatesCheckbox.checked = !!settings.preventDuplicates;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url && tab.url.includes('youtube.com')) {
      try {
        const response = await chrome.tabs.sendMessage(tab.id, { action: 'GET_PLAYLISTS' });
        if (response?.playlists) {
          setStatus('active', 'Active on YouTube', 'Use the + button on any video thumbnail to add it to your playlist.');
        } else {
          setStatus('warn', 'Not responding', 'Refresh the YouTube tab to activate the extension.');
        }
      } catch (e) {
        setStatus('warn', 'Refresh needed', 'Refresh the YouTube tab to activate the extension.');
      }
    } else {
      setStatus('warn', 'Open YouTube to start', 'This extension only works on youtube.com. Navigate there to use the + button on video thumbnails.');
    }
  } catch (e) {
    setStatus('warn', 'Open YouTube to start', 'This extension only works on youtube.com. Navigate there to use the + button on video thumbnails.');
  }
};

// Save settings when changed
preventDuplicatesCheckbox.addEventListener('change', async () => {
  const settings = (await chrome.storage.local.get(['ocpSettings'])).ocpSettings || {};
  settings.preventDuplicates = preventDuplicatesCheckbox.checked;
  await chrome.storage.local.set({ ocpSettings: settings });

  // Notify content script of settings change
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url?.includes('youtube.com')) {
      chrome.tabs.sendMessage(tab.id, { action: 'SETTINGS_UPDATED', settings });
    }
  } catch (e) {}
});

openYoutubeBtn.addEventListener('click', async () => {
  openYoutubeBtn.disabled = true;
  const originalText = openYoutubeBtn.textContent;
  openYoutubeBtn.textContent = 'Opening…';
  setStatus('idle', 'Opening YouTube…', 'Loading youtube.com in a new tab.');

  try {
    const tab = await chrome.tabs.create({ url: 'https://www.youtube.com/' });
    const ready = await waitForContentScript(tab.id);
    if (ready) {
      setStatus('active', 'Active on YouTube', 'Use the + button on any video thumbnail to add it to your playlist.');
    } else {
      setStatus('warn', 'Refresh needed', 'The YouTube tab opened but the extension did not respond. Try refreshing it.');
    }
  } catch (e) {
    setStatus('warn', 'Could not open YouTube', 'Try opening youtube.com manually in a new tab.');
  } finally {
    openYoutubeBtn.disabled = false;
    openYoutubeBtn.textContent = originalText;
  }
});

loadData();
