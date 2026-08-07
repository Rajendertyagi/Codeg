# Codeg Custom Features

This document describes the custom features added on top of the Codeg platform
(base `origin/main`, 0.23.x), how each one works, and the file list behind it.

## Model: patch-archive (how everything ships)

The engine + frontend tree is kept **100% pure upstream**. No custom code ever
touches `src/`, `src-tauri/src/`, or vendored components directly. Every custom
feature lives as an **apply-on-demand patch** under `newplugin/patches/`, plus
committed custom files under `newplugin/hooks/`, `newplugin/backend/`, and
`newplugin/frontend/`.

The CI workflow `.github/workflows/codeg-portable-win64-custom.yml` applies all
patches in dependency order **before building** the portable Windows app:

1. 18 patches (`.patch`): 17 auto-approve + 1 `FolderPicker` export (used by the local-folder selector)
2. 16 task-accept patches (`.accept.patch`)
3. 20 launch-target patches (`.launch.patch`)
4. 13 custom-workflows tab patches (`.customtab.patch`)

> Because patches are applied only at build time, a plain checkout has **no**
> features. Only the CI build produced by the custom workflow ships them.

---

## Feature 1 — Auto-approve (global toggle)

### What it does

A global, app-wide toggle (a shield button in the message composer). When ON,
every tool-permission request is **answered automatically** with the first
"allow" option the agent offered — before a permission card is ever parked or
broadcast. The flag is persisted in `app_metadata` and survives restarts.

### How it works

- The shield button in the composer loads the current state on mount and flips
  it on click → `toggleGlobalAutoApprove()` / `getGlobalAutoApprove()` in the
  frontend API client.
- Transport routes the call to the Tauri command (`toggle_auto_approve_global` /
  `get_auto_approve_global`) or the HTTP route (`/toggle_auto_approve_global` /
  `/get_auto_approve_global`) depending on mode.
- The backend persists the flag via `app_metadata` (`key = auto_approve_global`)
  and caches it in-process.
- The runtime gate is inside ACP permission handling: when a permission request
  arrives, `is_auto_approved()` is consulted; if ON and the request offers
  `allow_once`/`allow_always`, the request is resolved with that option and a
  `PermissionResolved` event is emitted. No card appears.
- When OFF (or no allow option offered), the normal permission dialog flow runs
  unchanged. Companion patches allow **multiple** pending permission cards to
  queue and render individually when the shield is off.

### Files

| Path | Role |
|------|------|
| `newplugin/hooks/custom_auto_approve.rs` | Core logic: persisted flag, in-process cache, get/toggle/init/is-approved |
| `newplugin/hooks/mod.rs` | Registers the hook module + command wrappers |
| `newplugin/patches/src-tauri-src-lib.rs.patch` | Tauri commands + startup hydration |
| `newplugin/patches/src-tauri-src-web-router.rs.patch` | HTTP routes |
| `newplugin/patches/src-tauri-src-web-handlers-mod.rs.patch` | Handler module registration |
| `newplugin/patches/src-tauri-src-web-handlers-auto_approve.rs.patch` | Web handler functions |
| `newplugin/patches/src-tauri-src-acp-connection.rs.patch` | **The gate** — auto-answers permission requests |
| `newplugin/patches/src-lib-api.ts.patch` | Client functions |
| `newplugin/patches/src-components-chat-message-input.tsx.patch` | Shield toggle button in composer |
| `newplugin/patches/src-components-chat-permission-dialog.tsx.patch` | Standardized dialog buttons |
| `newplugin/patches/src-components-chat-permission-dialog.test.tsx.patch` | Test updates |
| `newplugin/patches/src-components-chat-conversation-shell.tsx.patch` | Multi-card permission queue |
| `newplugin/patches/src-contexts-acp-connections-context.tsx.patch` | Pending-permission queue state |
| `newplugin/patches/src-contexts-acp-connections-context.test.tsx.patch` | Test updates |
| `newplugin/patches/src-hooks-use-connection.ts.patch` | Hook wiring |
| `newplugin/patches/src-components-conversations-conversation-detail-panel.tsx.patch` | Panel wiring |
| `newplugin/patches/src-i18n-messages-en.json.patch` (+ zh-CN, zh-TW) | UI strings |

---

## Feature 2 — Task-accept (review → done without git merge)

### What it does

Lets a reviewed work task go directly to **done** **without** a git merge.
The upstream engine can only land a review through a merge; this feature adds a
non-git accept path for tasks that have **no worktree** (tasks that still own a
worktree keep the merge pipeline — the accept button is not offered).

### How it works

- The task card and detail sheet show an **Accept** button when the task is
  reviewed and worktree-less (`task.worktree_folder_id == null`).
- Clicking it calls `workTaskAccept(id)` in the frontend API client.
- The call routes to the Tauri command (`work_task_accept`) or HTTP route
  (`/work_task_accept`).
