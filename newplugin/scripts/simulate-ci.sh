#!/usr/bin/env bash
# Simulate the CI patch-apply phase exactly as codeg-portable-win64-custom.yml does.
# Groups: 1 = all *.patch NOT matching accept|launch|customtab
#         2 = *.accept.patch   3 = *.launch.patch   4 = *.customtab.patch
# Within a group, applied in alphabetical order and accumulated into the working tree.
# Aborts loudly on the first failure (mirrors the hardened CI loop).
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"
# Relative PATCH_DIR: resilient to sandbox path remapping where `git apply`
# cannot open patches addressed by absolute path (behaves identically in CI,
# which runs from the repo root after the cd above).
PATCH_DIR="newplugin/patches"

cleanup() {
  git checkout HEAD -- src-tauri src 2>/dev/null
  git clean -fd src-tauri src >/dev/null 2>&1
}
# Always leave the native tree restored, whatever the exit path.
trap cleanup EXIT

# Pre-flight: never apply on a dirty tree (would cause false failures / corruption).
if [ -n "$(git status --porcelain src src-tauri)" ]; then
  echo "!! Refusing: src/ or src-tauri/ has uncommitted changes. Commit or stash first." >&2
  exit 1
fi

shopt -s nullglob
fail=0
for step in 1 2 3 4; do
  case $step in
    1) pattern='*.patch';         exclude=1 ;;
    2) pattern='*.accept.patch';   exclude=0 ;;
    3) pattern='*.launch.patch';   exclude=0 ;;
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
  mapfile -t sorted < <(printf '%s\n' "${files[@]}" | sort)
  echo "--- group $step (${#sorted[@]} patches) ---"
  for f in "${sorted[@]}"; do
    echo "  applying $(basename "$f")"
    if ! git apply "$f" 2>/tmp/ae; then
      echo "  !! FAILED: $(basename "$f"): $(cat /tmp/ae)" >&2
      fail=1; break 2
    fi
  done
done

if [ "$fail" -eq 0 ]; then
  echo "=== ALL PATCHES APPLIED CLEAN (CI patch phase would be GREEN) ==="
else
  echo "=== APPLY ABORTED — fix the failing patch, then re-run ===" >&2
fi
exit $fail
