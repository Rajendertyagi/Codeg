# Audit — Local Folder Selector Reuse Gate (Pre-Implementation Phase)

**Date:** 2026-08-07
**Branch:** `plugin-dev`
**Status:** Investigation only — no code written.
**Objective:** Per the enhancement spec, before creating ANY new UI component, prove
whether Codeg already has a reusable folder selector. This document answers the
mandated pre-implementation gate using repository evidence only.
**Evidence basis:** Grep/Read **plus live `codebase-memory` (via `mcpproxy`) queries**
run 2026-08-07 — both agree.

---

## Gate Questions

### Q1. Does Codeg already have a reusable folder selector?
**YES.**

### Q2. If YES

**Where:** `FolderPicker` — `src/components/chat/conversation-context-bar.tsx:410–551`.
It is currently **module-private** (not `export`ed).

**Why it can be reused (repository evidence):**

- Generic, controlled component. Props:
  `folders: { id: number; name: string; path: string; alias?: string | null }[]`,
  `currentFolderId`, `currentFolderName`, `onSelect(folderId)`, plus search/empty labels.
  Not hardcoded to any one surface.
- **Already registry-backed (single source of truth):** every caller derives the list
  via `excludeChatFolders(filterTopLevelFolders(folders))` from
  `useAppWorkspaceStore((s) => s.folders)`
  (`conversation-context-bar.tsx:122–144`, `247–271`). No custom cache, no second list,
  no separate search system.
- **Already filters `FolderKind::Chat` out** (`excludeChatFolders`) and shows only
  top-level (Regular) folders (`filterTopLevelFolders`) → satisfies the spec's
  "only `FolderKind::Regular`; chat folders never appear" rule with zero new logic.
- **Searchable:** cmdk `Command` + `CommandInput` (`conversation-context-bar.tsx:486–547`);
  renders folder name + path, check-mark on current.
- `onSelect` emits a `folderId`; the caller resolves `id → .path`
  (`folders.find(f => f.id === id).path`). This is exactly the spec's save flow:
  *selected `FolderDetail` → `.path` → `config.local_folder_path`*.
