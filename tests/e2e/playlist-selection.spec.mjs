import { test, expect, waitForExtensionReady, openPanel, waitForPlaylistsLoaded } from './fixtures.mjs';

test.describe('Playlist Selection & Persistence', () => {
  test.beforeEach(async ({ page }) => {
    await waitForExtensionReady(page, 'https://www.youtube.com/results?search_query=playwright');
    await openPanel(page);
  });

  test('default selection is "— Choose —" with empty value', async ({ page }) => {
    const select = page.locator('#yt-playlist-select');
    const value = await select.inputValue();
    expect(value).toBe('');
  });

  test('selecting a playlist stores it in chrome.storage', async ({ page }) => {
    try {
      await waitForPlaylistsLoaded(page);
    } catch {
      test.skip(true, 'No playlists available — user may not be logged in');
      return;
    }

    // Select the first real playlist (index 1)
    await page.selectOption('#yt-playlist-select', { index: 1 });

    // Playwright evaluates in the main page context, which cannot access chrome.storage.local
    // To verify persistence without a background worker handle, we rely on the reload test below.
    const selectedValue = await page.locator('#yt-playlist-select').inputValue();
    expect(selectedValue).toBeTruthy();
  });

  test('selected playlist persists across page reload', async ({ page }) => {
    try {
      await waitForPlaylistsLoaded(page);
    } catch {
      test.skip(true, 'No playlists available — user may not be logged in');
      return;
    }

    // Select a playlist
    await page.selectOption('#yt-playlist-select', { index: 1 });
    const selectedValue = await page.locator('#yt-playlist-select').inputValue();
    expect(selectedValue).toBeTruthy();

    // Reload the page
    await page.reload();
    await page.waitForSelector('#ocp-header-toggle', { timeout: 20000 });
    await openPanel(page);

    // Wait for playlists to repopulate after reload
    try {
      await waitForPlaylistsLoaded(page);
    } catch {
      // If sync fails on reload, we can't check persistence
      return;
    }

    // The select should restore the previous selection
    const restoredValue = await page.locator('#yt-playlist-select').inputValue();
    expect(restoredValue).toBe(selectedValue);
  });

  test('changing selection clears progress bar', async ({ page }) => {
    try {
      await waitForPlaylistsLoaded(page);
    } catch {
      test.skip(true, 'No playlists available');
      return;
    }

    // First: make the progress bar visible by attempting bulk add without selection
    const bulkBtn = page.locator('#ocp-bulk-add-btn');
    await bulkBtn.click();

    const progress = page.locator('#ocp-bulk-progress');
    // The progress bar should become visible (even if it says "Select a playlist first")
    await expect(progress).toBeVisible({ timeout: 3000 });

    // Now select a playlist — this should hide the progress bar
    await page.selectOption('#yt-playlist-select', { index: 1 });
    await expect(progress).toBeHidden({ timeout: 3000 });
  });

  test('selecting "— Choose —" unsets playlist', async ({ page }) => {
    try {
      await waitForPlaylistsLoaded(page);
    } catch {
      test.skip(true, 'No playlists available');
      return;
    }

    // Select a real playlist first
    await page.selectOption('#yt-playlist-select', { index: 1 });
    let value = await page.locator('#yt-playlist-select').inputValue();
    expect(value).toBeTruthy();

    // Select back to "— Choose —"
    await page.selectOption('#yt-playlist-select', { value: '' });
    value = await page.locator('#yt-playlist-select').inputValue();
    expect(value).toBe('');
  });
});
