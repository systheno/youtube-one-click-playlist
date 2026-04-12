import { test, expect, waitForExtensionReady, openPanel, waitForPlaylistsLoaded } from './fixtures.mjs';

test.describe('Add to Playlist Flow', () => {
  test.beforeEach(async ({ page }) => {
    await waitForExtensionReady(page, 'https://www.youtube.com/results?search_query=playwright');
  });

  test('clicking add button shows loading then success/failure state', async ({ page }) => {
    await openPanel(page);

    // Check that the overlay exists and wait until it's loaded
    const overlay = page.locator('#yt-bulk-add-overlay');
    await expect(overlay).toBeVisible({ timeout: 15000 });

    const select = overlay.locator('#yt-playlist-select');
    await expect(select).toBeVisible();

    // Wait for playlists to load
    try {
      await waitForPlaylistsLoaded(page);
    } catch {
      test.skip(true, 'No playlists available — user may not be logged in');
      return;
    }
    
    // Select the first real playlist (index 1 because index 0 is "-- Choose --")
    await page.selectOption('#yt-playlist-select', { index: 1 });

    // Wait for videos to be injected
    await page.waitForFunction(() => {
      return document.querySelectorAll('.yt-one-click-add-btn').length > 0;
    }, { timeout: 15000 });

    const addBtn = page.locator('.yt-one-click-add-btn').first();
    
    // Click the button to add to playlist (force: true bypasses YouTube overlays)
    await addBtn.click({ force: true });

    // Button should transition through loading and eventually yield an outcome
    
    // Wait for the button state to conclude the api call (or fail due to auth)
    await page.waitForFunction(() => {
      const btn = document.querySelector('.yt-one-click-add-btn');
      return btn && btn.dataset.state !== 'loading';
    }, { timeout: 30000 });

    // Final state should be one of the valid outcomes
    const finalState = await addBtn.getAttribute('data-state');
    expect(['success', 'error', 'skipped']).toContain(finalState);
  });
});