- The native **`+ Add Folder…`** flow already exists: `WorkspaceFolderDialog`
  (`src/components/layout/workspace-folder-dialog.tsx:97` — documented as "the single
  entry point for adding a workspace folder"), opened by `NewFolderDropdown`
  (`new-folder-dropdown.tsx:36–54`), and it exposes an `onFolderOpened(folder)` callback
  ideal for auto-selecting the freshly added folder.

**Minimal changes required (all via patches — no engine/native-file edits):**

1. **Export `FolderPicker`** — a 1-line patch to `conversation-context-bar.tsx`.
   That file is **not** in the do-not-modify list.
2. **Automation editor patch** (`src-components-automations-automation-editor.tsx.launch.patch`):
   replace the `<Input> + [Browse…]` block (the `targetKind === "local_folder"` branch,
   ~lines 390–417) with a registry-backed `<FolderPicker
   folders={registryFolders} currentFolderId={resolvedId}
   onSelect={(id) => setLocalFolderPath(folders.find(f => f.id === id)?.path ?? "")} />`
   plus a trailing **`+ Add Folder…`** item that opens `WorkspaceFolderDialog` and
   auto-selects via `onFolderOpened`.
3. **Task editor patch:** extend the same way — *after* confirming where the Local
   Folder control currently lives (see Known Gaps).
4. **Pre-select on edit:** resolve `local_folder_path` → matching registry folder `id`
   (set `currentFolderId`); if no registry folder matches, show an **"Unknown Folder"**
   placeholder and allow re-pick / `+ Add Folder…`. No silent path rewrite.

### Q3. If NO
Not applicable. Repository evidence proves a reusable selector exists, so a new
`FolderPicker` component is **NOT justified** (burden of proof not met).

---

## Reuse-priority mapping (spec §"Reuse Priority")

1. ✅ **Existing Codeg folder selector** → `FolderPicker`
2. (n/a — #1 already fits)
3. ✅ **Existing Codeg folder dialog** → `WorkspaceFolderDialog` (for `+ Add Folder…`)
4. Thin wrapper around an existing component → not needed (export directly)

---

## Backward compatibility strategy

- Keep `config.local_folder_path` as the stored field (already hydrated in the patch:
  `automation?.config?.local_folder_path ?? ""`).
- `FolderPicker` emits a `folderId`; the caller resolves it to `.path` at save time.
  Existing automations load and pre-select correctly.
- Unknown / missing folder → "Unknown Folder" fallback, user-editable; stored path
  never silently changed.

---

## Known Gaps / Open Items

- **Task Editor Local Folder UI location unconfirmed:** `src-components-tasks-task-editor-dialog.tsx.launch.patch`
  (read in full) adds only the **Existing-Conversation** picker — no `text + Browse`
  Local Folder block was found in it. Must confirm whether the Task Editor renders a
  Local Folder control elsewhere (or needs one added) so both editors truly share the
  experience.

---

## MCP corroboration (2026-08-07, live `codebase-memory` via `mcpproxy`)

The connector panel shows the servers as "disconnected," but `mcpproxy` is actively
routing to them — `retrieve_tools` returned live tools from `qartez`, `codebase-memory`,
and `icm`. Direct `search_graph` queries on project `D-Temp-Codeg` confirmed every
pillar of the gate answer against the live knowledge graph:

- **`FolderPicker` exists as an indexed symbol:** `FolderPickerProps` (Interface,
  `conversation-context-bar.tsx:385–408`) and the `FolderPicker` component body
  (consumed by `ConversationHeaderFolderPicker` @115–223 and
  `ConversationFolderBranchPicker` @240–352). Same file/line ranges as the Grep/Read pass.
- **Native `+ Add Folder…` flow confirmed:** `WorkspaceFolderDialog` (Function,
  `workspace-folder-dialog.tsx:97–658`) with `WorkspaceFolderDialogProps` exposing
  `onFolderOpened?: (folder) => void` and `folder?: FolderDetail | null` — exactly the
  auto-select hook the spec needs. Registration path `openFolder` (`app-workspace-store.ts:321`,
  `lib/api.ts:2266`) and the existing consumer `NewFolderDropdown` (`new-folder-dropdown.tsx:36–54`)
  also indexed.

Conclusion unchanged and now **graph-verified**: a reusable native selector exists; a
new component is not justified.

---

## Must-avoid (spec constraints)

- Do **NOT** modify: launch execution, Existing Conversation, Task Engine, Automation
  Engine, Folder Registry, Sidebar, Git Workspace, Local Folder runtime, Existing
  Conversation runtime.
- Do **NOT** create a new `FolderKind` variant, migrate to `folder_id`, or store
  `FolderDetail.id`.

### ⚠️ Conflict caution
`audit/local-folder-native-refactor-phase8.md` (2026-08-05) proposes a **larger** refactor:
a new `FolderKind::Local` variant plus `folder_service.rs` / store changes. That proposal
**conflicts** with this spec's hard constraints (no model change, keep `local_folder_path`,
engines/registry/runtime untouched). **Do NOT follow Phase 8 for this task** — this is the
strictly-minimal UI-only swap.

---

## Next steps (pending approval — NO code written yet)

1. Export `FolderPicker` (1-line patch to `conversation-context-bar.tsx`).
2. Edit the automation-editor launch patch (replace `Input + Browse` with `FolderPicker`
   + `+ Add Folder…` → `WorkspaceFolderDialog`).
3. Verify / extend the task-editor patch (resolve the open item above).
4. Validate against the spec's 12-item checklist; commit to `plugin-dev`.

---

## Tooling note
Indexed MCP (`qartez`, `codebase-memory`) **IS reachable** via `mcpproxy` this session —
the connector panel's "disconnected" status is misleading. Both Grep/Read and live
`codebase-memory:search_graph` queries were used and agree. Per `agent.md` §"MCP Tool
Mandate", indexed tools are used before direct reads.
