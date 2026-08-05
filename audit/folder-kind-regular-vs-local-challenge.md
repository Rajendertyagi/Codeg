# Architecture Audit — Challenge: Is `FolderKind::Local` Necessary?

**Date:** 2026-08-05
**Branch audited:** `plugin-dev`
**Scope:** Challenge the proposal to add `FolderKind::Local`. Determine whether `FolderKind::Regular` can already represent both Git workspaces and plain non-Git folders via runtime repository detection.
**Method:** Read-only. Every claim cites `file:line`. Prior proposal: `audit/local-folder-native-refactor-phase8.md`.

---

## Core Finding

**`FolderKind::Regular` means "user folder" — NOT "Git Workspace". Git is determined entirely by runtime detection, never by FolderKind.** A non-Git folder stored as `Regular` already works everywhere; the Git chrome already auto-hides. `FolderKind::Local` is **not** architecturally required.

---

## 1. What does `FolderKind::Regular` actually mean today?

**It means "user folder" (Git or not).**

Evidence:
- `add_folder_inner` (folder_service.rs:94-154) sets `kind: FolderKind::Regular` for EVERY user-opened folder — no Git check. The only guard is the path's existence, not `.git`.
- `open_folder_core` (commands/folders.rs:636-647) calls `add_folder` with no Git preflight. Opening `D:\Research` (no `.git`) succeeds and stores `kind: "regular"`.
- The `kind` column migrated from a boolean `is_chat` (m20260612_000001_conversation_folder_kind.rs:9) — `Regular` is simply "not a hidden chat scratch folder". It carries no Git semantics.

**Conclusion:** `Regular` = "a folder the user opened". Nothing more.

---

## 2. Is Git determined by FolderKind or runtime detection?

**Entirely by runtime detection. Not a single code path derives Git state from FolderKind.**

| Detection point | File:line | Mechanism |
|---|---|---|
| Repo truth | git_repo.rs:25-27 | `is_git_repo(path)` = `path.join(".git").exists()` — strict, no ancestor walk |
| HEAD/branch resolution | commands/folders.rs:1077-1133 | `resolve_git_head(path)` → `GitHeadInfo { is_repo, branch, detached, short_sha }` via `git rev-parse` |
| Conversation branch seed | commands/conversations.rs:1794-1811 | `detect_git_branch(path)` → `Option<String>` via `git rev-parse`; returns `None` on failure |
| Workspace snapshot | workspace_state/mod.rs:934 | `is_git = wants_tree_git && is_git_repo(root_canonical)` |
| Frontend Git flag | use-workspace-state-store.ts:135,159 | `isGitRepo: snapshot.is_git_repo` propagated from backend |

**No code reads `folder.kind` to decide anything about Git.** The branch dropdown, Git changes tab, and Git log tab all gate on runtime `is_repo` / `isGitRepo`, never on `kind`.

---

## 3. If a user opens `D:\Research` (non-Git) as `FolderKind::Regular`, what breaks?

**Nothing breaks.** Traced end-to-end:

| Lifecycle stage | Behavior for non-Git `Regular` folder | Evidence |
|---|---|---|
| **Creation** | Succeeds. `add_folder_inner` sets `kind: Regular`, no Git check. | folder_service.rs:147 |
| **Storage** | Row stored with `kind: "regular"`, `git_branch: None`. | folder_service.rs:130-149 |
| **Sidebar** | Visible. `list_open_folder_details` filters `kind=Regular`. | folder_service.rs:362 |
| **Branch dropdown** | Shows "noBranch" chip + "init repo" option. Gates on `head.is_repo` (runtime). | branch-dropdown.tsx:127, 515-544 |
| **Git changes tab** | Shows "not a git repo" empty state. Gates on `workspaceState.isGitRepo`. | aux-panel-git-changes-tab.tsx:1617-1627 |
| **Git log tab** | Shows "not a git repo" empty state. Gates on `isGitRepo`. | aux-panel-git-log-tab.tsx:2110-2134 |
| **Conversation creation** | Succeeds. `detect_git_branch` returns `None` → conversation with `git_branch: None`. | conversations.rs:1483-1490, 1794-1811 |
| **Folder context** | `applyGitHead` stores `is_repo: false, branch: None`. | app-workspace-store.ts:274-297 |
| **Aux panel tabs** | Folder tabs show (changes/commits/files). `showFolderTabs = activeFolderId != null && !isChatMode` — no Git gate. | aux-panel.tsx:107 |
| **Chat mode** | NOT chat mode. `useIsActiveChatMode` checks `kind === "chat"` only. | use-is-active-chat-mode.ts:19 |
| **Folder reopening** | Stays `Regular`. `add_folder_inner` reopen never touches `kind`. | folder_service.rs:110-122 |
| **Folder filtering** | Included in sidebar (`Regular`), excluded from hidden-chat GC (`Chat` only). | folder_service.rs:362, 393 |
| **Folder events** | `folder://changed` carries `kind: "regular"`. | event_bridge.rs:623 |

