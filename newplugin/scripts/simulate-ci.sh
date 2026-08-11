#!/usr/bin/env bash
# Simulate the CI patch-apply phase exactly as codeg-portable-win64-custom.yml does.
#
# Base-selection semantics are IDENTICAL to CI: read newplugin/BASE (the single
# source of truth), verify the pinned SHA, materialize the COMPLETE upstream
# tree at that SHA in a DISPOSABLE worktree, restore only the plugin-dev custom
# layer (newplugin/ + the custom workflows), then apply the 104 patches in the
# exact CI order. The canonical plugin-dev checkout is never modified.
#
# Groups (identical to CI): 1 = all *.patch NOT matching accept|launch|customtab
#         2 = *.accept.patch   3 = *.launch.patch   4 = *.customtab.patch
# Within a group, applied in alphabetical order and accumulated into the tree.
# Aborts loudly on the first failure (mirrors the hardened CI loop).
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

# ---- Base selection (must match the CI 'Reconstruct engine' step) ----
BASE_FILE="newplugin/BASE"
if [ ! -f "$BASE_FILE" ]; then
  echo "!! missing $BASE_FILE (cannot select upstream base)" >&2
  exit 1
fi
UPSTREAM_URL="$(sed -n 's/^upstream=//p' "$BASE_FILE")"
BASE_REF="$(sed -n 's/^ref=//p' "$BASE_FILE")"
BASE_SHA="$(sed -n 's/^sha=//p' "$BASE_FILE")"
if [ -z "$UPSTREAM_URL" ] || [ -z "$BASE_REF" ] || [ -z "$BASE_SHA" ]; then
  echo "!! newplugin/BASE incomplete (need upstream=, ref=, sha=)" >&2
  exit 1
fi

# Capture the exact plugin-dev commit (never depend on a moving branch name).
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

# ---- Disposable reconstruction worktree ----
WORKTREE_ROOT="$(mktemp -d)"
WORKTREE="$WORKTREE_ROOT/replay"
git worktree add --detach "$WORKTREE" "$BASE_SHA" >/dev/null
cleanup() {
  cd "$REPO_ROOT" 2>/dev/null || true
  git worktree remove --force "$WORKTREE" >/dev/null 2>&1 || true
  rmdir "$WORKTREE_ROOT" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Restore ONLY the CI-required plugin-dev custom layer from the captured SHA.
git -C "$WORKTREE" checkout "$PLUGIN_SHA" -- newplugin/
git -C "$WORKTREE" checkout "$PLUGIN_SHA" -- \
  .github/workflows/codeg-portable-win64-custom.yml \
  .github/workflows/test-patched.yml

cd "$WORKTREE"
PATCH_DIR="newplugin/patches"

shopt -s nullglob
fail=0
total=0
for step in 1 2 3 4; do
  case $step in
    1) pattern='*.patch';           exclude=1 ;;
    2) pattern='*.accept.patch';    exclude=0 ;;
    3) pattern='*.launch.patch';    exclude=0 ;;
    4) pattern='*.customtab.patch'; exclude=0 ;;
  esac
  files=( "$PATCH_DIR"/$pattern )
  if [ "$exclude" -eq 1 ]; then
    kept=()
    for f in "${files[@]:-}"; do
      [ -z "$f" ] && continue
      case "$(basename "$f")" in
        *.accept.patch|*.launch.patch|*.customtab.patch) ;;
        *) kept+=("$f") ;;
      esac
    done
    files=("${kept[@]:-}")
  fi
  if [ "${#files[@]}" -eq 0 ]; then
    echo "--- group $step (0 patches) ---"
    continue
  fi
  # Alphabetical order within the group (POSIX-safe, no mapfile).
  IFS=$'\n' sorted=($(printf '%s\n' "${files[@]}" | sort))
  unset IFS
  total=$((total + ${#sorted[@]}))
  echo "--- group $step (${#sorted[@]} patches) ---"
  for f in "${sorted[@]}"; do
    echo "  applying $(basename "$f")"
    if ! git apply "$f" 2>/tmp/ae; then
      echo "  !! FAILED: $(basename "$f"): $(cat /tmp/ae)" >&2
      fail=1
      break 2
    fi
  done
done

if [ "$fail" -eq 0 ]; then
  echo "=== ALL $total PATCHES APPLIED CLEAN (CI patch phase would be GREEN) ==="
else
  echo "=== APPLY ABORTED - fix the failing patch, then re-run ===" >&2
fi
exit $fail
