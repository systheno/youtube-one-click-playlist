import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// The popup is normally loaded by the browser as `chrome-extension://<id>/src/ui/popup.html`
// with access to the real `chrome.*` APIs. For a fast, deterministic e2e test we synthesize
// an equivalent page: the popup's HTML with its external module script replaced by an
// inlined classic script. `page.setContent` then drives an about:blank navigation, which
// lets `addInitScript` install the chrome API stub before any popup code runs.
const POPUP_HTML_SRC = fs.readFileSync(
  path.resolve(__dirname, '../../src/ui/popup.html'),
  'utf8',
);
const POPUP_JS_SRC = fs.readFileSync(
  path.resolve(__dirname, '../../src/ui/popup.js'),
  'utf8',
);
const POPUP_HTML = POPUP_HTML_SRC.replace(
  /<script[^>]*src="popup\.js"[^>]*><\/script>/,
  `<script>${POPUP_JS_SRC}</script>`,
);

/**
 * Installs a stub `chrome` object on the page before popup.js runs.
 *
 * The popup only touches three API surfaces:
 *   - chrome.storage.local (get/set for ocpSettings)
 *   - chrome.tabs.query / sendMessage / create
 *   - chrome.runtime.onMessage.addListener (noop is fine)
 *
 * This harness makes all of them driveable from the test: a test can flip
 * `contentScriptResponds` mid-flight, inspect `createdTab`, or preload
 * `storage` values. State lives on `window.__popupStub` so the test can
 * poke at it via `page.evaluate`.
 */
async function installChromeStub(page, initial = {}) {
  const state = {
    storage: initial.storage ?? {},
    activeTab: initial.activeTab ?? null,
    contentScriptResponds: initial.contentScriptResponds ?? false,
    contentScriptError: initial.contentScriptError ?? null,
    createdTab: null,
    // How long to wait, in ms, before a freshly created tab "boots" its content script
    // (i.e. flips contentScriptResponds to true). Pass `null` to never boot.
    // We avoid `Infinity` because addInitScript serializes args as JSON and
    // `JSON.stringify(Infinity) === "null"`, which would silently become a 0-delay setTimeout.
    // Use `in` so an explicit `null` is preserved (nullish-coalescing would fall back to 200).
    bootDelayMs: 'bootDelayMs' in initial ? initial.bootDelayMs : 200,
    messagesSent: [],
  };

  // addInitScript only applies on real navigations, not on `page.setContent`
  // (which calls `Page.setDocumentContent` under the hood). So: register the
  // init script, then force a real navigation to about:blank. The chrome stub
  // will be installed on that blank document, and since a later `setContent`
  // only rewrites the document (not the window), the stub survives.
  await page.addInitScript((initialState) => {
    window.__popupStub = initialState;

    const cloneGet = (keys) => {
      const out = {};
      const arr = Array.isArray(keys) ? keys : [keys];
      for (const k of arr) {
        if (k in window.__popupStub.storage) out[k] = window.__popupStub.storage[k];
      }
      return out;
    };

    window.chrome = {
      storage: {
        local: {
          get: (keys) => Promise.resolve(cloneGet(keys)),
          set: (obj) => {
            Object.assign(window.__popupStub.storage, obj);
            return Promise.resolve();
          },
        },
      },
      tabs: {
        query: async () => {
          return window.__popupStub.activeTab ? [window.__popupStub.activeTab] : [];
        },
        sendMessage: async (tabId, msg) => {
          window.__popupStub.messagesSent.push({ tabId, msg });
          if (msg?.action === 'GET_PLAYLISTS') {
            if (window.__popupStub.contentScriptError) {
              throw new Error(window.__popupStub.contentScriptError);
            }
            if (window.__popupStub.contentScriptResponds) {
              return { playlists: [{ id: 'PL_STUB', title: 'Stub' }] };
            }
            throw new Error('Could not establish connection');
          }
          return undefined;
        },
        create: async ({ url }) => {
          const newTab = { id: 999, url };
          window.__popupStub.createdTab = newTab;
          window.__popupStub.activeTab = newTab;
          const delay = window.__popupStub.bootDelayMs;
          if (typeof delay === 'number' && Number.isFinite(delay) && delay >= 0) {
            setTimeout(() => {
              window.__popupStub.contentScriptResponds = true;
            }, delay);
          }
          return newTab;
        },
      },
      runtime: {
        onMessage: { addListener: () => {} },
      },
    };
  }, state);

  await page.goto('about:blank');
}

