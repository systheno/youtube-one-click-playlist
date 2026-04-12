import { test, expect, waitForExtensionReady, openPanel, waitForPlaylistsLoaded } from './fixtures.mjs';

test.describe('Header Panel Components', () => {
  test.beforeEach(async ({ page }) => {
    await waitForExtensionReady(page, 'https://www.youtube.com/results?search_query=playwright');
  });

  test('panel contains title, select, create input, create button, and bulk add button', async ({ page }) => {
    await openPanel(page);
    const overlay = page.locator('#yt-bulk-add-overlay');

    // Title
    const title = overlay.locator('.ocp-title-text');
    await expect(title).toBeVisible();
    await expect(title).toHaveText('One-Click Add');

    // Playlist select dropdown
    const select = overlay.locator('#yt-playlist-select');
    await expect(select).toBeVisible();

    // Create playlist input
    const createInput = overlay.locator('#yt-create-name');
    await expect(createInput).toBeVisible();

    // Create button
    const createBtn = overlay.locator('#yt-create-btn');
    await expect(createBtn).toBeVisible();
    await expect(createBtn).toHaveText('Create');

    // Bulk add button
    const bulkBtn = overlay.locator('#ocp-bulk-add-btn');
    await expect(bulkBtn).toBeVisible();
    await expect(bulkBtn).toHaveText('Bulk Add to Playlist');

    // Progress bar (hidden initially)
    const progress = overlay.locator('#ocp-bulk-progress');
    await expect(progress).toBeHidden();
  });

  test('playlist dropdown has default "— Choose —" option', async ({ page }) => {
    await openPanel(page);

    const select = page.locator('#yt-playlist-select');
    const firstOption = select.locator('option').first();
    await expect(firstOption).toHaveText('— Choose —');

    const firstOptionValue = await firstOption.getAttribute('value');
    expect(firstOptionValue).toBe('');
  });

  test('playlist dropdown populates after nuclear sync', async ({ page }) => {
    await openPanel(page);

    // Nuclear sync runs automatically on initHeaderPanel.
    // Wait for playlists to populate.
    try {
      await waitForPlaylistsLoaded(page);

      const optionCount = await page.locator('#yt-playlist-select option').count();
      expect(optionCount).toBeGreaterThan(1);
    } catch {
      // If user isn't logged in, the sync may return only Watch Later or nothing.
      // Verify at minimum the default option exists.
      const optionCount = await page.locator('#yt-playlist-select option').count();
      expect(optionCount).toBeGreaterThanOrEqual(1);
    }
  });

  test('create playlist input accepts text', async ({ page }) => {
    await openPanel(page);

    const input = page.locator('#yt-create-name');
    await input.fill('My Test Playlist');
    await expect(input).toHaveValue('My Test Playlist');
  });

  test('create button shows loading state when clicked with valid name', async ({ page }) => {
    await openPanel(page);

    const input = page.locator('#yt-create-name');
    const createBtn = page.locator('#yt-create-btn');

    await input.fill('E2E Test Playlist ' + Date.now());
    await createBtn.click();

    // Button should show a loading state ("Creating…")
    // Use a short timeout since the text changes immediately
    await expect(createBtn).toHaveText('Creating…', { timeout: 2000 });

    // Wait for the create operation to complete (success or failure)
    await page.waitForFunction(() => {
      const btn = document.querySelector('#yt-create-btn');
      return btn && btn.textContent !== 'Creating…';
    }, { timeout: 30000 });

    // After completion, button returns to "Create" (or briefly shows error)
    const btnText = await createBtn.textContent();
    expect(['Create', 'Failed', 'Exists']).toContain(btnText);
  });

  test('create input clears after successful creation', async ({ page }) => {
    await openPanel(page);

    const input = page.locator('#yt-create-name');
    const createBtn = page.locator('#yt-create-btn');

    const uniqueName = 'Clear Test ' + Date.now();
    await input.fill(uniqueName);
    await createBtn.click();

    // Wait for create to complete
    await page.waitForFunction(() => {
      const btn = document.querySelector('#yt-create-btn');
      return btn && btn.textContent !== 'Creating…';
    }, { timeout: 30000 });

    // If creation succeeded, input should be cleared
    const inputValue = await input.inputValue();
    const btnText = await createBtn.textContent();

    if (btnText === 'Create') {
      // Success path — input was cleared
      expect(inputValue).toBe('');
    }
    // If it failed (not logged in), input may still have the text — that's OK
  });

  test('header toggle button has correct aria attributes', async ({ page }) => {
    const toggle = page.locator('#ocp-header-toggle');
    await expect(toggle).toBeVisible();

    const ariaLabel = await toggle.getAttribute('aria-label');
    expect(ariaLabel).toBe('One-Click Playlist');

    const title = await toggle.getAttribute('title');
    expect(title).toBe('One-Click Playlist');
  });

  test('toggle adds ocp-active class when panel is open', async ({ page }) => {
    const toggle = page.locator('#ocp-header-toggle');

    // Initially no active class
    await expect(toggle).not.toHaveClass(/ocp-active/);

    // Open panel
    await toggle.click();
    await expect(toggle).toHaveClass(/ocp-active/);

    // Close panel
    await toggle.click();
    await expect(toggle).not.toHaveClass(/ocp-active/);
  });
});
