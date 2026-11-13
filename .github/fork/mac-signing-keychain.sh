#!/usr/bin/env bash
# Usage: mac-signing-keychain.sh import | cleanup
# import needs P12 and P12_PASSWORD; both need RUNNER_TEMP and GITHUB_ENV.
# Runs on /bin/bash 3.2 on the self-hosted runner.
set -euo pipefail

keychain="$RUNNER_TEMP/fork-signing.keychain-db"
saved_search_list="$RUNNER_TEMP/fork-signing.search-list"
p12="$RUNNER_TEMP/fork-signing.p12"

search_list() {
  security list-keychains -d user | sed -e 's/^[[:space:]]*"//' -e 's/"[[:space:]]*$//'
}

set_search_list() {
  local args=()
  local entry
  while IFS= read -r entry; do
    [ -n "$entry" ] && args+=("$entry")
  done
  security list-keychains -d user -s ${args[@]+"${args[@]}"}
}

import() {
  trap 'rm -f "$p12"' EXIT
  search_list > "$saved_search_list"
  local password
  password="$(openssl rand -hex 16)"
  security create-keychain -p "$password" "$keychain"
  security set-keychain-settings -lut 21600 "$keychain"
  security unlock-keychain -p "$password" "$keychain"
  printf '%s' "$P12" | base64 --decode > "$p12"
  security import "$p12" -k "$keychain" -P "$P12_PASSWORD" -T /usr/bin/codesign
  security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$password" "$keychain" >/dev/null
  { echo "$keychain"; grep -vxF "$keychain" "$saved_search_list" || true; } | set_search_list
  # The self-hosted runner has no sudo; its host trusts this certificate already.
  if [ "${RUNNER_ENVIRONMENT:-}" = github-hosted ]; then
    sudo security add-trusted-cert -d -r trustRoot -p codeSign -k /Library/Keychains/System.keychain .github/fork/mac-signing-cert.pem
  fi
  security find-identity -v -p codesigning "$keychain" | grep -F '"T3 Code Fork Signing"'
  {
    echo "CSC_NAME=T3 Code Fork Signing"
    # A runner without a login session ignores the search list in later steps.
    echo "CSC_KEYCHAIN=$keychain"
    # electron-builder skips signing on pull requests unless told otherwise.
    echo "CSC_FOR_PULL_REQUEST=true"
  } >> "$GITHUB_ENV"
}

cleanup() {
  rm -f "$p12"
  if [ -e "$keychain" ]; then
    security delete-keychain "$keychain"
  fi
  if [ -f "$saved_search_list" ]; then
    { grep -vxF "$keychain" "$saved_search_list" || true; } | set_search_list
    rm -f "$saved_search_list"
  fi
}

case "${1:-}" in
  import) import ;;
  cleanup) cleanup ;;
  *)
    echo "usage: $0 import | cleanup" >&2
    exit 2
    ;;
esac
