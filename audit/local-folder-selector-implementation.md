# Local Folder → Native Codeg Folder Selector — Implementation

**Date:** 2026-08-07
**Branch:** `plugin-dev` (committed here only)
**Principle:** Extend Codeg without modifying native files. All changes ship as apply-on-demand patches under `newplugin/patches/`.

## Decision recap (Option A vs B)

| Dimension | **Option A — export `FolderPicker` + reuse** (CHOSEN) | Option B — move to shared component |
|---|---|---|
| LOC changed | 1-line `export` + small `hideChatMode` guard on native `FolderPicker` | new shared file + 1 patch deleting from source + 2+ patches re-pointing importers |
| Files touched | 1 new patch (`conversation-context-bar.tsx.patch`) | 1 new file + 3+ patches |
| Circular-dep risk | None — `FolderPicker` already lives in `conversation-context-bar.tsx`, an unchanged module graph | Real risk: re-exporting from a patched shared module can break the two in-file consumers (`ConversationHeaderFolderPicker`, `ConversationFolderBranchPicker`) that expect it in scope |
| Import complexity | 1 new import in `automation-editor.tsx` | rewires 3+ import sites |
| Upstream-merge impact | Zero drift — only adds `export` + an optional prop default; existing call sites unchanged | adds a new file the upstream doesn't have |
| Maintainability | Identical to upstream (`FolderPicker` stays the single source) | forks the component, doubles future upstream-sync cost |

Rule from spec: *"If extraction requires more than a small mechanical refactor, choose Option A."* Option A is a 1-line `export` — a small mechanical change — so **Option A wins** and avoids over-engineering.

## How `FolderPicker` is reused

`FolderPicker` (native, `src/components/chat/conversation-context-bar.tsx:410`, now exported) is a generic, controlled, searchable `cmdk`/`Popover` dropdown. We reuse it **verbatim** for the local-folder target:

