#!/bin/bash
# usage: local-testflight.sh <basename>   (e.g. t3code-20261112)
# Builds the fork iOS app locally and submits to TestFlight. Log: /tmp/t3code-eas-<ts>.log
set -uo pipefail
NAME="${1:?usage: local-testflight.sh <basename>}"
REPO="$HOME/t3code-ios-local"
LOG="/tmp/t3code-eas-$(date +%Y%m%d-%H%M).log"
export PATH="$HOME/portable-ruby/3.4.5/bin:$HOME/gem-ruby34/bin:$HOME/.nvm/versions/node/v26.13.0/bin:$PATH"
export GEM_HOME="$HOME/gem-ruby34"
export EXPO_TOKEN="$(cat "$HOME/.expo/expo_token")"
export EXPO_NO_CAPABILITY_SYNC=1
# react-native-enriched-markdown's postinstall downloads RaTeX.xcframework from
# GitHub, reachable only through the hy2 proxy. pnpm caches the build result in
# the store, so one offline run replays an empty ios/vendor until someone runs
# `pnpm rebuild react-native-enriched-markdown` with the proxy set.
export https_proxy="${T3_BUILD_PROXY:-http://127.0.0.1:17890}" HTTPS_PROXY="${T3_BUILD_PROXY:-http://127.0.0.1:17890}"
export no_proxy=localhost,127.0.0.1 NO_PROXY=localhost,127.0.0.1
EAS="$HOME/.npm/_npx/49551ffe00939648/node_modules/.bin/eas"
[ -x "$EAS" ] || EAS="$(command -v eas)"

# Local node_modules must byte-match what the sandbox installs from the lockfile,
# otherwise the fingerprint pre-check fails the build. Clean install is ~20s.
cd "$REPO" || exit 9
rm -rf node_modules
pnpm install --prefer-offline >>"$LOG" 2>&1 || { echo "EXIT:1 (pnpm install)" >>"$LOG"; tail -5 "$LOG"; exit 1; }

cd "$REPO/apps/mobile" || exit 9
IPA="$REPO/$NAME.ipa"
"$EAS" build --platform ios --profile fork-testflight --local --non-interactive --output "$IPA" >>"$LOG" 2>&1
RC=$?
echo "EXIT:$RC" >>"$LOG"
if [ "$RC" != 0 ]; then
  echo "BUILD FAILED, log: $LOG"
  grep -m3 -E "error:|Error:|Unable to resolve" "$LOG" | tail -3
  exit 1
fi
echo "BUILD OK: $IPA (log $LOG)"
# EAS Submit's archive upload stalls at 0% from this network; upload straight to
# ASC with the local key when ~/.t3code-asc.env defines ASC_KEY_ID/ASC_ISSUER_ID.
if [ -f "$HOME/.t3code-asc.env" ]; then
  . "$HOME/.t3code-asc.env"
  xcrun altool --upload-package -f "$IPA" --apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER_ID" 2>&1 | tail -6
else
  "$EAS" submit -p ios --profile fork-testflight --path "$IPA" --non-interactive 2>&1 | tail -4
  sleep 5
  T3CODE_IOS_BUNDLE_ID=com.yangxin.t3code.fork "$EAS" submit:status -p ios --non-interactive 2>&1 | tr "\r" "\n" | grep -v "^$" | tail -6
fi
