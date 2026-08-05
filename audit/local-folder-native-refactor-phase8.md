# Architecture Audit — Phase 8: Local Folder as a Native Codeg Folder (Refactor Proposal)

**Date:** 2026-08-05
**Branch audited:** `plugin-dev`
**Scope:** Folder registry/storage, sidebar, automations Local Folder target, task board, chat mode. Investigation only — no code written; proposal awaiting approval.
**Method:** Read-only. All 9 prior audits read. Every claim cites `file:line` against the current tree.

---

## 1. Folder Architecture — Current (Before)

```
folder table (FolderKind = "regular" | "chat", text column, no CHECK, default "regular")  [entities/folder.rs:12-17, m20260612:15-18]
│
├── Regular rows ── user-visible workspace folders
│     add_folder / add_folder_with_parent → add_folder_inner (folder_service.rs:74-92, 94-154)
│       • new row  → kind = Regular (:147)
│       • reopen   → name/last_opened_at/deleted_at/is_open updated, KIND NEVER TOUCHED (:110-122)
│     open_folder_core (commands/folders.rs:636-647): no git check — plain add_folder
│     listed by list_open_folders / list_open_folder_details / list_folders (filter kind=Regular, :345/:362/:298)
│
├── Chat rows ── hidden per-conversation scratch folders (folderless chat mode)
│     add_chat_folder (folder_service.rs:164-194): kind=Chat, name="Chat", scratch path
│     consumed by: create_chat conversations (commands/conversations.rs:1542+), scratch GC
│     (list_live_chat_folder_paths :388-398), sidebar flat "Chat" group (tab-store.ts:978, 1352)
│     excluded from: list_open_folder_details (:362), upsertFolder sidebar list (app-workspace-store.ts:316)
│
└── ⚠ PARALLEL Local Folder path (automation-only, reuses Chat as its hidden host)
      automation launch_session + targetKind=local_folder
      resolve_cwd LocalFolder branch (automation/engine.rs:698-731)
        → get_or_create_automation_folder (folder_service.rs:206-219)
            ├─ existing non-deleted row at path → reused AS-IS (any kind)
            └─ else → add_chat_folder → kind=Chat row at the USER'S REAL PATH (:189, :218)
        → conversation created by folder_kind match (engine.rs:557-573):
            Chat  → conversation_service::create_chat (flat sidebar chat row)
            Regular → create_conversation_core (normal folder row)
      target decision: newplugin/backend target_kind.rs:41-54 (decide: root_folder_id XOR local_folder_path)
```

**The confirmed defect** (Add Folder broken): Local Folder automation fires at path P → mints a `kind=chat` row at P (`folder_service.rs:189,218`). User later clicks **Add Folder → P** → `add_folder_inner` reopen path reuses the row but **never resets kind** (`:110-122`) → row is `is_open=true` yet filtered out of `list_open_folder_details` (`:362`) and `upsertFolder` (`app-workspace-store.ts:316`) → **invisible forever in the sidebar**, and its conversations render in the flat Chat group (`tab-store.ts:978-979`).

## 2. Folder Architecture — Proposed (After)

```
folder table (FolderKind = "regular" | "chat" | "local")   ← one new variant, NO migration
│
├── Regular rows ── unchanged (git workspace folders)
├── Chat rows ── unchanged (real folderless-chat scratch dirs only)
└── Local rows ── NEW: visible, git-less user folders (replaces the hidden-host hack)
      minted by get_or_create_automation_folder → kind=Local (folder_service.rs:218)
      listed alongside Regular by the three list_* filters (:298/:345/:362 → Regular OR Local)
      included in sidebar folders list (app-workspace-store.ts:316 → kind !== "chat")
      conversations created via create_conversation_core → normal folder rows, render in the folder section
      git chrome self-hides: resolve_git_head returns is_repo:false for non-repos (commands/folders.rs:1077),
        applyGitHead stores null (app-workspace-context.tsx:188), branch-dropdown null-safe (branch-dropdown.tsx:121)

Fix of the defect: add_folder_inner reopen RESETS kind=Regular (:110-122) — an explicit user
"Open/Add Folder" always surfaces the folder, no matter what minted the row. Safe because
chat scratch rows are only ever created by add_chat_folder (never reopened, never at user paths).
```

## 3. Current Lifecycle (3 flows)

| Flow | Steps |
|---|---|
| **Add Folder** | Sidebar dropdown (`new-folder-dropdown.tsx`) / dialog (`workspace-folder-dialog.tsx`) → `apiOpenFolder` → `open_folder` → `open_folder_core` (`folders.rs:636`) → `add_folder` → `add_folder_inner` (`folder_service.rs:94`) → insert Regular or reopen (kind untouched) |
| **Local Folder automation** | Cron/manual fire → `run_automation` → `launch` (`engine.rs:424`) → `resolve_cwd` LocalFolder (`:698`) → `get_or_create_automation_folder` (`:715`) → hidden Chat row at user path → `create_chat` conversation (`:558`) → hidden flat-Chat session |
| **Chat (folderless)** | Scratch dir → `add_chat_folder` (`:164`) → `create_chat` conversation → flat Chat group; scratch GC on boot (`conversations.rs:1927`, `:3103`) |

## 4. Proposed Lifecycle

