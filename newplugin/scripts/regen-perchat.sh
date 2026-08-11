#!/usr/bin/env bash
# Regenerate a *.perchat.patch as a clean delta on top of its global *.patch base.
# A perchat patch is a DELTA that must apply AFTER its global *.patch (CI sorts
# .patch < .perchat.patch and accumulates into the working tree).
#
# Base-selection semantics (2026-08-12): the canonical plugin-dev native
# src/ src-tauri/ trees are NOT the patch target anymore. The single source of
# truth is newplugin/BASE (pinned upstream SHA). So instead of applying patches
# to the canonical checkout, this script reconstructs the COMPLETE upstream tree
# at the pinned SHA in a DISPOSABLE worktree, applies/stages the global base
# there, and lets you make the per-chat edits inside that worktree. The capture
# step then records your UNSTAGED edits and cleans the worktree up. The
# canonical plugin-dev checkout is NEVER modified by this script.
#
# Workflow:
#   1) regen-perchat.sh base   <file.perchat.patch>
#        -> reconstructs upstream base in a disposable worktree, applies +
#           stages the global base there; you then make the per-chat edits
#           UNSTAGED inside the worktree (do NOT `git add` them).
#   2) regen-perchat.sh capture <file.perchat.patch>
#        -> captures your UNSTAGED working-vs-index diff into the perchat patch
#           (written to the canonical checkout), validates it applies on top of
#           the global base, and removes the disposable worktree.
#   3) regen-perchat.sh abort   <file.perchat.patch>
#        -> discards the disposable worktree + state without capturing.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT" || exit 1

MODE="${1:-}"
PERCHAT="${2:-}"
[ -z "$MODE" ] && { echo "usage: $0 <base|capture|abort> <file.perchat.patch>" >&2; exit 1; }
[ -z "$PERCHAT" ] && { echo "usage: $0 <base|capture|abort> <file.perchat.patch>" >&2; exit 1; }
case "$PERCHAT" in *.perchat.patch) ;; *) echo "not a .perchat.patch: $PERCHAT" >&2; exit 1;; esac

