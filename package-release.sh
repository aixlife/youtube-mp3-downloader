#!/bin/bash
# Build a shareable ZIP for sideload installation.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
VERSION="$(node -e "console.log(require('${ROOT_DIR}/server/package.json').version)")"
APP_SLUG="youtube-mp3-plaud"
DIST_DIR="${ROOT_DIR}/dist"
STAGE_DIR="${DIST_DIR}/${APP_SLUG}-${VERSION}"
ZIP_PATH="${DIST_DIR}/${APP_SLUG}-${VERSION}.zip"

rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR/server" "$STAGE_DIR/extension" "$DIST_DIR"

cp "$ROOT_DIR/README.md" "$STAGE_DIR/"
cp "$ROOT_DIR/install-mac.sh" "$STAGE_DIR/"
cp "$ROOT_DIR/install-windows.bat" "$STAGE_DIR/"
cp "$ROOT_DIR/server/package.json" "$STAGE_DIR/server/"
cp "$ROOT_DIR/server/package-lock.json" "$STAGE_DIR/server/"
cp "$ROOT_DIR/server/server.js" "$STAGE_DIR/server/"
cp "$ROOT_DIR/extension/manifest.json" "$STAGE_DIR/extension/"
cp "$ROOT_DIR/extension/content.js" "$STAGE_DIR/extension/"
cp "$ROOT_DIR/extension/style.css" "$STAGE_DIR/extension/"
cp "$ROOT_DIR/extension/icon48.png" "$STAGE_DIR/extension/"
cp "$ROOT_DIR/extension/icon128.png" "$STAGE_DIR/extension/"

cat > "$STAGE_DIR/START-HERE.txt" <<'TEXT'
YouTube MP3 + PLAUD automation

macOS:
1. Open Terminal.
2. Drag this folder into Terminal after typing: cd 
3. Run: bash install-mac.sh
4. Open chrome://extensions, enable Developer mode, and load the extension folder.
5. Open YouTube and use the MP3 / PLAUD buttons below a video.

Windows:
1. Right-click install-windows.bat.
2. Run as administrator.
3. Open chrome://extensions, enable Developer mode, and load the extension folder.

PLAUD:
- The first PLAUD send opens a browser for login.
- Log in once, then click PLAUD send again.
- Transcripts are saved to ~/Downloads/PlaudTranscripts on macOS.
TEXT

rm -f "$ZIP_PATH"
(
  cd "$DIST_DIR"
  zip -qry "$(basename "$ZIP_PATH")" "$(basename "$STAGE_DIR")"
)

echo "Built: $ZIP_PATH"
