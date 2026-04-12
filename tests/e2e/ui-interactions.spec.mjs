import { test, expect, waitForExtensionReady, openPanel } from './fixtures.mjs';

test.describe('Overlay UI Component', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to YouTube to see the injected overlay
    await waitForExtensionReady(page, 'https://www.youtube.com/results?search_query=playwright');
  });

  test('overlay loads successfully and contains playlist selector', async ({ page }) => {
    // Check that the overlay exists
    const overlay = page.locator('#yt-bulk-add-overlay');
    
    // We wait for it to be present in the DOM (it's hidden initially)
    await expect(overlay).toBeAttached({ timeout: 15000 });

    const title = overlay.locator('.ocp-title-text');
    await expect(title).toHaveText('One-Click Add');

    const select = overlay.locator('#yt-playlist-select');
    await expect(select).toBeAttached();
  });

  test('overlay toggle button works', async ({ page }) => {
    const toggle = page.locator('#ocp-header-toggle');
    await expect(toggle).toBeVisible({ timeout: 15000 });

    const overlay = page.locator('#yt-bulk-add-overlay');
    await expect(overlay).toBeHidden();

    // Click toggle to show (force: true bypasses YouTube overlays that intercept clicks)
    await toggle.click({ force: true });
    await expect(overlay).toBeVisible();

    // Click toggle again to hide
    await toggle.click({ force: true });
    await expect(overlay).toBeHidden();
  });
});
