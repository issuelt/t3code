#!/usr/bin/env bash
# Build the mac dmg at current HEAD, install to /Applications, health-check.
# Builds and installs the app, then checks its local endpoint. Prints explicit
# markers so a remote poller can trust them over the ssh exit code.
set -u
export PATH="$HOME/.vite-plus/bin:/opt/homebrew/bin:/run/current-system/sw/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
REPO="$HOME/dev/t3code"
APP="/Applications/T3 Code (Alpha).app"
HEALTH_URL="http://127.0.0.1:3773/.well-known/t3/environment"

cd "$REPO" || { echo "NO REPO"; exit 1; }
HEAD_HASH=$(git rev-parse HEAD)
echo "=== HEAD=$HEAD_HASH ==="
echo "=== node=$(node --version) pnpm=$(pnpm --version) vp=$(command -v vp) ==="

echo "=== BUILD START ==="
pnpm dist:desktop:dmg
BUILD_EXIT=$?
echo "=== BUILD_EXIT=$BUILD_EXIT ==="
if [ "$BUILD_EXIT" != "0" ]; then
  echo "=== BUILD FAILED — stopping ==="
  exit "$BUILD_EXIT"
fi

# Newest dmg in release/
DMG=$(ls -t "$REPO"/release/*.dmg 2>/dev/null | head -1)
echo "=== DMG=$DMG ==="
[ -z "$DMG" ] && { echo "NO DMG PRODUCED"; exit 1; }

echo "=== INSTALL (mount + copy to /Applications) ==="
MNT=$(mktemp -d /tmp/t3dmg.XXXXXX)
hdiutil attach "$DMG" -nobrowse -noverify -mountpoint "$MNT" >/dev/null || { echo "MOUNT FAILED"; exit 1; }
SRC_APP=$(find "$MNT" -maxdepth 1 -name '*.app' | head -1)
echo "src_app=$SRC_APP"
if [ -z "$SRC_APP" ]; then echo "NO .app IN DMG"; hdiutil detach "$MNT" >/dev/null 2>&1; exit 1; fi
# quit a running instance so the copy isn't clobbered by a live process
osascript -e 'tell application "T3 Code (Alpha)" to quit' >/dev/null 2>&1 || true
for _ in $(seq 1 15); do
  APP_RUNNING=$(osascript -e 'application "T3 Code (Alpha)" is running' 2>/dev/null || echo false)
  [ "$APP_RUNNING" = "false" ] && break
  sleep 1
done
if [ "$APP_RUNNING" != "false" ]; then
  echo "APP DID NOT QUIT — stopping before install"
  hdiutil detach "$MNT" >/dev/null 2>&1 || true
  exit 1
fi
rm -rf "$APP"
cp -R "$SRC_APP" "$APP" || { echo "COPY FAILED"; hdiutil detach "$MNT" >/dev/null 2>&1; exit 1; }
xattr -dr com.apple.quarantine "$APP" >/dev/null 2>&1 || true
hdiutil detach "$MNT" >/dev/null 2>&1 || true
rmdir "$MNT" >/dev/null 2>&1 || true
echo "=== INSTALLED to $APP ==="

echo "=== installed commit ==="
INSTALLED_HASH=$(node -e 'try{console.log(require(process.argv[1]).t3codeCommitHash||"NONE")}catch(e){console.log("READ_ERR")}' "$APP/Contents/Resources/app/package.json" 2>&1)
echo "t3codeCommitHash=$INSTALLED_HASH"
echo "HEAD_HASH=$HEAD_HASH"
# The app stores a 12-char short hash; compare by prefix of the full HEAD.
case "$HEAD_HASH" in
  "$INSTALLED_HASH"*) echo "COMMIT_MATCH=yes" ;;
  *) echo "COMMIT_MATCH=no" ;;
esac

echo "=== launch + health ==="
open "$APP" 2>&1 || echo "note: open failed (headless?) — check stderr for 'backend ready'"
code=000
for _ in $(seq 1 40); do
  code=$(curl -fsS --max-time 5 -o /dev/null -w '%{http_code}' "$HEALTH_URL" 2>/dev/null || echo 000)
  [ "$code" = "200" ] && break
  sleep 1
done
echo "=== HEALTH=$code ==="
echo "=== ALL DONE (BUILD_EXIT=$BUILD_EXIT HEALTH=$code COMMIT_MATCH: see above) ==="
