#!/usr/bin/env bash
# One-time-per-build PREP: regenerate the iOS native project as the PREVIEW
# variant, STRIPPED for a free Apple Personal Team, then pod install.
# Run this before ios-device-build.sh (can run over SSH; only the signed BUILD
# needs a GUI session).
#
# What T3CODE_IOS_PERSONAL_TEAM does (apps/mobile/personalTeam.ts): removes the
# widget target + paid entitlements (push / Sign in with Apple / associated
# domains / app groups) that a free team cannot sign, and unsets ios.appleTeamId
# so Xcode fills in your personal team.
#
# Why a fresh bundle id: the default id collides with the paid "T3 Tools" App ID
# — pick your own reverse-DNS id you control.
#
# Why APP_VARIANT=preview matters: prebuild WITHOUT it regenerates as the BASE
# variant, so the workspace/scheme become `T3Code` (not `T3CodePreview`) and you
# get confusing "no such module GhosttyKit" errors (it's vendored + fine — the
# module just isn't wired into the wrong variant's project).
#
# ============================ VARIABLES ====================================
REPO=${REPO:-$HOME/dev/t3code}
VP_BIN=${VP_BIN:-$HOME/.vite-plus/bin}
PERSONAL_TEAM_BUNDLE_ID=${PERSONAL_TEAM_BUNDLE_ID:-com.example.t3code}
# ===========================================================================
set -e
export PATH="$VP_BIN:/opt/homebrew/bin:/usr/bin:/bin"
cd "$REPO/apps/mobile"

APP_VARIANT=preview \
T3CODE_IOS_PERSONAL_TEAM=1 \
T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID="$PERSONAL_TEAM_BUNDLE_ID" \
  node_modules/.bin/expo prebuild --clean -p ios

# pod install refreshes native pods against current node_modules. If you hit
# "Build input files cannot be found" for RN Swift files (stale Pods refs after
# heavy dep churn), the --clean above already regenerates them.
( cd ios && pod install )
echo "IOS_PERSONAL_PREP_DONE (variant=preview, bundle=$PERSONAL_TEAM_BUNDLE_ID)"