- `folders={projectFolders}` — `projectFolders = folders.filter(f => f.parent_id == null && f.kind === "regular")` already exists in `automation-editor.tsx` and is exactly the "FolderKind::Regular, top-level" set the spec asks for (chat folders have `kind: "chat"`, so they're excluded).
- `currentFolderId` / `currentFolderName` — resolved from the saved `local_folder_path` via a small memo (`localFolderDisplayName`); an unknown/external path resolves to `null` and the picker shows the raw path leaf.
- `onSelect(id)` → look up `id` in `folders` → `setLocalFolderPath(folder.path)`. Data model (`config.local_folder_path`, a string) is unchanged.
- `hideChatMode` — a new optional prop (default `false`) that suppresses the pinned "chat mode" (folderless) entry, so the local-folder picker shows **only** real folders (satisfies "showing only FolderKind::Regular folders").

The `+ Add Folder…` action reuses the native Add Folder flow via `WorkspaceFolderDialog` (`src/components/layout/workspace-folder-dialog.tsx`), controlled by `open`/`onOpenChange`/`onFolderOpened`. On `onFolderOpened` we auto-select the new folder (`setLocalFolderPath(f.path)`); it then appears in the `FolderPicker` list on next render.

## Deliverables

### 1. Files changed
- **New patch:** `newplugin/patches/src-components-chat-conversation-context-bar.tsx.patch` (group 1 — plain `.patch`)
- **Modified patch:** `newplugin/patches/src-components-automations-automation-editor.tsx.launch.patch` (group 3 — `.launch.patch`)
- **Modified patches:** all 10 `newplugin/patches/src-i18n-messages-<locale>.json.launch.patch` (added 2 keys each)
- **No native source files modified** — `src/` and `src-tauri/src/` remain pristine `origin/main`.

### 2. Native components reused
- `FolderPicker` (now exported) — the registry-backed searchable folder selector.
- `WorkspaceFolderDialog` — the native Add Folder entry point (with `onFolderOpened`).
- `useAppWorkspaceStore` `folders` / `projectFolders` — already the source of truth for the Folder Registry.

### 3. Custom code removed
- The text `<Input>` + `[Browse…]` (`FolderOpen`) block for `local_folder` in `automation-editor.tsx`.
- `browseLocalFolder` helper (used `openFileDialog`).
- `import { openFileDialog } from "@/lib/platform"` (now unused after removal).
- `FolderOpen` lucide import → replaced by `Plus` for the Add Folder button.
- `localFolderBrowse` i18n key is now unused (kept in locale files to avoid touching other consumers; harmless dead key).

### 4. LOC added / removed
- `conversation-context-bar.tsx.patch`: +export, +`hideChatMode` prop (interface + destructure default) + conditional wrap of the chat-mode block. Functionally ~+7 lines; the patch diff shows +26/−20 because the JSX indent of the wrapped block is rewritten.
- `automation-editor.tsx.launch.patch`: my delta ≈ **+10 / −35** (replaced ~20-line Input+Browse block + `browseLocalFolder` (~13 lines) with ~25 lines of `FolderPicker` + `Add Folder` + `WorkspaceFolderDialog` + state/memo). The file as committed is the full regenerated launch-feature patch.
- Locale patches: **+2 keys each** (`addFolder`, `localFolderEmpty`) × 10 locales = +20 translated strings.
- Net: small, surgical change. No new source files.

### 5. Backward compatibility
- **Data model unchanged:** `config.local_folder_path` is still a free-form path string. Existing automations with a saved local path continue to work; the picker highlights the matching registry folder when one exists, otherwise shows the raw path leaf ("Unknown Folder handling").
- `FolderPicker`'s existing call sites (`ConversationHeaderFolderPicker`, `ConversationFolderBranchPicker`) are unaffected — `hideChatMode` defaults to `false`, so their chat-mode entry still renders.
- Launch execution, engines, Folder Registry, Sidebar, Git Workspace, and runtime are untouched.

### 6. Validation
- Every generated patch passes `git apply --check` against the pristine tree (verified for the export patch, the regenerated editor patch, and all 10 locale patches).
- Locale JSON re-validated (`json.loads`) after key insertion.
- **Manual check (recommended before merge):** `pnpm build` in CI (the `codeg-portable-win64-custom` workflow) applies all patch groups in order and builds; the local-folder target in a launch_session automation should render the `FolderPicker` + `Add Folder…` instead of the text input.

### 7. Regression risks
- **Patch ordering (critical):** the export patch is a plain `.patch` → applied in CI **group 1 (auto-approve)**, *before* the editor's `.launch.patch` (group 3). If renamed to `.launch.patch` it would sort after `automation-editor…launch.patch` alphabetically and `FolderPicker` would not yet be exported → build break. Keep the plain `.patch` name.
- **Unused imports:** `Input` is retained (still used by another field at line ~795); only `openFileDialog`/`FolderOpen` were removed. `noUnusedLocals` is satisfied.
- **i18n:** new keys added to all 10 locales (next-intl `errorOnMissingMessages` is not enabled, but keys are provided for consistency with the existing launch-patch set).
- **Rust/engine:** no Rust or engine changes; the `shared_in_root` isolation for `isLocal` is preserved from the prior launch-target work.

## Task Editor — no change required
`src/components/tasks/task-editor-dialog.tsx` was grepped for `local_folder | LocalFolder | browseLocalFolder | localFolderPath | targetKind | isLocalFolder` → **zero matches**. The Task Editor has **no Local Folder UI at all** (the feature lives only in the Automation Editor). Adding one there would require touching the Task Engine (forbidden by the extension rules), so **no change is made**. This is documented as an explicit scope boundary, not an omission.

## Scope guard (unchanged from spec)
Kept strictly out of scope: launch execution, engines, Folder Registry internals, Sidebar, Git Workspace, runtime. Only the Local Folder *selector UI* in the Automation Editor was swapped.