# Normalize to absolute paths so `git -C "$WORKTREE"` resolves them against the
# repo root, never against the disposable worktree's relative layout.
case "$PERCHAT" in
  /*|[A-Za-z]:/*|[A-Za-z]:\\*) ;;                 # already absolute
  *) PERCHAT="$(pwd)/$PERCHAT" ;;
esac

GLOBAL="${PERCHAT%.perchat.patch}.patch"
[ -f "$GLOBAL" ] || { echo "global base not found: $GLOBAL" >&2; exit 1; }

# State file so the disposable worktree survives between base -> capture runs.
CTX="$REPO_ROOT/.git/regen-perchat.ctx"

# ---- Base selection (must match the CI 'Reconstruct engine' step) ----
BASE_FILE="newplugin/BASE"
[ -f "$BASE_FILE" ] || { echo "!! missing $BASE_FILE (cannot select upstream base)" >&2; exit 1; }
UPSTREAM_URL="$(sed -n 's/^upstream=//p' "$BASE_FILE")"
BASE_REF="$(sed -n 's/^ref=//p' "$BASE_FILE")"
BASE_SHA="$(sed -n 's/^sha=//p' "$BASE_FILE")"
if [ -z "$UPSTREAM_URL" ] || [ -z "$BASE_REF" ] || [ -z "$BASE_SHA" ]; then
  echo "!! newplugin/BASE incomplete (need upstream=, ref=, sha=)" >&2
  exit 1
fi

# Files the global base touches (excludes /dev/null deletion markers).
GLOBAL_FILES="$(git apply --numstat "$GLOBAL" 2>/dev/null | awk '{print $3}' | grep -v '^/')"

base_mode() {
  # Sanity: the canonical checkout should be clean (never modify it here).
  if [ -n "$(git status --porcelain src src-tauri)" ]; then
    echo "!! Refusing: canonical src/ or src-tauri/ has uncommitted changes. Commit or stash first." >&2
    exit 1
  fi
  if [ -f "$CTX" ]; then
    echo "!! A regen session is already active ($CTX). Run capture/abort first." >&2
    exit 1
  fi

  PLUGIN_SHA="$(git rev-parse HEAD)"
  echo "plugin-dev captured at: $PLUGIN_SHA"

  # Fetch the pinned upstream tag and verify the immutable SHA.
  git fetch "$UPSTREAM_URL" "refs/tags/${BASE_REF}:refs/tags/${BASE_REF}"
  RESOLVED="$(git rev-parse "refs/tags/$BASE_REF")"
  if [ "$RESOLVED" != "$BASE_SHA" ]; then
    echo "!! BASE SHA mismatch: pinned $BASE_SHA != resolved $RESOLVED" >&2
    exit 1
  fi
  echo "base SHA verified: $RESOLVED"

  WORKTREE_ROOT="$(mktemp -d)"
  WORKTREE="$WORKTREE_ROOT/replay"
  git worktree add --detach "$WORKTREE" "$BASE_SHA" >/dev/null
  # Note: do NOT restore newplugin/ into the worktree. Patch files are referenced
  # by absolute path below, so the worktree only ever contains the upstream base
  # + the global base patch. This keeps the staged set exactly equal to the files
  # the global base touches (capture verifies this invariant).

  git -C "$WORKTREE" apply "$GLOBAL" || { echo "!! global base failed to apply" >&2; exit 1; }
  # Stage ONLY the files the global base touched (inside the worktree).
  echo "$GLOBAL_FILES" | grep -v '^$' | xargs -r git -C "$WORKTREE" add || true

  printf 'PERCHAT_FILE=%s\nGLOBAL_FILE=%s\nWORKTREE=%s\n' "$PERCHAT" "$GLOBAL" "$WORKTREE" > "$CTX"
  echo "upstream base ($BASE_REF) + global base applied and staged in:"
  echo "  $WORKTREE"
  echo "make your per-chat edits UNSTAGED in the files under that worktree,"
  echo "then run: $0 capture $PERCHAT"
}

capture_mode() {
  [ -f "$CTX" ] || { echo "!! no active regen session (run '$0 base' first)" >&2; exit 1; }
  # shellcheck disable=SC1090
  source "$CTX"
  [ "$PERCHAT" = "$PERCHAT_FILE" ] || {
    echo "!! active session is for $PERCHAT_FILE, not $PERCHAT" >&2; exit 1; }
  [ -d "$WORKTREE" ] || { echo "!! worktree $WORKTREE is gone" >&2; rm -f "$CTX"; exit 1; }

  # The index must still contain EXACTLY the global base. If you staged your
  # per-chat edits, the diff below would silently miss them — catch it here.
  STAGED="$(git -C "$WORKTREE" diff --cached --name-only | sort)"
  EXPECTED="$(echo "$GLOBAL_FILES" | grep -v '^$' | sort)"
  if [ "$STAGED" != "$EXPECTED" ]; then
    echo "!! Index does not match the global base — your edits may have been staged." >&2
    echo "   Expected staged: $(echo "$EXPECTED" | tr '\n' ' ')" >&2
    echo "   Actual staged:   $(echo "$STAGED" | tr '\n' ' ')" >&2
    echo "   Fix: run 'abort', then 'base' again on a clean tree, make UNSTAGED edits, then capture." >&2
    exit 1
  fi

  # Capture the unstaged working-vs-index diff (your per-chat edits).
  git -C "$WORKTREE" --no-pager diff > "$PERCHAT"
  echo "captured delta -> $PERCHAT ($(wc -l < "$PERCHAT") lines)"

  # Validate the perchat delta applies on top of the global base (same stack as
  # CI: upstream base + global + perchat). Discard your edits first so the check
  # runs against the pristine base+global state.
  git -C "$WORKTREE" checkout -- src src-tauri 2>/dev/null || true
  if git -C "$WORKTREE" apply --check "$PERCHAT" 2>/tmp/ae; then
    echo "PERCHAT VALIDATES (applies on top of global base)"
  else
    echo "!! PERCHAT FAILED VALIDATION: $(cat /tmp/ae)" >&2
  fi

  # Remove the disposable worktree and state.
  (cd "$REPO_ROOT" && git worktree remove --force "$WORKTREE" >/dev/null 2>&1 || true)
  rmdir "$(dirname "$WORKTREE")" >/dev/null 2>&1 || true
  rm -f "$CTX"
  echo "disposable worktree removed; canonical checkout untouched"
}

abort_mode() {
  [ -f "$CTX" ] || { echo "no active regen session" >&2; exit 0; }
  # shellcheck disable=SC1090
  source "$CTX"
  [ -d "$WORKTREE" ] && (cd "$REPO_ROOT" && git worktree remove --force "$WORKTREE" >/dev/null 2>&1 || true)
  rmdir "$(dirname "$WORKTREE")" >/dev/null 2>&1 || true
  rm -f "$CTX"
  echo "aborted; disposable worktree removed; canonical checkout untouched"
}

case "$MODE" in
  base)    base_mode ;;
  capture) capture_mode ;;
  abort)   abort_mode ;;
  *) echo "unknown mode: $MODE (use base|capture|abort)" >&2; exit 1 ;;
esac
