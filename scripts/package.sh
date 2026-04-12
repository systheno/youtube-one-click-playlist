#!/usr/bin/env bash
# Build the extension into a Firefox-installable .xpi and print install docs.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ARTIFACTS_DIR="$ROOT/web-ext-artifacts"
mkdir -p "$ARTIFACTS_DIR"

# web-ext build validates the manifest and zips the source tree, honoring
# the ignoreFiles list in package.json's "webExt" block.
npx --yes web-ext build \
    --source-dir "$ROOT" \
    --artifacts-dir "$ARTIFACTS_DIR" \
    --overwrite-dest

# Grab the freshest zip and mirror it as a .xpi so Firefox's
# "Install Add-on From File..." picker accepts it directly.
ZIP="$(ls -t "$ARTIFACTS_DIR"/*.zip 2>/dev/null | head -n 1 || true)"
if [[ -z "${ZIP}" ]]; then
  echo "ERROR: web-ext build did not produce a .zip in $ARTIFACTS_DIR" >&2
  exit 1
fi
XPI="${ZIP%.zip}.xpi"
cp -f "$ZIP" "$XPI"

cat <<EOF

==============================================================================
Built extension artifacts:
  ZIP: $ZIP
  XPI: $XPI
==============================================================================

HOW TO INSTALL PERMANENTLY IN FIREFOX
--------------------------------------

Firefox will not keep an unsigned extension installed across restarts on the
release (stable) channel. Pick ONE of the two options below.

OPTION 1 -- Developer Edition / Nightly / ESR (no Mozilla signing needed)
  Works on: Firefox Developer Edition, Firefox Nightly, Firefox ESR.
  Does NOT work on regular (stable) Firefox.

  1. In the target Firefox, open:            about:config
  2. Search for:                              xpinstall.signatures.required
  3. Toggle its value to:                     false
  4. Open:                                    about:addons
  5. Click the gear icon -> "Install Add-on From File..."
  6. Pick the .xpi above:
       $XPI
  7. Confirm the install. The extension now survives restarts.

OPTION 2 -- Sign the XPI via Mozilla (works on ANY Firefox, including stable)
  You sign it as an "unlisted" self-distributed add-on. Mozilla still issues
  the signature, but the add-on is not published on addons.mozilla.org.

  1. Create AMO API credentials (one-time):
       https://addons.mozilla.org/developers/addon/api/key/
  2. Export them in your shell:
       export WEB_EXT_API_KEY=user:XXXXXXX:YY
       export WEB_EXT_API_SECRET=ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ
  3. From the repo root run:
       npx web-ext sign --channel=unlisted
  4. When it finishes, a signed .xpi appears in:
       $ARTIFACTS_DIR
  5. Install it via about:addons -> gear -> "Install Add-on From File..."
     exactly like Option 1 step 5-6. No about:config flip required.

TEMPORARY install (useful while iterating, lost on Firefox restart)
  1. Open:  about:debugging#/runtime/this-firefox
  2. Click: "Load Temporary Add-on..."
  3. Pick:  $ROOT/manifest.json
           (or the .xpi above -- either works)

EOF
