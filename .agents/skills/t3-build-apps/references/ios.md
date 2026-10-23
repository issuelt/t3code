# iOS on-device (free Apple Personal Team)

Two scripts: `ios-personal-prep.sh` (regenerate + strip; can run over SSH) then
`ios-device-build.sh` (build + install; **GUI session only**).

## First-time machine setup

1. **Xcode** installed (owner: Xcode 26.6). Launch it once, accept the license.
2. **Sign in your Apple ID:** Xcode → Settings → Accounts → add your Apple ID.
   A free account gives you a **Personal Team** — enough for on-device installs
   (no paid Developer Program needed).
3. **Pair the device:** plug in the iPhone, trust the computer on the phone.
   Confirm it's visible: `xcrun devicectl list devices`. Note the device name
   (owner: `fon`) for `DEVICE_NAME`.
4. **Find your REAL team id** (see trap b below):
   ```bash
   defaults read com.apple.dt.Xcode IDEProvisioningTeamByIdentifier
   ```
   Use that 10-char id for `DEV_TEAM` — NOT a value from a keychain cert.
5. Choose a bundle id you control (`PERSONAL_TEAM_BUNDLE_ID`, reverse-DNS, e.g.
   `com.example.t3code`) so it can't collide with the paid "T3 Tools" App ID.

## Recipe

```bash
# 1. PREP (SSH ok): strip paid capabilities + regen the preview variant.
PERSONAL_TEAM_BUNDLE_ID=com.example.t3code bash .../ios-personal-prep.sh

# 2. BUILD+INSTALL — GUI session only. Launch from the desktop:
osascript -e 'tell application "Terminal" to do script "DEV_TEAM=XXXXXXXXXX DEVICE_NAME=fon ~/dev/t3code/.claude/skills/t3-build-apps/scripts/ios-device-build.sh"'
```

## What `T3CODE_IOS_PERSONAL_TEAM` strips (apps/mobile/personalTeam.ts)

A free personal team cannot provision any capability that needs a
program-granted entitlement, so the strip mode removes them before signing:

- the **widget / Live Activity target** (needs App Group + push);
- **push** (`aps-environment`), **Sign in with Apple**
  (`com.apple.developer.applesignin`, also forced off in the Clerk plugin),
  **Associated Domains**, **App Groups**;
- unsets `ios.appleTeamId` so Xcode fills in your personal team.
  It runs ONLY when `T3CODE_IOS_PERSONAL_TEAM` is truthy; the default build is untouched.

## Three traps

- **(a) Signing works ONLY in a GUI session.** Over plain SSH `xcodebuild` says
  "No Account for Team" even though Xcode has the account. Launch via the
  `osascript` Terminal pattern above.
- **(b) Keychain certs can carry DEAD team ids.** The cert
  "Apple Development: <name> (JPS73Z4GT6)" was a dead enrollment; the real
  Personal Team of the logged-in account was `C9US239HQB`. Read the true id from
  `defaults read com.apple.dt.Xcode IDEProvisioningTeamByIdentifier`.
- **(c) `no such module GhosttyKit` == wrong variant.** GhosttyKit is vendored
  and fine (`modules/t3-terminal/Vendor/libghostty/GhosttyKit.xcframework`, both
  device + simulator slices). The error only appears when prebuild ran WITHOUT
  `APP_VARIANT=preview` (regenerated as base `T3Code`, whose project didn't wire
  the t3-terminal framework). Always prebuild the intended variant.

## Free-team caveats

- The app **re-signs every 7 days** — rerun prep+build to refresh.
- No widget / push / Sign in with Apple in this build.
- First run on the phone: Settings → General → VPN & Device Management → Trust
  the developer.
- `apps/mobile/ios/` is Expo-managed (reproducible from config); leaving it
  regenerated as a different variant is harmless — just re-prep the variant you
  want. After heavy dep churn, stale `ios/Pods` refs cause "Build input files
  cannot be found" — `expo prebuild --clean -p ios` + `pod install` fixes it.
