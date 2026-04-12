import { test, expect, waitForExtensionReady } from './fixtures.mjs';

test.describe('Extension Load and Basic Injection', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to YouTube search results to ensure videos are present and wait for extension
    await waitForExtensionReady(page, 'https://www.youtube.com/results?search_query=playwright+testing');
  });

  test('injects add buttons on video thumbnails', async ({ page }) => {
    // Wait for search result renderers
    await page.waitForSelector('ytd-video-renderer', { timeout: 15000 });


    // Assuming the content script fires automatically on youtube.com based on the manifest,
    // wait for the injected plus buttons to appear.
    await page.waitForFunction(() => {
      return document.querySelectorAll('.yt-one-click-add-btn').length > 0;
    }, { timeout: 10000 });

    const buttons = await page.$$('.yt-one-click-add-btn');
    expect(buttons.length).toBeGreaterThan(0);
  });

  test('buttons re-inject after SPA navigation', async ({ page }) => {
    await page.waitForSelector('.yt-one-click-add-btn', { timeout: 15000 });

    // Navigate to subscriptions or results to trigger SPA transition
    const searchInput = page.getByRole('combobox', { name: /search/i }).first();
    // Wait for the input to be visible and interactable
    await expect(searchInput).toBeVisible({ timeout: 10000 });
    
    await searchInput.fill('playwright testing');
    await searchInput.press('Enter');
    
    await page.waitForURL('**/results**');

    // Wait for the buttons to appear on the new DOM
    await page.waitForFunction(() => {
      return document.querySelectorAll('.yt-one-click-add-btn').length > 0;
    }, { timeout: 10000 });

    const buttons = await page.$$('.yt-one-click-add-btn');
    expect(buttons.length).toBeGreaterThan(0);
  });
});