test.describe('Popup View', () => {
  test.beforeEach(async ({ context }) => {
    // Allow file:// pages to access relative resources like popup.js
    context.setDefaultTimeout(10000);
  });

  test('renders warn state when the active tab is not YouTube', async ({ page }) => {
    await installChromeStub(page, {
      activeTab: { id: 1, url: 'https://www.google.com/' },
    });
    await page.setContent(POPUP_HTML);

    const card = page.locator('#statusCard');
    await expect(card).toHaveClass(/warn/);
    await expect(page.locator('#statusTitle')).toHaveText('Open YouTube to start');
    await expect(page.locator('#openYoutubeBtn')).toBeVisible();
    await expect(page.locator('#statusIndicator')).toHaveClass(/error/);
  });

  test('renders warn state when there is no active tab', async ({ page }) => {
    await installChromeStub(page, { activeTab: null });
    await page.setContent(POPUP_HTML);

    await expect(page.locator('#statusCard')).toHaveClass(/warn/);
    await expect(page.locator('#statusTitle')).toHaveText('Open YouTube to start');
    await expect(page.locator('#openYoutubeBtn')).toBeVisible();
  });

  test('renders active state when YouTube tab + content script responds', async ({ page }) => {
    await installChromeStub(page, {
      activeTab: { id: 7, url: 'https://www.youtube.com/results?search_query=x' },
      contentScriptResponds: true,
    });
    await page.setContent(POPUP_HTML);

    await expect(page.locator('#statusCard')).toHaveClass(/active/);
    await expect(page.locator('#statusTitle')).toHaveText('Active on YouTube');
    await expect(page.locator('#statusIndicator')).toHaveClass(/active/);
    await expect(page.locator('#openYoutubeBtn')).toBeHidden();
  });

  test('renders "Refresh needed" when YouTube tab is present but content script throws', async ({ page }) => {
    await installChromeStub(page, {
      activeTab: { id: 8, url: 'https://www.youtube.com/' },
      contentScriptError: 'Could not establish connection. Receiving end does not exist.',
    });
    await page.setContent(POPUP_HTML);

    await expect(page.locator('#statusCard')).toHaveClass(/warn/);
    await expect(page.locator('#statusTitle')).toHaveText('Refresh needed');
    await expect(page.locator('#openYoutubeBtn')).toBeVisible();
  });

  test('preventDuplicates checkbox hydrates from storage and persists on change', async ({ page }) => {
    await installChromeStub(page, {
      activeTab: null,
      storage: { ocpSettings: { preventDuplicates: false } },
    });
    await page.setContent(POPUP_HTML);

    const checkbox = page.locator('#preventDuplicates');
    await expect(checkbox).not.toBeChecked();

    await checkbox.check();
    await expect(checkbox).toBeChecked();

    // Confirm it was written through to the stub storage
    const stored = await page.evaluate(() => window.__popupStub.storage.ocpSettings);
    expect(stored).toEqual({ preventDuplicates: true });
  });

  test('preventDuplicates defaults to checked when no stored settings exist', async ({ page }) => {
    await installChromeStub(page, { activeTab: null, storage: {} });
    await page.setContent(POPUP_HTML);

    await expect(page.locator('#preventDuplicates')).toBeChecked();
  });

  test('Open YouTube click opens a new tab and transitions to active state', async ({ page }) => {
    await installChromeStub(page, {
      activeTab: { id: 2, url: 'https://www.google.com/' },
      bootDelayMs: 300,
    });
    await page.setContent(POPUP_HTML);

    // Starts in warn state
    await expect(page.locator('#statusCard')).toHaveClass(/warn/);

    const btn = page.locator('#openYoutubeBtn');
    await btn.click();

    // Click should have called chrome.tabs.create with youtube.com
    const createdUrl = await page.evaluate(() => window.__popupStub.createdTab?.url);
    expect(createdUrl).toBe('https://www.youtube.com/');

    // Button should be briefly disabled and show "Opening…"
    // (it snaps back after the polling resolves, so we don't assert mid-flight text)

    // Eventually the card flips to the active state without reopening the popup
    await expect(page.locator('#statusCard')).toHaveClass(/active/, { timeout: 8000 });
    await expect(page.locator('#statusTitle')).toHaveText('Active on YouTube');
    await expect(btn).toBeHidden();
  });

  test('Open YouTube click that never boots ends in "Refresh needed"', async ({ page }) => {
    await installChromeStub(page, {
      activeTab: { id: 3, url: 'https://www.google.com/' },
      bootDelayMs: null, // never boot
    });
    await page.setContent(POPUP_HTML);

    // Reduce the popup's own 15s poll deadline by shrinking it via a patched Date.now.
    // Instead we rely on the real 15s deadline with a generous test timeout.
    await page.locator('#openYoutubeBtn').click();

    // Poll window inside popup.js is 15s; expect the warn state within a bit after.
    await expect(page.locator('#statusCard')).toHaveClass(/warn/, { timeout: 20000 });
    await expect(page.locator('#statusTitle')).toHaveText('Refresh needed');
  });

  test('popup contains no forbidden legacy controls', async ({ page }) => {
    await installChromeStub(page, { activeTab: null });
    await page.setContent(POPUP_HTML);

    // These controls were intentionally removed from the popup view.
    await expect(page.locator('#playlistSelect')).toHaveCount(0);
    await expect(page.locator('#createBtn')).toHaveCount(0);
    await expect(page.locator('#createName')).toHaveCount(0);
    await expect(page.locator('#bulkAddBtn')).toHaveCount(0);
    await expect(page.locator('#bulkProgress')).toHaveCount(0);
  });
});