**The Git chrome (branch selector, changes panel, commit log) already auto-hides** because every Git-visible component gates on runtime `isGitRepo`, not on `kind`.

---

## 4. Would existing code auto-hide branch selector / Git status / commit UI?

**Yes. Already proven above.**

- **Branch selector:** `branch-dropdown.tsx:127` — `isRepo = head ? head.is_repo : branch !== null`. Non-Git → `isRepo=false` → renders a single "noBranch" chip offering `git init` (line 515-544). No branch tree, no pull/commit/push.
- **Git status (changes tab):** `aux-panel-git-changes-tab.tsx:1617` — `!workspaceState.isGitRepo` → renders `notAGitRepoTitle` / `notAGitRepoHint` empty state. The commit/rollback/add buttons are inside `{workspaceState.isGitRepo && ( ... )}` (line 1494).
- **Commit UI (log tab):** `aux-panel-git-log-tab.tsx:2110` — `if (!isGitRepo || notAGitRepo)` → renders the same "not a git repo" empty state and returns early. No log entries, no branch filter, no actions.

All three gate on `workspaceState.isGitRepo`, which is computed at `workspace_state/mod.rs:934` from `is_git_repo(root_canonical)` — pure runtime detection.

---

## 5. Compare both designs

### Option A: `Regular` = Git OR non-Git folder (runtime detection)

**Complexity:** Lowest. No new enum variant, no migration (the `kind` text column has no CHECK constraint — m20260612:15-18), no new match arms.

**Code changes:** Minimal. The local-folder automation's `resolve_cwd` branch (automation/engine.rs:698-731) already returns `folder_kind: folder.kind`. If `get_or_create_automation_folder` mints `Regular` instead of `Chat`, the conversation-creation match (engine.rs:557-573) takes the `FolderKind::Regular => create_conversation_core` path automatically. The only required change: make `get_or_create_automation_folder` mint `Regular` (or replace it with `add_folder`, which already does).

**Future maintenance:** Lowest surface area. One fewer enum variant to handle in every `match` on `FolderKind`. No risk of forgetting the `Local` arm in a new feature.

**Compatibility:** Full. All existing `Regular` handling works unchanged. The `list_open_folder_details` filter (folder_service.rs:362) already includes `Regular` in the sidebar.

**Architectural fit:** Aligns with the existing invariant — Git is a runtime property of a path, not a static label. The codebase already treats it this way everywhere.

### Option B: Add `FolderKind::Local`

**Complexity:** Higher. New enum variant + new match arm in the automation engine (engine.rs:557-573) + new frontend type union member (types.ts:611) + new filter conditions.

**Code changes:**
- Backend: `FolderKind::Local` in the enum (folder.rs:12-17); extend the `match cwd.folder_kind` (engine.rs:557-573) — currently non-exhaustive, so the compiler forces a `Local` arm; extend `list_open_folder_details` and friends to include/exclude `Local` as needed.
- Frontend: `FolderKind = "regular" | "chat" | "local"` (types.ts:611); extend `upsertFolder` (app-workspace-store.ts:316) to include `local` in the sidebar.
- i18n: no new strings (kind is internal).

**Future maintenance:** Every future feature that branches on `FolderKind` must handle the `Local` case. Risk of silent bugs if a match is non-exhaustive and defaults wrongly.

**Compatibility:** The `list_open_folder_details` filter (folder_service.rs:362) currently filters `kind=Regular`. `Local` rows would be excluded unless the filter is updated. The `add_folder_inner` insert (folder_service.rs:147) hardcodes `kind=Regular` — opening a folder never mints `Local`, so `Local` can only be minted by special-purpose code (automation), creating an inconsistency.

**Architectural fit:** Introduces a static label for what is actually a runtime property. Duplicates the existing `is_git_repo` detection with a redundant `kind` flag. The `Local` kind would mean "non-Git user folder", but the codebase already knows a folder is non-Git via `isGitRepo=false` — adding `Local` creates two sources of truth.

### Comparison table

| Dimension | Option A (Regular = both) | Option B (add Local) |
|---|---|---|
| Enum variants | 2 (Regular, Chat) | 3 (Regular, Chat, Local) |
| New match arms needed | 0 | 1+ (engine.rs:557, plus any future) |
| Migration | None | None (text column) |
| Sidebar filter change | None (Regular already included) | Must add `Local` to filter |
| Git chrome gating | Runtime `isGitRepo` (unchanged) | Runtime `isGitRepo` (unchanged) |
| Sources of truth for "is Git" | 1 (runtime detection) | 2 (runtime + kind flag) → risk of drift |
| Minting consistency | `add_folder` always Regular (consistent) | `add_folder` mints Regular; only automation mints Local (inconsistent) |
| Task board filter | `kind === "regular"` includes non-Git folders (pre-existing) | `kind === "regular"` excludes Local (hides the pre-existing problem) |

