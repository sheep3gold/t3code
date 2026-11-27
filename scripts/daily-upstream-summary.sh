#!/usr/bin/env bash
# Summarize the upstream commits a merge commit on main absorbed.
# Usage: scripts/daily-upstream-summary.sh [merge-commit]   (default HEAD)
set -euo pipefail

MERGE="${1:-HEAD}"
git rev-parse --verify "$MERGE^{commit}" >/dev/null

UPSTREAM_HEAD="$(git rev-parse "$MERGE^2")"
PREV_MERGE="$(git log --merges --format=%H --grep="Merge upstream/main into main" --skip=1 -1 "$MERGE" || true)"
PREV_UPSTREAM=""
if [ -n "$PREV_MERGE" ]; then
  PREV_UPSTREAM="$(git rev-parse "$PREV_MERGE^2")"
fi

RANGE="$MERGE^1..$MERGE^2"
TOTAL="$(git rev-list --count "$RANGE")"

echo "merge=$MERGE"
echo "upstream_head=$UPSTREAM_HEAD"
echo "previous_upstream=${PREV_UPSTREAM:-none}"
echo "commits=$TOTAL"
echo

if [ -n "$PREV_UPSTREAM" ]; then
  echo "== diffstat =="
  git diff --shortstat "$PREV_UPSTREAM" "$UPSTREAM_HEAD"
  echo
  echo "== changed files by area =="
  git diff --name-only "$PREV_UPSTREAM" "$UPSTREAM_HEAD" \
    | awk -F/ '{ if ($1 == "apps" || $1 == "packages") print $1"/"$2; else print $1 }' \
    | sort | uniq -c | sort -rn | head -12
  echo
fi

echo "== by type =="
git log --format=%s "$RANGE" \
  | grep -v '^Merge ' \
  | sed -E 's/^([a-z]+)(\(([^)]*)\))?!?:.*/\1|\3/' \
  | sort | uniq -c | sort -rn | head -15
echo

echo "== by scope =="
git log --format=%s "$RANGE" \
  | grep -v '^Merge ' \
  | grep -oE '^[a-z]+\(([^)]*)\)' \
  | sed -E 's/^[a-z]+\((.*)\)/\1/' \
  | tr ',' '\n' | sed 's/ //g' \
  | sort | uniq -c | sort -rn | head -15
echo

echo "== features =="
git log --format=%s "$RANGE" | grep -E '^feat' | head -40
echo

echo "== perf =="
git log --format=%s "$RANGE" | grep -E '^perf' | head -20
echo

echo "== user-visible fixes =="
git log --format=%s "$RANGE" \
  | grep -E '^fix' \
  | grep -iE 'crash|freeze|froze|stuck|hang|panic|deadlock|corrupt|lost|leak|infinite|fail|failure|cannot|unable|wrong|timeout|slow|regress|not (show|save|load|update|open)|does not|doesn.t|blank|white screen' \
  | head -40
echo

echo "== notable non-fix =="
git log --format=%s "$RANGE" \
  | grep -vE '^(fix|feat|perf|chore|test|refactor|docs|build|ci|style)' \
  | head -20
