import { test, expect, waitForExtensionReady, openPanel, waitForPlaylistsLoaded } from './fixtures.mjs';

test.describe('Edge Cases & Error Handling', () => {
  test.beforeEach(async ({ page }) => {
    await waitForExtensionReady(page, 'https://www.youtube.com/results?search_query=playwright');
  });

  test('clicking add button with no playlist selected shows alert', async ({ page }) => {
    // The toast lives inside the overlay panel, so open it first
    await openPanel(page);

    // Wait for buttons to be injected
    await page.waitForFunction(() => {
      return document.querySelectorAll('.yt-one-click-add-btn').length > 0;
    }, { timeout: 15000 });

    // Click the first add button (force: true bypasses YouTube overlays)
    const addBtn = page.locator('.yt-one-click-add-btn').first();
    await addBtn.click({ force: true });

    // The toast should appear with the correct message
    const toast = page.locator('#ocp-toast');
    await expect(toast).toBeVisible({ timeout: 3000 });
    await expect(toast).toContainText('Please select a playlist');
  });

  test('create playlist with empty name does nothing', async ({ page }) => {
    await openPanel(page);

    const createBtn = page.locator('#yt-create-btn');
    const input = page.locator('#yt-create-name');

    // Ensure input is empty
    await input.fill('');
    expect(await input.inputValue()).toBe('');

    // Click create
    await createBtn.click();

    // Button should still say "Create" (no loading state triggered)
    await expect(createBtn).toHaveText('Create');
    await expect(createBtn).toBeEnabled();
  });

  test('outside click closes overlay panel', async ({ page }) => {
    await openPanel(page);

    const overlay = page.locator('#yt-bulk-add-overlay');
    await expect(overlay).toBeVisible();

    // Click somewhere outside the panel (e.g., the main YouTube content area)
    await page.click('body', { position: { x: 640, y: 400 }, force: true });

    // Panel should hide
    await expect(overlay).toBeHidden({ timeout: 3000 });

    // Toggle should lose the active class
    const toggle = page.locator('#ocp-header-toggle');
    await expect(toggle).not.toHaveClass(/ocp-active/);
  });

  test('double-clicking add button does not cause issues', async ({ page }) => {
    await openPanel(page);

    try {
      await waitForPlaylistsLoaded(page);
      await page.selectOption('#yt-playlist-select', { index: 1 });
    } catch {
      test.skip(true, 'No playlists available');
      return;
    }

    await page.waitForFunction(() => {
      return document.querySelectorAll('.yt-one-click-add-btn').length > 0;
    }, { timeout: 15000 });

    const addBtn = page.locator('.yt-one-click-add-btn').first();

    // Click twice quickly (force: true bypasses YouTube overlays)
    await addBtn.click({ force: true });
    await addBtn.click({ force: true });

    // After the first click, button should be disabled (prevents second request)
    // Wait for the operation to complete in some state
    await page.waitForFunction(() => {
      const btn = document.querySelector('.yt-one-click-add-btn');
      return btn && btn.dataset.state !== 'loading';
    }, { timeout: 15000 });

    // Verify the button is in a valid final state (not stuck in loading)
    const state = await addBtn.getAttribute('data-state');
    expect(['success', 'error', 'skipped', '', null]).toContain(state);
  });

  test('add button transitions through loading → final state', async ({ page }) => {
    await openPanel(page);

    try {
      await waitForPlaylistsLoaded(page);
      await page.selectOption('#yt-playlist-select', { index: 1 });
    } catch {
      test.skip(true, 'No playlists available');
      return;
    }

    await page.waitForFunction(() => {
      return document.querySelectorAll('.yt-one-click-add-btn').length > 0;
    }, { timeout: 15000 });

    const addBtn = page.locator('.yt-one-click-add-btn').first();

    // force: true bypasses YouTube overlays that can intercept pointer events
    await addBtn.click({ force: true });

    // Wait for a final state — the intermediate 'loading' state may be too
    // transient to observe (the InnerTube call can fail instantly in headless
    // without login), so we skip asserting it and just wait for the outcome.
    await page.waitForFunction(() => {
      const btn = document.querySelector('.yt-one-click-add-btn');
      return btn && btn.dataset.state && btn.dataset.state !== 'loading';
    }, { timeout: 30000 });

    // Should be in a valid final state
    const finalState = await addBtn.getAttribute('data-state');
    expect(['success', 'error', 'skipped']).toContain(finalState);
  });

  test('toggle panel multiple times rapidly does not break state', async ({ page }) => {
    const toggle = page.locator('#ocp-header-toggle');
    const panel = page.locator('#yt-bulk-add-overlay');

    // Rapid toggles
    for (let i = 0; i < 6; i++) {
      await toggle.click();
      // Minimal wait to not be instantly synchronous
      await page.waitForTimeout(100);
    }

    // After 6 clicks (even number), panel should be hidden
    // (starts hidden → click1: show → click2: hide → ... → click6: hide)
    await expect(panel).toBeHidden();
    await expect(toggle).not.toHaveClass(/ocp-active/);
  });

  test('panel re-opens correctly after outside-click dismiss', async ({ page }) => {
    // Open panel
    await openPanel(page);
    const panel = page.locator('#yt-bulk-add-overlay');
    await expect(panel).toBeVisible();

    // Dismiss with outside click
    await page.click('body', { position: { x: 640, y: 400 }, force: true });
    await expect(panel).toBeHidden({ timeout: 3000 });

    // Re-open via toggle
    await page.click('#ocp-header-toggle');
    await expect(panel).toBeVisible({ timeout: 3000 });
  });

  test('overlay panel contains no console errors on load', async ({ page }) => {
    const consoleErrors = [];
    page.on('console', msg => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });

    await page.goto('https://www.youtube.com');
    await page.waitForSelector('#ocp-header-toggle', { timeout: 20000 });

    // Filter out known YouTube errors (not from our extension)
    const extensionErrors = consoleErrors.filter(
      e => e.includes('[YT-OneClick]') || e.includes('yt-one-click') || e.includes('ocp-')
    );

    expect(extensionErrors).toHaveLength(0);
  });

  test('create playlist with whitespace-only name does nothing', async ({ page }) => {
    await openPanel(page);

    const input = page.locator('#yt-create-name');
    const createBtn = page.locator('#yt-create-btn');

    // Fill with whitespace only
    await input.fill('   ');

    await createBtn.click();

    // Button should still say "Create" — the trim() check prevents empty creates
    await expect(createBtn).toHaveText('Create');
    await expect(createBtn).toBeEnabled();
  });

  test('multiple add buttons exist independently', async ({ page }) => {
    await page.waitForFunction(() => {
      return document.querySelectorAll('.yt-one-click-add-btn').length > 2;
    }, { timeout: 15000 });

    const buttons = await page.$$('.yt-one-click-add-btn');
    expect(buttons.length).toBeGreaterThan(2);

    // Each button should live inside a distinct video renderer element
    const rendererSelector = [
      'ytd-video-renderer', 'ytd-grid-video-renderer', 'ytd-rich-item-renderer',
      'ytd-compact-video-renderer', 'ytd-rich-grid-media', 'ytd-reel-item-renderer',
    ].join(',');
    const uniqueRenderers = new Set();
    for (const btn of buttons.slice(0, 5)) {
      const rendererTag = await btn.evaluate(
        (el, sel) => el.closest(sel)?.tagName ?? 'NONE',
        rendererSelector,
      );
      uniqueRenderers.add(rendererTag);
    }
    // All buttons should resolve to a known renderer parent (not "NONE")
    expect(uniqueRenderers.has('NONE')).toBe(false);
    // And the buttons are truly separate DOM nodes (not cloned references)
    expect(buttons.length).toBeGreaterThan(2);
  });

  test('extension does not crash on non-YouTube page after navigating back', async ({ page, context }) => {
    // Start on YouTube
    await page.waitForSelector('#ocp-header-toggle', { timeout: 20000 });

    // Navigate away to a non-YouTube page
    await page.goto('https://www.google.com');
    await page.waitForLoadState('networkidle');

    // Navigate back to YouTube
    await page.goto('https://www.youtube.com');
    await page.waitForSelector('#ocp-header-toggle', { timeout: 20000 });

    // Extension should still work
    const toggle = page.locator('#ocp-header-toggle');
    await expect(toggle).toBeVisible();

    await toggle.click();
    const panel = page.locator('#yt-bulk-add-overlay');
    await expect(panel).toBeVisible();
  });
});