---

## Risks

### Option A risks
- **Task board / automation editor `projectFolders` filter** (tasks-page.tsx:139, automation-editor.tsx:174) uses `kind === "regular"` — a non-Git `Regular` folder appears in the picker. A user could create a task targeting it, which would fail at `git_worktree_add` (work_task/engine.rs:983). **However:** this is PRE-EXISTING behavior. Any non-Git folder opened manually today already appears here. It is NOT introduced by local folders. The fix (add a Git check to the filter) is orthogonal to `FolderKind`.
- **Automation-minted folders appear in the sidebar.** With Option A, `get_or_create_automation_folder` mints a visible `Regular` folder. If automations run at many paths, the sidebar could grow. Mitigation: the user can close unwanted folders; rows are de-duplicated by path.

### Option B risks
- **Two sources of truth.** `kind=Local` says "non-Git"; `isGitRepo` says "non-Git". If a `Local` folder is later `git init`-ed, `isGitRepo` flips to `true` but `kind` stays `Local` until explicitly updated — drift. Conversely, a `Regular` folder that loses its `.git` is correctly detected as non-Git at runtime, but a `Local` folder is assumed non-Git without checking.
- **Inconsistent minting.** Only automation mints `Local`; `add_folder` (the normal open path) always mints `Regular`. So the same path could be `Regular` (opened manually) or `Local` (targeted by automation) — two kinds for the same semantic entity.
- **Non-exhaustive match risk.** The `match cwd.folder_kind` (engine.rs:557-573) is currently `Chat | Regular`. Adding `Local` forces a new arm; forgetting it is a compile error (good), but the correct arm (`Local => create_conversation_core`) duplicates the `Regular` arm — inviting copy-paste drift.
- **Hides the task board problem rather than fixing it.** `kind === "regular"` excludes `Local` from the task board, so local-folder targets don't appear. But manually-opened non-Git `Regular` folders still appear and still fail at task runtime. The root cause (no Git check in the filter) remains.

---

## Final Recommendation

### Choose Option A. Do NOT add `FolderKind::Local`.

`FolderKind::Regular` already means "user folder" and already supports both Git and non-Git paths via runtime detection. Every Git-visible component (branch dropdown, changes tab, log tab) already gates on runtime `isGitRepo` and already auto-hides for non-Git folders. Adding `FolderKind::Local` duplicates an existing runtime signal with a static label, introduces minting inconsistency, and increases maintenance surface — without solving any problem that isn't already solved.

### The actual fix (simpler than the previous proposal)

The local-folder feature needs only this change:

**Make `get_or_create_automation_folder` mint `kind=Regular` instead of `kind=Chat`** (folder_service.rs:206-219). Or replace its usage in `resolve_cwd` (automation/engine.rs:715) with the existing `add_folder`, which already mints `Regular` and reuses existing rows.

Result:
- The automation target folder is a visible `Regular` folder in the sidebar.
- Git chrome auto-hides via runtime `isGitRepo=false`.
- Conversations are created via `create_conversation_core` (the `Regular` arm at engine.rs:568).
- The "Add Folder" reopen bug disappears (reopening a `Regular` row keeps it `Regular` and visible).

No new enum variant. No new match arms. No migration. No frontend type change.

---

## Repository Knowledge Captured

- **Git is a runtime property, never a label.** `is_git_repo` (git_repo.rs:25-27) is the single source of truth; `resolve_git_head` (folders.rs:1077-1133) and `detect_git_branch` (conversations.rs:1794-1811) are the consumers. No code derives Git state from `FolderKind`.
- **Non-Git `Regular` folders already work.** The Git chrome (branch-dropdown.tsx:515, aux-panel-git-changes-tab.tsx:1617, aux-panel-git-log-tab.tsx:2110) already renders graceful "not a repo" states gated on runtime `isGitRepo`.
- **The task board's `projectFolders` filter** (tasks-page.tsx:139) is a worktree-hierarchy filter (`parent_id == null && kind === "regular"`), NOT a Git check. Non-Git folders already appear here — a pre-existing characteristic, not a local-folder regression.
- **`ensure_git_repo`** (git_repo.rs:32) is called at 18 sites (commands/folders.rs) — all git-*operation* handlers (status, branch list, pull). NEVER the folder-open path. Opening a folder never requires Git.
- **`add_folder_inner`** (folder_service.rs:94-154) never checks Git and never resets `kind` on reopen — so the "Add Folder broken" bug is caused solely by `get_or_create_automation_folder` minting `Chat`, not by any Regular-folder limitation.
