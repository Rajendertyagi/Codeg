# PATCH GENERATION & RECONSTRUCTION PROTOCOL (Codeg / plugin-dev)

Repository-specific protocol for the Codeg custom platform. This document governs every
action that creates, regenerates, modifies, deletes, validates, or applies plugin patches.
It is **mandatory reading** before any such action (see `agent.md`).

The protocol below was independently verified by a full reconstruction replay on
**2026-08-09**, and re-verified against the pinned **v0.24.0** base on **2026-08-12**
(104/104 patches apply clean in CI order; 58-path changed-file union). It must be treated
as the single source of truth for patch ordering and generation. Do not introduce a second
patch-order source of truth.

---

## 1. Repository model (verified facts)

- **Base selection — `newplugin/BASE` is the single source of truth.** It pins the exact
  upstream commit the archive is re-anchored against:

      upstream=https://github.com/xintaofei/codeg.git
      ref=v0.24.0
      sha=df7a872de44546277e4c49cfe9d173c631161dc6

  Every reconstruction (CI workflows, `simulate-ci.sh`, `regen-perchat.sh`) reads this
  file, fetches the pinned tag from `upstream=`, verifies it resolves to the immutable
  `sha=`, then materializes the **complete** upstream tree at that SHA. **Never** use
  `origin/main` or the plugin-dev native trees as the patch base — they are drift-prone and
  are NOT the patch target. To move the base, update all three fields in `newplugin/BASE`
  together and re-verify the full replay (§5) — this is the only allowed base change.
- **Working branch:** `plugin-dev` (all custom work happens here).
- **Canonical native trees are NOT the patch target:** `src/` and `src-tauri/src/` on
  `plugin-dev` predate v0.24.0 and are not byte-identical to the pinned base. The patch
  target is always the reconstructed upstream tree from `newplugin/BASE`, never these
  canonical trees.
- **All custom features live ONLY under `newplugin/`:**
  - `newplugin/BASE` — pinned upstream base record (single source of truth).
  - `newplugin/patches/` — apply-on-demand raw git diff patches (engine + frontend).
  - `newplugin/hooks/`, `newplugin/backend/`, `newplugin/frontend/` — out-of-tree custom code.
- **Patch archive:** currently **104 tracked patches** under `newplugin/patches/`.
- **Feature-family inventory (by filename suffix):**

  | Family     | Suffix            | Count |
  |------------|-------------------|-------|
  | channelmsg | `.channelmsg.patch` | 29  |
  | launch     | `.launch.patch`     | 21  |
  | accept     | `.accept.patch`     | 16  |
  | customtab  | `.customtab.patch`  | 13  |
  | perchat    | `.perchat.patch`    | 6   |
  | plain      | `.patch` (no suffix) | 19  |
  | **Total**  |                   | **104** |

- **Hard rule:** a given feature is maintained **either** as patch files **or** as direct
  engine changes — **never both simultaneously**. `plugin-dev` must contain no direct
  engine edits for any feature that also has patches.

---

## 2. Authoritative patch application order (CI)

The CI workflow is the **authoritative ordering**:

    .github/workflows/codeg-portable-win64-custom.yml

Both custom workflows (`codeg-portable-win64-custom.yml`, `test-patched.yml`) first run the
**"Reconstruct engine from pinned upstream base (newplugin/BASE)"** step: they capture the
plugin-dev HEAD SHA *before* detaching, read `newplugin/BASE`, verify the pinned SHA, then
`git checkout --detach` the complete upstream tree and restore only the plugin-dev custom
layer CI needs (`newplugin/` + the two custom workflow files). Patches are then applied on
top of that reconstructed base.

Step "Apply custom feature patches" defines four groups applied in dependency order,
**alphabetically by filename within each group** (`Sort-Object Name`):

| Group | Selector                                                    | Count |
|-------|-------------------------------------------------------------|-------|
| 1     | `*.patch` NOT matching `\.(accept\|launch\|customtab)\.patch$` (plain + perchat + channelmsg) | 54 |
| 2     | `*.accept.patch`                                            | 16 |
| 3     | `*.launch.patch`                                            | 21 |
| 4     | `*.customtab.patch`                                         | 13 |

- Groups accumulate into the working tree in order (Group 1 first, Group 4 last).
- Patches may touch the same target file across families; correctness depends on this
  exact order. **Never reorder, and never apply a single group in isolation** and treat it
  as a complete feature.
- Sum check: 54 + 16 + 21 + 13 = **104**.
- `newplugin/scripts/simulate-ci.sh` mirrors this ordering (identical results verified
  position-by-position for all 104 patches). It uses the same BASE mechanism: it reads
  `newplugin/BASE`, verifies the pinned SHA, reconstructs the complete upstream tree in a
  **disposable worktree**, restores the plugin-dev custom layer, and applies all 104
  patches in CI order. It is a local **checking aid only**; the CI workflow remains the
  source of truth. Known benign difference: CI **throws** on a group with 0 matches, the
  simulator **skips** it (report it, do not "fix" it).
- **Never introduce a second patch-order source of truth** (e.g., an `apply-order.json`).

---

## 3. Patch format & encoding (byte-safe)

- Patches are **raw `git diff` output** (unified diff with `index` lines, `---`/`+++`,
  `@@` hunks, `new file mode` / `--- /dev/null` for new files).
- They are applied with `git apply` (plain; the CI step uses `git apply <file>`).
- **Encoding:** UTF-8, **LF** line endings, **no BOM**.
- **Generation must be Git-native / byte-safe.** Never pipe patch content through a
  PowerShell text pipeline (`Out-File`, `Set-Content`, `[System.IO.File]::WriteAllText`,
  `ConvertFrom-String`, etc.) — those rewrite line endings / encoding / BOM and corrupt
  the patch. Generate with `git diff` redirected directly to a file, or captured via
  `git diff > <file>` from Git Bash.
