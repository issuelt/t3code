---
name: t3-build-apps
description: Build and install t3code app targets — desktop (mac dmg / win exe / linux AppImage), Android on-device, and iOS on-device (free personal team). Use when producing a distributable app artifact or updating an app on a physical device. For the browser/server flow use t3-server-deploy instead.
---

# t3 app builds (desktop, Android, iOS)

One skill per app target. Each has a **first-time machine setup** guide plus the
proven build recipe. Long walkthroughs and hard-won gotchas live in
`references/`; the essentials are here.

> Desktop apps are **self-contained**: the Electron app bundles the web client
> AND the server, and the renderer always loads the LOCAL bundle even for remote
> environments. So UI changes require rebuilding each desktop app — updating a
> serve host only fixes the browser flow.

All desktop builds go through `node scripts/build-desktop-artifact.ts` (the
`dist:desktop:*` package.json scripts wrap it). Useful flags/env:
`--platform mac|linux|win`, `--target dmg|AppImage|nsis`, `--arch arm64|x64|universal`,
`--skip-build` (reuse existing dist), `--keep-stage`, `--wsl-prebuild <pty.node>`,
`--signed`. No auto-update feed is baked in unless
`T3CODE_DESKTOP_UPDATE_REPOSITORY`/`GITHUB_REPOSITORY` is set at build time — so
local builds won't self-clobber.

Autoupdating builds come from `.github/workflows/fork-release.yml`: every push to
`main` publishes a `vX.Y.Z-nightly.<date>.<run>` prerelease on issuelt/t3code
(mac arm64 dmg+zip, Linux AppImage+deb, Windows nsis), and installed nightlies
update from it. The Mac build is signed with the dedicated self-signed cert in
`.github/fork/mac-signing-cert.pem` (key and password in the
`FORK_MAC_SIGNING_P12`/`FORK_MAC_SIGNING_PASSWORD` secrets, local copy in
`~/.local/share/t3code-fork-signing`). Squirrel.Mac only accepts updates
signed by that same cert, so never rotate it casually; an ad hoc local build
installed over a fork release stops it updating until you reinstall a release.

After a build, remove stale t3 checkouts on the build host as described in
`t3-server-deploy` ("Clean up old t3 checkouts"). On the Mac, also delete
superseded dmgs in `release/` and old `/Applications/T3 Code (Alpha).bak-*.app`
copies, keeping the newest backup.

## Mac dmg

```bash
pnpm dist:desktop:dmg            # arm64 by default; :dmg:x64 / :dmg:arm64 to pin
# artifact -> release/ . Unsigned: first launch needs right-click-Open or xattr.
```

Launch and verify the installed app in a login session. Over SSH, a headless
launch can fail on Keychain access even when the build is sound. See
`references/desktop.md` for host and signing notes.

## Windows exe (cross-build on Linux)

```bash
pnpm dist:desktop:win:x64        # NSIS installer -> release/
```

Needs **wine** (`nix profile add nixpkgs#wine`). node-pty's gyp step needs a
`nix-shell` with `python3`/`gcc`/`gnumake`, and `vp` on PATH. Cross-built
packages **lack the WSL node-pty prebuild** → the WSL backend won't start
(native backend + remote envs are fine); supply one with
`--wsl-prebuild <pty.node>` if you need it. See `references/desktop.md`.

## Android on-device

```bash
# One-time setup first (adb, USB debugging) — see references/android.md.
bash .claude/skills/t3-build-apps/scripts/android-device-build.sh
```

The script does prebuild --clean → restore the **stable debug keystore** →
`gradlew --stop` → assembleRelease → `adb install -r`. The stable keystore keeps
updates installing IN PLACE (a `--clean` otherwise regenerates a random key →
`INSTALL_FAILED_UPDATE_INCOMPATIBLE` → uninstall wipes data). vp's node must lead
PATH (system/nix node SIGABRTs in Metro). Setup + keystore details:
`references/android.md`.

## iOS on-device (free personal team)

```bash
# One-time: Xcode + Apple ID login, pair the device — see references/ios.md.
PERSONAL_TEAM_BUNDLE_ID=com.example.t3code \
  bash .claude/skills/t3-build-apps/scripts/ios-personal-prep.sh   # can run over SSH
# The signed build MUST run in a GUI session (osascript Terminal launcher):
osascript -e 'tell application "Terminal" to do script "DEV_TEAM=XXXXXXXXXX DEVICE_NAME=fon ~/dev/t3code/.claude/skills/t3-build-apps/scripts/ios-device-build.sh"'
```

`ios-personal-prep.sh` strips paid capabilities (`T3CODE_IOS_PERSONAL_TEAM`) and
regenerates the **preview** variant with a fresh bundle id. Three traps:
signing works ONLY in a GUI session; the real team id comes from
`defaults read com.apple.dt.Xcode IDEProvisioningTeamByIdentifier` (keychain
certs can carry DEAD team ids); a free-team build **re-signs every 7 days**.
Full walkthrough: `references/ios.md`.

## Building on someone else's Mac (remote host)

For contributors without a local Mac: ssh keys, host aliases, scp-not-heredoc,
`nohup` + log polling, tailnet vs LAN fallback — `references/remote-build-host.md`.

## Mobile OTA (no rebuild)

JS-only mobile changes can ship as an EAS OTA update instead of a device
rebuild — see `references/mobile-ota.md`.