- Backend logic (`task_accept::accept_task`) mirrors the engine's own guard
  style: requires the task to be in `review` state, must have no worktree, and
  lands the row straight to `done` without clearing preflight/merge bookkeeping.

### Files

| Path | Role |
|------|------|
| `newplugin/hooks/task_accept.rs` | Core accept logic (review → done, no merge) |
| `newplugin/hooks/web_workflows.rs` | Web handler: `work_task_accept` |
| `newplugin/hooks/mod.rs` | Registers the hook + command wrapper |
| `newplugin/patches/src-tauri-src-lib.rs.accept.patch` | Tauri command registration |
| `newplugin/patches/src-tauri-src-web-router.rs.accept.patch` | HTTP route |
| `newplugin/patches/src-lib-api.ts.accept.patch` | Client function `workTaskAccept` |
| `newplugin/patches/src-components-tasks-task-card.tsx.accept.patch` | Accept button on card |
| `newplugin/patches/src-components-tasks-task-detail-sheet.tsx.accept.patch` | Accept action in detail sheet |
| `newplugin/patches/src-components-tasks-tasks-page.tsx.accept.patch` | Page wiring + canAccept logic |
| `newplugin/patches/src-i18n-messages-{en,zh-CN,zh-TW,ja,ko,es,de,fr,pt,ar}.json.accept.patch` | UI strings (10 locales) |

---

## Feature 3 — Launch-target (resume existing conversation / run in non-git folder)

### What it does

Gives work-task and automation runs a **launch target**:

- **Resume** — run inside an existing conversation (reusing its row and, when
  present, its external agent session id).
- **Fresh** — create a new disposable conversation.

Also enables running in a **non-git local folder** (Local Folder execution)
instead of requiring a git worktree.

### How it works

- Decision logic lives in the standalone `newplugin-backend` crate
  (`launch_target::decide`), which receives a target-conversation view and
  returns `LaunchTarget::Fresh` or `LaunchTarget::Resume { resume_session_id }`.
- The crate is a path dependency of the main app (`Cargo.toml` patch adds
  `newplugin-backend = { path = "../newplugin/backend" }`); it is deliberately
  layered — plain data in, plain decision out, no dependency back on the engine.
- The automation engine and work-task engine consume the decision: a resume
  re-attaches the external session via the spawn dedup (same as UI/work-task
  resume paths); a fresh target mints a new conversation.
- Config carries the target through `existing_conversation_id` /
  `local_folder_path` fields in the automation / work-task models.

### Files

| Path | Role |
|------|------|
| `newplugin/backend/Cargo.toml` | Standalone crate manifest |
| `newplugin/backend/src/lib.rs` | Crate root |
| `newplugin/backend/src/launch_target.rs` | `LaunchTarget` enum + `decide()` logic |
| `newplugin/backend/src/target_kind.rs` | `TargetKind` enum + target decision helpers |
| `newplugin/patches/src-tauri-Cargo.toml.launch.patch` | Adds `newplugin-backend` path dep |
| `newplugin/patches/src-tauri-Cargo.lock.launch.patch` | Lockfile update |
| `newplugin/patches/src-tauri-src-automation-engine.rs.launch.patch` | Engine resume/fresh target handling |
| `newplugin/patches/src-tauri-src-work_task-engine.rs.launch.patch` | Work-task resume session handling |
| `newplugin/patches/src-tauri-src-models-automation.rs.launch.patch` | `existing_conversation_id` in automation model |
| `newplugin/patches/src-tauri-src-models-work_task.rs.launch.patch` | Launch-target fields in work-task model |
| `newplugin/patches/src-tauri-src-db-service-folder_service.rs.launch.patch` | Folder/kind support for Local Folder |
| `newplugin/patches/src-lib-types.ts.launch.patch` | TS type mirrors |
| `newplugin/patches/src-components-tasks-task-editor-dialog.tsx.launch.patch` | Task editor target UI |
| `newplugin/patches/src-components-chat-conversation-context-bar.tsx.patch` | Exports native `FolderPicker` + `hideChatMode` (group 1 — applied **before** launch patches so the editor can import it) |
| `newplugin/patches/src-i18n-messages-{en,zh-CN,zh-TW,ja,ko,es,de,fr,pt,ar}.json.launch.patch` | UI strings (10 locales) |

**Local-folder selector reuse (UI):** the automation editor's `local_folder` target no
longer uses a text `<Input>` + `[Browse…]`. It reuses the native, registry-backed
`FolderPicker` (filtered to `kind === "regular"`, top-level — i.e. FolderKind::Regular
only) with a native `+ Add Folder…` action (`WorkspaceFolderDialog`) that auto-selects
the new folder. `FolderPicker` is exported from `conversation-context-bar.tsx` via the
group-1 patch above; `config.local_folder_path` is unchanged.

---

## Feature 4 — Scheduled automation into an existing chat

### What it does