- **No custom headers inside raw `.patch` files.** No comment prefixes, no feature tags,
  no front-matter in the patch body. (Feature identity is carried by the **filename**
  suffix, e.g. `.channelmsg.patch`.)
- Before accepting a patch: validate with:
  - `git apply --check --whitespace=error <patch>` (must exit 0).
  - New files must appear as `new file mode 100644` with `--- /dev/null`.

---

## 4. Generation workflow (producing or updating a patch)

1. **Start from a clean, pinned base.** Read `newplugin/BASE` (the single source of truth),
   fetch the pinned tag from `upstream=`, and verify the resolved SHA equals `sha=`. Use
   that SHA as the base — never a drift-prone local state, never `origin/main`, never the
   canonical plugin-dev native trees.
2. **Use an isolated feature worktree.** Create a disposable worktree from the pinned base;
   never generate patches from an unclean or half-patched `plugin-dev` checkout:
   `git worktree add --detach <tmp>/work <base-sha>`.
3. **Apply the existing archive first** (exact CI order, §2) so your new feature builds on
   the real accumulated tree.
4. Make the feature change in the worktree **only**; generate the patch with Git-native
   `git diff` (byte-safe, §3).
5. Name the file with the correct family suffix and place it in `newplugin/patches/`.
6. **Validate before accepting:** `git apply --check --whitespace=error` against the
   accumulated tree.
7. **Reconstruct the COMPLETE feature from pristine base** (see §5) before accepting the
   new patch. The reconstructed tree must equal the intended feature tree.
8. **Never blindly regenerate unrelated patches.** Regenerate a patch only when its
   upstream context legitimately changed; verify you are not rewriting patches owned by
   other features. Maintain patch ownership/inventory (count + families must stay
   consistent).

---

## 5. Reconstruction verification (acceptance gate)

Before accepting any patch set (new feature or update), run the full replay:

1. Read `newplugin/BASE`, fetch/verify the pinned SHA, and `git worktree add --detach
   <tmp>/replay <base-sha>` (clean, disposable; same base-selection as CI §2).
2. Apply **all** 104 patches (or the full archive) in the exact CI order (§2) from the
   worktree root, using the canonical `newplugin/patches/` as the patch source.
3. Every patch must apply cleanly (`git apply` exit 0 each); **no failures, no
   `--whitespace=nowarn` masking**.
4. Verify the reconstructed changed-file set equals the union of files touched by the
   patches (`git apply --numstat` per patch vs `git status --porcelain`) — **58 paths** in
   the verified archive.
5. Verify **no unexpected files changed** — every changed path must be inside `src/` or
   `src-tauri/`; nothing else (no `.github/`, no docs, no unrelated files).
6. Verify the reconstructed tree equals the **intended feature tree** (the feature built
   in the isolated worktree). Compare trees; must be byte-identical.
7. Verify patch count and file inventory unchanged: 104 total, channelmsg 29 / launch 21 /
   accept 16 / customtab 13 / perchat 6 / plain 19 (or the correct numbers for the current
   archive).
8. Verify the canonical `plugin-dev` tree remains **completely clean** after the test
   (`git status --short` empty) and that **no patch file was modified** (byte/content
   unchanged — hash before and after).
9. Use **disposable worktrees** for any destructive validation (reconstruction, `git
   clean`, apply tests). Never run such validation directly on the canonical checkout.

---

## 6. Failure conditions — STOP and report (do NOT auto-repair)

If any of the following occurs, **stop immediately, make no further changes, and report
the exact failure** with evidence. Do not attempt random fixes, do not regenerate patches
to "make it pass," and do not modify the CI workflow or any existing patch.

- Any patch fails `git apply` or `git apply --check` (including `--whitespace=error`
  failures).
- The reconstructed changed-file set does **not** match the union of patch-touched paths,
  or any file outside `src/` + `src-tauri/` changed.
- The reconstructed tree does **not** equal the intended feature tree.
- The patch count or family inventory changed unexpectedly (e.g., a patch missing or
  duplicated).
- The canonical `plugin-dev` tree is dirty after validation, or any patch file content
  changed.
- CI ordering vs the local replay ordering diverges.
- A feature exists **both** as direct engine changes and as patch files (dual
  maintenance).
- Any patch contains non-raw content (custom headers, BOM, CRLF corruption, text-pipeline
  artifacts).

When stopped, report: which check failed, the exact command output, and the files
involved. Wait for direction before acting.

---

## 7. Quick Checklist (run before committing any patch)

- [ ] Read this protocol (mandatory).
- [ ] Base selected from `newplugin/BASE` (single source of truth): `upstream=` fetched,
      `ref=` tag resolves to `sha=`; base SHA used for every reconstruction.
- [ ] Patch generated Git-native (raw `git diff`), UTF-8 / LF / no BOM, no custom headers.
- [ ] `git apply --check --whitespace=error` passes.
- [ ] No unrelated patches regenerated; ownership/inventory intact.
- [ ] Full CI-order replay (groups 1→4, alphabetical within group) passes on a disposable
      worktree reconstructed from the `newplugin/BASE` SHA.
- [ ] Reconstructed tree equals intended feature tree; no files changed outside
      `src/` + `src-tauri/`.
- [ ] Patch count + family inventory verified (104 = 29 + 21 + 16 + 13 + 6 + 19 for the
      current archive).
- [ ] Canonical `plugin-dev` clean; no patch files modified; no `newplugin/BASE` fields
      changed without re-verifying the full replay.
- [ ] No second patch-order source of truth created (no `apply-order.json`).
- [ ] No feature maintained as both direct engine edits and patches.
