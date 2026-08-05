# Task Board + Native Folder Integration Audit

**Date:** 2026-08-05
**Scope:** Task Board execution engine, folder registry, Git assumptions, Local Folder integration
**Method:** Repository evidence only (Qartez + direct code reads)

---

## 1. Task Lifecycle Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                        TASK LIFECYCLE                               │
│                                                                     │
│  Manual Path:                                                        │
│  New Task → TaskEditorDialog → workTaskCreate → ┐                   │
│                                                  │                   │
│  Automation Path:                                ├→ work_task_      │
│  Automation.fire → enqueue_task →               │   create_core     │
│  work_task_create_core ─────────────────────────┘       │           │
│                                                         ▼           │
│                                              DB INSERT (todo)       │
│                                                         │           │
│                                              nudge_pump(folder_id)  │
│                                                         ▼           │
│                                              pump_folder(folder_id) │
│                                                         │           │
│                                                         ▼           │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  ENGINE LAUNCH (engine.rs:654)                               │   │
│  │  ├─ preflight_folder (rejects worktrees)                     │   │
│  │  ├─ begin_setup (queued → preparing)                         │   │
│  │  ├─ ensure_worktree ──────────────────────────────┐          │   │
│  │  │  ├─ resolve_git_head (requires git repo)       │          │   │
│  │  │  ├─ git_worktree_add (creates task/<id> branch)│          │   │
│  │  │  └─ open_worktree_folder_core (parent_id = root)│          │   │
│  │  │                                                │          │   │
│  │  │  ★ GIT DEPENDENCY — fails for non-repo ★       │          │   │
│  │  └────────────────────────────────────────────────┘          │   │
│  │  ├─ run_init_command (optional setup)                         │   │
│  │  ├─ spawn_agent (in worktree path)                            │   │
│  │  ├─ create_conversation_core (wt.folder_id)                   │   │
│  │  ├─ send_prompt (compose_prompt with branch guards)           │   │
│  │  └─ mark_running                                              │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                          │                                          │
│                          ▼                                          │
│  SETTLE (on_turn_complete):                                         │
│  end_turn + verdict → review                                        │
│  user:merge → merge generation (agent lands on base) → done         │
│  user:return → return generation (feedback) → running               │
│  user:cancel → canceled                                             │
│  agent_error → failed → retry                                       │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 2. Manual Task Lifecycle

| Step | Function | File:Line |
|------|----------|-----------|
| User clicks "New Task" | `openNewTask()` | `tasks-page.tsx:309` |
| Editor opens with folder picker | `TaskEditorDialog` | `task-editor-dialog.tsx:88` |
| Folder list filtered to project roots | `folders.filter(f => f.parent_id == null && f.kind === "regular")` | `task-editor-dialog.tsx:131-133` |
| Submit → `workTaskCreate(draft)` | `submitEditor` | `tasks-page.tsx:293-301` |
| CRUD core | `work_task_create_core` | `commands/work_task.rs:62-75` |
| DB insert (status=todo) | `work_task_service::create` | `db/service/work_task_service.rs:379-446` |
| **Backend validates folder** | `folder.parent_id.is_some()` → reject worktrees | `work_task_service.rs:391-394` |
| Nudge pump | `nudge_pump(info.folder_id)` | `commands/work_task.rs:73` |
| Engine claims todo→queued | `claim_for_run(Todo)` | `engine.rs:318` |
| Engine launches | `pump_folder → spawn_launch → launch` | `engine.rs:490-650` |

---

## 3. Automation → Enqueue Task Lifecycle

| Step | Function | File:Line |
|------|----------|-----------|
| Automation fires (cron/manual) | `AutomationEngine::fire` | `automation/engine.rs` |
| Action = EnqueueTask detected | `cfg.action == AutomationAction::EnqueueTask` | `automation/engine.rs:429` |
| `enqueue_task()` | creates `WorkTaskDraft` from automation config | `automation/engine.rs:375-421` |
| **Requires target folder** | `auto.root_folder_id.ok_or(...)` | `automation/engine.rs:382-383` |
| Same CRUD core | `work_task_create_core(&self.emitter, &self.db, draft)` | `automation/engine.rs:399` |
| Settle automation run | `settle_run(Succeeded, ...)` | `automation/engine.rs:403` |

**Merge point**: Both paths converge at `work_task_create_core` (`commands/work_task.rs:62`). After DB insert, the work-task engine owns execution identically for both.

