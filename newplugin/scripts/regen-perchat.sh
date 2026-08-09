#!/usr/bin/env bash
# Regenerate a *.perchat.patch as a clean delta on top of its global *.patch base.
# A perchat patch is a DELTA that must apply AFTER its global *.patch (CI sorts
# .patch < .perchat.patch and accumulates into the working tree).
#
# Workflow:
#   1) regen-perchat.sh base   <file.perchat.patch>
#        -> applies + stages the global base; you then make the per-chat edits
#           UNSTAGED (do NOT `git add` them).
#   2) regen-perchat.sh capture <file.perchat.patch>
#        -> captures your UNSTAGED working-vs-index diff into the perchat patch,
#           restores native, and validates the perchat patch applies on top of
#           the global base.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT" || exit 1

MODE="${1:-}"
PERCHAT="${2:-}"
[ -z "$MODE" ] && { echo "usage: $0 <base|capture> <file.perchat.patch>" >&2; exit 1; }
[ -z "$PERCHAT" ] && { echo "usage: $0 <base|capture> <file.perchat.patch>" >&2; exit 1; }
case "$PERCHAT" in *.perchat.patch) ;; *) echo "not a .perchat.patch: $PERCHAT" >&2; exit 1;; esac

GLOBAL="${PERCHAT%.perchat.patch}.patch"
[ -f "$GLOBAL" ] || { echo "global base not found: $GLOBAL" >&2; exit 1; }

# Files the global base touches (excludes /dev/null deletion markers).
GLOBAL_FILES="$(git apply --numstat "$GLOBAL" 2>/dev/null | awk '{print $3}' | grep -v '^/')"

clean_tree_or_die() {
  if [ -n "$(git status --porcelain src src-tauri)" ]; then
    echo "!! Refusing: src/ or src-tauri/ has uncommitted changes. Commit or stash first." >&2
    exit 1
  fi
}

if [ "$MODE" = "base" ]; then
  clean_tree_or_die
  git apply "$GLOBAL" || { echo "!! global base failed to apply" >&2; exit 1; }
  # Stage ONLY the files the global base touched.
  echo "$GLOBAL_FILES" | grep -v '^$' | xargs -r git add || true
  echo "global base applied + staged."
  echo "now make your per-chat edits UNSTAGED, then run: $0 capture $PERCHAT"

elif [ "$MODE" = "capture" ]; then
  # The index must still contain EXACTLY the global base. If the user staged
  # their per-chat edits, the diff below would silently miss them — catch it here.
  STAGED="$(git diff --cached --name-only | sort)"
  EXPECTED="$(echo "$GLOBAL_FILES" | grep -v '^$' | sort)"
  if [ "$STAGED" != "$EXPECTED" ]; then
    echo "!! Index does not match the global base — your edits may have been staged." >&2
    echo "   Expected staged: $(echo "$EXPECTED" | tr '\n' ' ')" >&2
    echo "   Actual staged:   $(echo "$STAGED" | tr '\n' ' ')" >&2
    echo "   Fix: re-run '$0 base $PERCHAT' on a clean tree, make UNSTAGED edits, then capture." >&2
    exit 1
  fi
  git --no-pager diff -- > "$PERCHAT"
  echo "captured delta -> $PERCHAT ($(wc -l < "$PERCHAT") lines)"
  # restore native fully
  git checkout HEAD -- src-tauri src 2>/dev/null
  git reset -q HEAD src-tauri src 2>/dev/null
  git clean -fd src-tauri src >/dev/null 2>&1
  # validate perchat applies on top of global base
  git apply "$GLOBAL" || { echo "!! global base failed during validation" >&2; exit 1; }
  if git apply --check "$PERCHAT" 2>/tmp/ae; then
    echo "PERCHAT VALIDATES (applies on top of global)"
  else
    echo "!! PERCHAT FAILED VALIDATION: $(cat /tmp/ae)" >&2
  fi
  git checkout HEAD -- src-tauri src 2>/dev/null
  git clean -fd src-tauri src >/dev/null 2>&1
  echo "native fully restored"

else
  echo "unknown mode: $MODE (use base|capture)" >&2; exit 1
fi