| Flow | Steps |
|---|---|
| **Add Folder** | unchanged entry — reopen now resets `kind=Regular` (`folder_service.rs:110-122`) |
| **Local Folder automation** | `resolve_cwd` LocalFolder → `get_or_create_automation_folder` now mints **kind=Local** (`folder_service.rs:218`) → `create_conversation_core` (`engine.rs:557` match gains `FolderKind::Local` arm) → **visible folder + normal conversation in sidebar**; branch/git chrome hidden via existing null-gitHeads path |
| **Chat (folderless)** | unchanged — `add_chat_folder` still `kind=Chat`; GC untouched (`list_live_chat_folder_paths` filters Chat only, `:393`) |

## 5. Files That Change + Why

**Backend (3 files, ~6 edits):**

| File | Change | Why |
|---|---|---|
| `src-tauri/src/db/entities/folder.rs:12-17` | Add `FolderKind::Local` variant | The core new concept; text column means no migration |
| `src-tauri/src/db/service/folder_service.rs` | `add_folder_inner` reopen resets `kind=Regular` (`:110-122`); `get_or_create_automation_folder` mints `Local` (`:218`); three list filters accept Regular **or** Local (`:298/:345/:362`); GC filter stays Chat-only (`:393`) | Fixes the defect; makes Local folders visible; chat scratch GC must not see Local rows |
| `src-tauri/src/automation/engine.rs` | `resolve_cwd` LocalFolder branch reuses native row + Local kind; `:557-573` match gains `FolderKind::Local => create_conversation_core` arm (compiler-forced by adding the variant) | Local runs become first-class folder conversations |

**Frontend (2 files):**

| File | Change | Why |
|---|---|---|
| `src/lib/types.ts:611` | `FolderKind = "regular" \| "chat" \| "local"` | Wire mirror of the Rust enum |
| `src/stores/app-workspace-store.ts:316` | `upsertFolder`: include `"local"` in sidebar `folders` | Local folders surface in the Folders section |

**No changes needed** (verified): `commands/folders.rs` (open is already git-agnostic), `use-is-active-chat-mode.ts` (keys on `"chat"` only), `branch-dropdown.tsx` / `app-workspace-context.tsx` (null-safe already), `automation-editor.tsx` + `target_kind.rs` (target selection unchanged), `web/event_bridge.rs:623` (event default), `conversations.rs:1927` chat cleanup (Chat-kind only), i18n (no new user-facing strings — kind is internal).

## 6. Local Folder Code Removable / Simplified

- **`get_or_create_automation_folder`** (`folder_service.rs:206-219`): the hidden-chat-host behavior is deleted; the reuse-any-row logic narrows to "reuse Regular/Local row, else mint **Local**". 11 lines shrink to ~6.
- **`FolderKind::Chat => create_chat` routing** (`automation/engine.rs:558-567`): the automation-side branch is removed; only the real chat-mode `create_chat` path remains.
- **`add_chat_folder`** (`folder_service.rs:164-194`): stays — it is the genuine chat-mode mechanism, no longer misused by automations.
- **`target_kind.rs` / `launch_target.rs`**: stay as-is (Layer-2 business rules, not folder-system code).
- Chat scratch GC (`list_live_chat_folder_paths`): unchanged — and Local rows are automatically excluded, which is **correct** (user paths must never be GC'd).

## 7. Risks

1. **Task Board on a Local folder** — `preflight_folder` only rejects worktrees (`work_task/engine.rs:1193-1195`), not non-repos; worktree minting would fail at launch on a git-less path (`work_task/git.rs`). **Mitigation (in-scope):** `preflight_folder` gains an `is_git_repo` check with a clear "tasks require a git workspace" error — Local folders can't host tasks, fail loudly not silently. (Recommended; keeps the ONE-refactor constraint — it is 3 lines in the same engine we already touch.)
2. **Reopen reset vs real chat rows** — resetting `kind=Regular` in `add_folder_inner` is safe only because `add_chat_folder` never reuses existing paths (its scratch paths are fresh, `:164-194`); document this invariant on the reopen path.
3. **Enqueue-task automations** already fail-fast on a local target (`engine.rs:381-383` — requires `root_folder_id`); UI blocks it too (`automation-editor.tsx:633-658` radio is launch_session-only). No change needed.
4. **No-regression verified:** GitWorkspace branch of `resolve_cwd` (`engine.rs:733+`) untouched; chat-mode flow untouched; open flow untouched (open is already git-agnostic today).

## 8. Future Support Assessment (Local folders as first-class)

| Feature | Status today | After this refactor | Unblocked follow-ups |
|---|---|---|---|
| **Automations** (launch_session) | Works via hidden chat hack | Works natively, visible, history in the folder | Branch/isolation controls already disabled for Local (`engine.rs:669-671`) |
| **Enqueue Task / Task Board** | Blocked (needs git + `root_folder_id`) | Still git-only by design; explicit preflight error | Future: task engine gains a non-worktree "run in root dir" mode (`work_task/engine.rs:1006` `open_worktree_folder_core` is the single seam) |
| **Chat** | Unaffected | Unaffected — Chat kind reserved for true folderless mode | — |
| **Existing Conversation resume** | Works (Local run conversations are normal rows after refactor) | Unchanged | — |

---

**Scope discipline honored:** one refactor, extends the existing `FolderKind` enum — no new registry, no duplicated registry/storage logic, no new tables. Total surface: 3 backend files + 2 frontend files + 0 migrations.

**Open decisions awaiting user approval:**
1. Include the Task Board preflight git-guard (Risk 1 mitigation) in the same change, or leave the board silently failing on Local folders for a later change?
2. Commit this report to `plugin-dev` alongside the implementation (audit-first convention)?