---

## 4. Merge Point

```
Manual:   New Task → workTaskCreate ─┐
                                    ├→ work_task_create_core() → DB INSERT (todo)
Automation: fire → enqueue_task ────┘
                                         │
                                         ▼
                              nudge_pump → pump_folder → launch
```

The **single merge point** is `work_task_create_core` (`commands/work_task.rs:62-75`). Both producers create a `todo` task row; the engine's `pump_folder` is the sole consumer.

---

## 5. Folder Usage

### Evidence: Task Board consumes the SAME folder registry

| Layer | Code | Location |
|-------|------|----------|
| **Frontend picker filter** | `folders.filter((f) => f.parent_id == null && f.kind === "regular")` | `task-editor-dialog.tsx:131-133`, `tasks-page.tsx:138-141` |
| **Backend create validation** | `if folder.parent_id.is_some() { reject }` | `work_task_service.rs:391-394` |
| **Engine preflight** | `if row.parent_id.is_some() { reject "not a worktree" }` | `engine.rs:1193-1195` |
| **Automation enqueue** | `auto.root_folder_id` (same `folder` table FK) | `automation/engine.rs:382` |
| **Automation editor filter** | `projectFolders = folders.filter(f => f.parent_id == null && f.kind === "regular")` | `automation-editor.tsx:173-177` |

**Why Target currently only shows folders:**
- The task model binds to `folder_id` (a FK to the `folder` table)
- The filter `parent_id == null` excludes worktrees (which have `parent_id = root_folder_id`)
- The filter `kind === "regular"` excludes chat scratch folders (`kind = chat`)
- This is the **same folder registry** used by Chat and Automations — no separate task-folder system exists

**Does it assume every Regular folder is a Git workspace?**
- **No** — the folder model makes no Git assumption. `FolderKind::Regular` is just "user folder"
- Git detection is purely runtime: `is_git_repo(path)` checks for `.git` existence (`git_repo.rs:25-27`)
- The `workspace_state` tracks `is_git_repo: bool` as a runtime property (`workspace_state/mod.rs:77`)

---

## 6. Git Assumptions

### Every Git assumption in Task Board:

| Assumption | Location | Fundamentally Required? |
|------------|----------|------------------------|
| **`resolve_git_head` requires git repo** | `engine.rs:970` | **YES** — `head.branch.ok_or("not on a branch")` fails for non-repo |
| **`git_worktree_add` creates isolated worktree** | `engine.rs:983-1004` | **YES** — core isolation mechanism |
| **`open_worktree_folder_core` registers worktree folder** | `engine.rs:1006` | **YES** — worktree gets `parent_id = root` |
| **`compose_prompt` emits branch/worktree guards** | `engine.rs:2371-2391` | Implementation assumption — prompt text assumes git worktree |
| **Merge generation is entirely git-based** | `engine.rs:1528-1800` | **YES** — `merge_landed_commit`, `is_ancestor`, `trees_equal` |
| **`base_branch`, `base_sha`, `work_branch` columns** | `work_task` table | **YES** — task model stores git refs |
| **`preflight_folder` checks `parent_id`** | `engine.rs:1193` | **NO** — this is a structural check (reject worktrees), not git |

### Verdict:
- **Git IS fundamentally required** for the current execution model (worktree isolation + merge landing)
- The only non-git check is `preflight_folder` (structural: reject worktrees)
- The task **prompt** is git-assuming (branch names, merge instructions) but that's an implementation detail

---

## 7. Exact Blockers for Local Folder

### What ALREADY WORKS (no change needed):

1. **Folder picker includes Local Folder** ✓
   - Filter: `f.parent_id == null && f.kind === "regular"`
   - Local Folder now has `kind = Regular`, `parent_id = None` (from `add_folder`, `folder_service.rs:147`)
   - Evidence: `folder_service.rs:143-147` — new rows get `parent_id: None`, `kind: Regular`

2. **Backend create validation passes** ✓
   - `work_task_service.rs:391`: `if folder.parent_id.is_some()` — Local Folder has `parent_id = None` → passes

3. **Engine preflight passes** ✓
   - `engine.rs:1193`: same `parent_id` check → passes

4. **Automation enqueue can target Local Folder** ✓
   - Automation editor filter is identical (`automation-editor.tsx:173-177`)
   - `root_folder_id` FK works for any Regular folder

### What BLOCKS execution:

| Blocker | Location | Error |
|---------|----------|-------|
| **`resolve_git_head` fails** | `engine.rs:970-973` | `"project folder is not on a branch (detached HEAD?)"` — `head.branch` is `None` for non-repo |
| **`git_worktree_add` fails** | `engine.rs:983` | `git worktree add` requires a git repository |
| **Merge generation impossible** | `engine.rs:1528+` | No git = no merge landing |
| **Prompt assumes worktree** | `engine.rs:2371-2391` | Branch guards, merge instructions meaningless |

**The single root cause**: `ensure_worktree()` (`engine.rs:954-1023`) assumes a git repository. For a Local Folder (non-repo), the launch fails at line 971-973.

---

## 8. Existing Conversation Support

**Could the Task model support Existing Conversation without redesign?**

Current state:
- Task model has `conversation_id: Option<i32>` and `worktree_folder_id: Option<i32>`
- Launch path supports `resume_session_id` for retry/return/merge (resuming the task's OWN previous session)
- **No** "launch into an existing external conversation" concept exists in the task engine
- The automation engine HAS `existing_conversation_id` (`automation.rs:106`) but the task engine does not

**Theoretical support**: The task launch path already forks on `resume_session_id` (Fresh vs Retry/Return/Merge). Adding an "Existing Conversation" launch mode would be a new `LaunchMode` variant — but it would still hit the `ensure_worktree` blocker unless the conversation's folder is git-backed.

---

## 9. Smallest Architectural Change Required

### The principle: **Extend Codeg. Reuse Codeg. Remove unnecessary assumptions.**

The folder layer is **already correct** — Local Folder is a native Regular folder and flows through every picker/validation. The only work is in the **execution layer**.

### The change:

**Add a non-git launch path to the work-task engine** that mirrors what the automation engine already does for `LocalFolder`:

| Component | Current (git) | Needed (non-git) |
|-----------|---------------|------------------|
| `ensure_worktree` | `resolve_git_head` + `git_worktree_add` | **Skip** — run directly in folder path |
| `worktree_folder_id` | Points to worktree folder | **NULL** — use project folder directly |
| `compose_prompt` | Branch/worktree guards | **Plain task prompt** (no git instructions) |
| Merge generation | Git merge landing | **Disabled** or "mark done" without git |
| `base_branch`/`base_sha`/`work_branch` | Recorded git refs | **NULL** — not applicable |

### Concrete smallest change:

1. **Detect git-ness at launch time** (runtime, like automation does):
   ```rust
   let is_git = is_git_repo(&root.path); // git_repo.rs:25 — already exists
   ```

2. **Branch in `launch()`**: if `!is_git`, skip `ensure_worktree`, use `root.path` directly as the agent cwd, set `worktree_folder_id = NULL`.

3. **Adjust `compose_prompt`**: for non-git tasks, omit the worktree guard block (engine.rs:2371-2391) and merge generation.

4. **Disable/hide merge UI** for non-git tasks (the frontend already keys off `task.base_branch` being null).

### What NOT to change:
- ❌ Folder model (already correct)
- ❌ Folder picker filters (already correct)
- ❌ `work_task_service::create` validation (already correct)
- ❌ Automation enqueue path (already works)
- ❌ `FolderKind` enum (no `Local` variant needed)

### Precedent in the codebase:
The **automation engine** already implements this exact pattern:
- `LocalFolder` target → `resolve_cwd` returns the folder directly, no worktree (`automation/engine.rs:698-733`)
- `folder_kind: folder.kind` is passed through, and the conversation is created in that folder
- No git operations are attempted

The task engine can mirror this: a non-git folder launches the agent directly in the folder path, with no worktree, no branch, no merge.

---

## Summary

| Question | Answer |
|----------|--------|
| Does Task Board reuse the same folder registry? | **Yes** — `folder_id` FK, same `folder` table, same filters |
| Does it assume every Regular folder is Git? | **No** — Git is runtime-detected; folder model is Git-agnostic |
| Does Git disappear naturally with Local Folder? | **No** — Git is required by the *execution* engine, not the folder model |
| What already works for Local Folder? | **Everything up to launch** — picker, validation, creation |
| What blocks execution? | **`ensure_worktree`** (engine.rs:954) — requires git repo |
| Smallest change? | **Non-git launch path** in the engine (mirror automation's `LocalFolder` pattern) |
| Existing Conversation support? | **Not currently** — task engine has no external-conversation launch target |
