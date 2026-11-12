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
"$EAS" submit -p ios --profile fork-testflight --path "$IPA" --non-interactive 2>&1 | tail -4
sleep 5
T3CODE_IOS_BUNDLE_ID=com.yangxin.t3code.fork "$EAS" submit:status -p ios --non-interactive 2>&1 | tr "\r" "\n" | grep -v "^$" | tail -6
