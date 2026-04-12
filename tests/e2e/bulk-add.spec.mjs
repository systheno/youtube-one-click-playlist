import { test, expect, waitForExtensionReady, openPanel, waitForPlaylistsLoaded } from './fixtures.mjs';

test.describe('Bulk Add Flow', () => {
  test.beforeEach(async ({ page }) => {
    await waitForExtensionReady(page, 'https://www.youtube.com/results?search_query=playwright');
    await openPanel(page);
  });

  test('bulk add without playlist selected shows "Select a playlist first"', async ({ page }) => {
    // Ensure no playlist is selected (default state)
    const selectValue = await page.locator('#yt-playlist-select').inputValue();
    expect(selectValue).toBe('');

    // Click bulk add
    const bulkBtn = page.locator('#ocp-bulk-add-btn');
    await bulkBtn.click();

    // Progress should become visible with error message
    const progress = page.locator('#ocp-bulk-progress');
    await expect(progress).toBeVisible({ timeout: 3000 });

    const progressLabel = page.locator('#ocp-bulk-progress-label');
    await expect(progressLabel).toHaveText('Select a playlist first');
  });

  test('bulk add button shows "Processing…" when playlist is selected', async ({ page }) => {
    try {
      await waitForPlaylistsLoaded(page);
    } catch {
      test.skip(true, 'No playlists available — user may not be logged in');
      return;
    }

    // Select a playlist
    await page.selectOption('#yt-playlist-select', { index: 1 });

    // Wait for video renderers to exist
    await page.waitForSelector(
      'ytd-rich-item-renderer, ytd-video-renderer',
      { timeout: 15000 }
    ).catch(() => {
      // No videos on page — still test the button state
    });

    const bulkBtn = page.locator('#ocp-bulk-add-btn');
    await bulkBtn.click();

    // Button should become disabled and show processing text
    await expect(bulkBtn).toHaveText('Processing...', { timeout: 3000 });
    await expect(bulkBtn).toBeDisabled();
  });

  test('progress bar shows during bulk add', async ({ page }) => {
    try {
      await waitForPlaylistsLoaded(page);
    } catch {
      test.skip(true, 'No playlists available');
      return;
    }

    await page.selectOption('#yt-playlist-select', { index: 1 });

    const bulkBtn = page.locator('#ocp-bulk-add-btn');
    await bulkBtn.click();

    // Progress container should become visible
    const progress = page.locator('#ocp-bulk-progress');
    await expect(progress).toBeVisible({ timeout: 5000 });

    // Progress label should show scanning or count text
    const label = page.locator('#ocp-bulk-progress-label');
    const labelText = await label.textContent();
    // Should be "Scanning…" or "X / Y" format
    expect(labelText).toBeTruthy();
  });

  test('bulk add button re-enables after completion', async ({ page }) => {
    try {
      await waitForPlaylistsLoaded(page);
    } catch {
      test.skip(true, 'No playlists available');
      return;
    }

    await page.selectOption('#yt-playlist-select', { index: 1 });

    const bulkBtn = page.locator('#ocp-bulk-add-btn');
    await bulkBtn.click();

    // Wait for the operation to complete: button text returns to original or "Done ✓"
    await page.waitForFunction(() => {
      const btn = document.querySelector('#ocp-bulk-add-btn');
      return btn && (btn.textContent === 'Done ✓' || btn.textContent === 'Bulk Add to Playlist');
    }, { timeout: 60000 }); // Long timeout — bulk add can take a while

    // After the 1.5s timeout, button should return to original state
    await page.waitForFunction(() => {
      const btn = document.querySelector('#ocp-bulk-add-btn');
      return btn && btn.textContent === 'Bulk Add to Playlist' && !btn.disabled;
    }, { timeout: 10000 });

    await expect(bulkBtn).toBeEnabled();
    await expect(bulkBtn).toHaveText('Bulk Add to Playlist');
  });

  test('progress bar fill width updates during operation', async ({ page }) => {
    try {
      await waitForPlaylistsLoaded(page);
    } catch {
      test.skip(true, 'No playlists available');
      return;
    }

    await page.selectOption('#yt-playlist-select', { index: 1 });

    // Ensure there are videos to process
    try {
      await page.waitForSelector(
        'ytd-rich-item-renderer, ytd-video-renderer',
        { timeout: 15000 }
      );
    } catch {
      test.skip(true, 'No video renderers on page');
      return;
    }

    const bulkBtn = page.locator('#ocp-bulk-add-btn');
    await bulkBtn.click();

    // Wait for the progress fill to have non-zero width at some point
    // (either during processing or after completion)
    await page.waitForFunction(() => {
      const fill = document.querySelector('#ocp-bulk-progress-fill');
      if (!fill) return false;
      const width = parseFloat(fill.style.width);
      return width > 0;
    }, { timeout: 60000 });

    const fillWidth = await page.locator('#ocp-bulk-progress-fill').evaluate(
      el => el.style.width
    );
    expect(parseFloat(fillWidth)).toBeGreaterThan(0);
  });
});
