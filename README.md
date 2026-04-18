# YouTube One-Click Playlist

A Manifest V3 browser extension that adds a **+** button directly onto YouTube video thumbnails (home, search, subscriptions, shorts) so you can add a video to your favorite playlist with a single click. No menus, no dialogs, no context-switching.

## Key Features

- **One-Click Add**: Add any video to a pre-selected playlist instantly.
- **Broad Coverage**: Works on Home feed, Search results, Subscriptions, Shorts shelf, and the Watch-page sidebar.
- **Bulk Add**: Add every video currently visible on the page to your playlist at once.
- **Smart Duplicate Prevention**: Optional setting to skip videos that are already in the target playlist.
- **Privacy-First & Secure**: 
  - Uses your **existing YouTube session** — no Google OAuth, no API keys, and no login required.
  - Zero background network access, zero telemetry, and zero third-party servers.
  - All operations stay between your browser and YouTube.

## Installation

### Firefox (Recommended)
You can install the official extension from the **[Firefox Add-ons Store](https://addons.mozilla.org/en-US/firefox/addon/youtube-one-click-playlist/)**.

### Manual Installation (Unpacked)

#### For Firefox
1. Clone or download this repository.
2. Open Firefox and navigate to `about:debugging#/runtime/this-firefox`.
3. Click **Load Temporary Add-on...**.
4. Select the `manifest.json` file from the project folder.

#### For Chrome / Edge / Brave
1. Clone or download this repository.
2. Open `chrome://extensions`.
3. Enable **Developer mode** (toggle in the top right).
4. Click **Load unpacked** and select the project folder.

## How it Works

The extension uses YouTube's internal **InnerTube API**. It discovery-scrapes your playlists using a multi-source "Nuclear Sync" strategy (unioning data from `/feed/playlists`, library pages, and sidebar endpoints) to ensure your playlists are always found even if one part of the YouTube UI changes.

It generates an authenticated `SAPISIDHASH` from your local session cookies to securely authorize playlist mutations without needing a separate Google Cloud Console project or OAuth flow.

## Development

```bash
# Install dependencies
npm install

# Launch browser with extension loaded (hot-reloading)
npm start

# Run unit tests (Vitest)
npm test

# Run E2E tests (Playwright)
npm run test:e2e

# Build & Package for distribution
npm run build
```

## License

Distributed under the [ISC License](LICENSE).