Lets an automation fire on its **cron schedule** and **resume a pinned existing
conversation** instead of always creating a new one ("cron job with an existing
thread").

### How it works

- The **upstream** automation engine already runs a scheduler (polls every 30s
  and fires due automations with trigger `"schedule"`). The custom launch
  patches extend the run path.
- In the automation editor, a new **conversation target** section lets you pick
  "new conversation" or "existing conversation" via `AutomationConversationPicker`
  (a committed custom component that lists the selected agent's top-level
  conversations in resumable statuses: pending_review / completed / cancelled;
  mid-turn in-progress conversations are never offered).
- The chosen id is stored as `existing_conversation_id` in the automation config
  (Rust model: `Option<i32>`).
- When the automation fires on cron, the engine resolves the pinned target
  **before** building the run — a vanished/deleted target fails fast without
  creating a worktree — then resumes that conversation's session and fires the
  prompt into it.

### Files

| Path | Role |
|------|------|
| `newplugin/frontend/automation-conversation-picker.tsx` | Picker component (committed) |
| `newplugin/patches/src-components-automations-automation-editor.tsx.launch.patch` | Editor: target section + picker + config field |
| `newplugin/patches/src-tauri-src-automation-engine.rs.launch.patch` | Engine: resolve pinned target, resume session |
| `newplugin/patches/src-tauri-src-models-automation.rs.launch.patch` | `existing_conversation_id` in config |
| `newplugin/patches/src-lib-types.ts.launch.patch` | TS type mirrors |
| `newplugin/patches/src-i18n-messages-*.json.launch.patch` | UI strings (10 locales) |

> Shares the launch-target machinery (Feature 3); the automation resume path is
> the same code used by the work-task resume path.

---

## Feature 5 — Custom Workflows tab (placeholder)

### What it does

Adds a **"Custom Workflows"** tab in the left sidebar. It renders a dedicated
page: a title strip ("Custom Workflows" + calendar icon) in the window-chrome
band and a centered placeholder ("Custom workflow scheduling is coming soon").

### Status: placeholder only

This is **deliberately inert** — by user decision, the scheduler is **not
wired**. The tab exists so the route renders; no scheduling engine is connected
to it.

- The dormant scheduler code (`newplugin/hooks/custom_cron.rs` +
  `web_workflows.rs` workflow functions) **compiles** into patched builds but is
  **NOT** wired to the tab. Do not wire it without explicit user approval.
- The page **hardcodes all copy** (no i18n keys) because `src/i18n/global.d.ts`
  strictly types messages from en.json and the tab's `t("customWorkflows")` key
  exists only inside the patches.

### How it works

- The patch extends the `WorkbenchRouteId` union with `"customWorkflows"`.
- `WORKBENCH_ROUTES` / `WORKBENCH_ROUTE_STRIPS` in `workbench-content.tsx`
  register the page and its title strip.
- The sidebar adds a `SidebarNavButton` (CalendarCog icon, label from
  `t("customWorkflows")`) that calls `setRoute("customWorkflows")`.
- The page component itself is a **committed** custom file under `newplugin/`,
  so it type-checks even in the pure tree.

### Files

| Path | Role |
|------|------|
| `newplugin/frontend/custom-workflows-page.tsx` | Page + title strip components (committed) |
| `newplugin/patches/src-contexts-workbench-route-context.tsx.customtab.patch` | Route id union |
| `newplugin/patches/src-components-workbench-workbench-content.tsx.customtab.patch` | Route + strip registration |
| `newplugin/patches/src-components-layout-sidebar.tsx.customtab.patch` | Sidebar button |
| `newplugin/patches/src-i18n-messages-{en,zh-CN,zh-TW,ja,ko,es,de,fr,pt,ar}.json.customtab.patch` | `"customWorkflows"` label key (10 locales) |
| `newplugin/hooks/custom_cron.rs` | **Dormant** scheduler (not wired) |
| `newplugin/hooks/web_workflows.rs` | **Dormant** workflow endpoints (not wired) |

---

## Where to find the built app

The portable Windows build with all patches applied is produced by the
`codeg-portable-win64-custom` workflow in **GitHub Actions**
(`Actions` → `Build Codeg Portable Windows x64`), artifact
`codeg-portable-win64`. It triggers on every push to `plugin-dev` and on manual
dispatch.

## Summary table

| # | Feature | Status | Patches | Key custom files |
|---|---------|--------|---------|------------------|
| 1 | Auto-approve (global toggle) | Wired | 17 | `hooks/custom_auto_approve.rs` |
| 2 | Task-accept (review → done, no merge) | Wired | 16 | `hooks/task_accept.rs` |
| 3 | Launch-target (resume / non-git folder) | Wired | 20 | `backend/src/launch_target.rs` |
| 4 | Scheduled automation → existing chat | Wired | (within launch group) | `frontend/automation-conversation-picker.tsx` |
| 5 | Custom Workflows tab | Placeholder only | 13 | `frontend/custom-workflows-page.tsx` |

**Total: 67 patches** (18 + 16 + 20 + 13) + committed custom files in
`newplugin/hooks/`, `newplugin/backend/`, `newplugin/frontend/`.
