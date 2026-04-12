import { test as base, chromium } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const test = base.extend({
  context: async ({}, use) => {
    const extensionPath = path.resolve(__dirname, '../../');
    const context = await chromium.launchPersistentContext('', {
      headless: false, // Playwright must think it's headed to allow extensions
      viewport: { width: 1280, height: 720 },
      args: [
        `--headless=new`, // But we start Chromium in native new-headless mode
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
      ],
    });


    
    context.setDefaultTimeout(45000);
    context.setDefaultNavigationTimeout(45000);

    
    await use(context);
    await context.close();
  },
  page: async ({ context }, use) => {
    const page = context.pages()[0] || await context.newPage();
    await use(page);
  },
});

/**
 * Navigate to YouTube and wait for the extension to be fully loaded.
 * Returns the page for chaining.
 */
export async function waitForExtensionReady(page, url = 'https://www.youtube.com') {
  await page.goto(url);
  
  // Handle YouTube's cookie consent / TOS dialog if it appears
  await handleConsentDialog(page);

  // Wait for the extension's header toggle to appear — signals content script ran
  // Headless YouTube can be very slow to inject, so we use a generous timeout
  try {
    await page.waitForSelector('#ocp-header-toggle', { timeout: 45000 });
  } catch (e) {
    // If it fails, try one refresh. Sometimes YouTube's initial load in headless misses 
    // the content script injection window.
    console.log('Extension toggle not found, refreshing page once...');
    await page.reload();
    await handleConsentDialog(page);
    await page.waitForSelector('#ocp-header-toggle', { timeout: 45000 });
  }
  
  return page;
}

/**
 * Handle YouTube's cookie consent / TOS dialog if it appears.
 */
async function handleConsentDialog(page) {
  // Different variants of the "Accept all" button
  const selectors = [
    'button[aria-label="Accept the use of cookies and other data for the purposes described"]',
    'button:has-text("Accept all")',
    'button:has-text("Agree")',
    '#content [aria-label="Accept all"]'
  ];

  try {
    for (const selector of selectors) {
      const btn = page.locator(selector);
      if (await btn.isVisible({ timeout: 2000 })) {
        await btn.click();
        await page.waitForTimeout(2000);
        break;
      }
    }
  } catch (e) {}

  // YouTube can also display a semi-transparent iron-overlay-backdrop (e.g. a
  // "what's new" guide or sign-in nudge) that stays on top and intercepts every
  // pointer event. Remove it so Playwright can click through to the page.
  await dismissBackdrop(page);
}

/**
 * Remove any existing YouTube `tp-yt-iron-overlay-backdrop` and install a
 * MutationObserver that auto-removes future ones so they never block clicks.
 */
export async function dismissBackdrop(page) {
  try { await page.evaluate(() => {
    const blockers = [
      'tp-yt-iron-overlay-backdrop',
      'ytd-consent-bump-v2-lightbox',
    ];
    // Remove existing overlays
    for (const tag of blockers) {
      document.querySelectorAll(tag).forEach(el => el.remove());
    }
    // Prevent future overlays from blocking clicks
    if (!window.__ocpBackdropObserver) {
      const blockerSet = new Set(blockers.map(t => t.toUpperCase()));
      window.__ocpBackdropObserver = new MutationObserver((mutations) => {
        for (const m of mutations) {
          for (const node of m.addedNodes) {
            if (blockerSet.has(node.nodeName)) node.remove();
          }
        }
      });
      window.__ocpBackdropObserver.observe(document.body, { childList: true, subtree: true });
    }
  }); } catch (e) { /* execution context destroyed by navigation — safe to ignore */ }
}

/**
 * Open the One-Click Playlist overlay panel.
 * Clicks the toggle button if the panel is currently hidden.
 */
export async function openPanel(page) {
  const panel = page.locator('#yt-bulk-add-overlay');
  const isHidden = await panel.getAttribute('hidden');
  if (isHidden !== null) {
    await page.evaluate(() => {
      const toggle = document.querySelector('#ocp-header-toggle');
      if (toggle) toggle.click();
    });
    await page.waitForFunction(() => {
      const p = document.querySelector('#yt-bulk-add-overlay');
      return p && p.hidden === false;
    }, null, { timeout: 5000 });
  }
}

/**
 * Wait until the playlist dropdown has real options (beyond "— Choose —").
 */
export async function waitForPlaylistsLoaded(page) {
  await page.waitForFunction(() => {
    const sel = document.querySelector('#yt-playlist-select');
    return sel && sel.options.length > 1;
  }, { timeout: 5000 });
}

export { expect } from '@playwright/test';
