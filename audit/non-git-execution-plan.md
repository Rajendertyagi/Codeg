# Implementation Plan: Non-Git Execution Strategy

**Date:** 2026-08-05
**Scope:** Work-task execution engine — support both Git Workspace and Local Folder
**Method:** Qartez MCP (`qartez_map`, `qartez_calls`, `qartez_deps`, `qartez_context`, `qartez_impact`, `qartez_test_gaps`) + codebase-memory (`search_graph`) + targeted reads
**Principle:** Smallest possible change. No redesign. No duplication. Git behavior byte-for-byte identical.

---

## 1. Before Architecture

```
Task
  ↓
launch() [engine.rs:654]
  ↓
ensure_worktree() [engine.rs:954] ← single function, 6 mixed responsibilities
  ├─ get_folder_core() — reuse check
  ├─ resolve_git_head() — requires git
  ├─ task_git::rev_parse() — requires git
  ├─ git_worktree_add() — requires git
  ├─ open_worktree_folder_core() — registers worktree
  └─ attach_worktree() — records git refs
  ↓
Returns WorktreeRef { folder_id, path }
  ↓
spawn_agent(working_dir: wt.path) [manager.rs:400]
  ↓
create_conversation_core(folder_id: wt.folder_id) [conversations.rs:1477]
  ↓
compose_prompt() [engine.rs:2256] — git guards + merge instructions
```

**Problem:** `ensure_worktree()` is a single gate that ALL tasks must pass through. It assumes git. Non-git folders fail at `resolve_git_head()` (line 970-973).

---

## 2. After Architecture

```
Task
  ↓
launch() [engine.rs:654]
  ↓
resolve_execution_target() [NEW — replaces ensure_worktree call]
  │
  ├── Git folder detected (is_git_repo)
  │     └─ ensure_worktree() [UNCHANGED]
  │          └─ Returns ExecutionTarget { folder_id, path, git_info: Some(...) }
  │
  └── Non-Git folder (Local Folder)
        └─ resolve_local_target() [NEW — 5 lines]
             └─ Returns ExecutionTarget { folder_id, path, git_info: None }
  ↓
spawn_agent(working_dir: target.path) — UNCHANGED
  ↓
create_conversation_core(folder_id: target.folder_id) — UNCHANGED
  ↓
compose_prompt() — git guards conditional on target.git_info
```

---

## 3. Responsibility Movement Table

| # | Current Responsibility | Current Location | Decision | Justification |
|---|----------------------|------------------|----------|---------------|
| A | Reuse check (folder exists) | `ensure_worktree()` L959-968 | **Move to shared** `resolve_execution_target()` | Git-agnostic — any folder can be reused |
| B | Git detection (`resolve_git_head`) | `ensure_worktree()` L970-973 | **Stay in git path** only | Fundamentally requires `.git/HEAD` |
| C | Worktree creation (`git_worktree_add`) | `ensure_worktree()` L983-1004 | **Stay in git path** only | `git worktree add` requires a repository |
| D | Folder registration | `ensure_worktree()` L1006 | **Move to shared** | `open_worktree_folder_core()` works for any path |
| E | State tracking (`attach_worktree`) | `ensure_worktree()` L1009 | **Move to shared** | DB columns are nullable |
| F | Collision retry | `ensure_worktree()` L991-1003 | **Stay in git path** only | Only relevant to worktree creation |
| — | Non-git path resolution | **NEW** | **Folder-only** | Returns root folder directly, no git ops |

---

## 4. Exact Files / Functions Affected

| File | Function | Change Type | Description |
|------|----------|-------------|-------------|
| `src-tauri/src/work_task/engine.rs` | `launch()` L728-751 | **Edit** | Replace `ensure_worktree()` call with `resolve_execution_target()` |
| `src-tauri/src/work_task/engine.rs` | `ensure_worktree()` | **Rename** → `prepare_git_target()` | Keep all git logic unchanged; only the name changes to reflect it's the git path |
| `src-tauri/src/work_task/engine.rs` | `resolve_execution_target()` | **NEW** | ~15 lines: detect git, branch to git or local path |
| `src-tauri/src/work_task/engine.rs` | `resolve_local_target()` | **NEW** | ~5 lines: return root folder as-is |
| `src-tauri/src/work_task/engine.rs` | `WorktreeRef` struct | **Rename** → `ExecutionTarget` | Add optional `git_info` field |
| `src-tauri/src/work_task/engine.rs` | `existing_worktree()` | **Keep** | Used by merge generation (always git) |
| `src-tauri/src/work_task/engine.rs` | `compose_prompt()` L2371-2391 | **Edit** | Guard block conditional on `git_info` |
| `src-tauri/src/work_task/engine.rs` | `compose_prompt()` L2318-2366 | **Keep** | Merge mode only reached for git tasks |

**Files NOT affected:**
- `src-tauri/src/acp/manager.rs` — `spawn_agent()` unchanged (already takes any path)
- `src-tauri/src/commands/conversations.rs` — `create_conversation_core()` unchanged (already handles non-git)
- `src-tauri/src/commands/folders.rs` — `git_worktree_add()` unchanged
- `src-tauri/src/work_task/git.rs` — all git ops unchanged
- `src-tauri/src/db/service/work_task_service.rs` — `attach_worktree()` unchanged

---

## 5. Estimated LOC Impact

| Category | Count | Notes |
|----------|-------|-------|
| **New code** | ~30 lines | `resolve_execution_target()` (15) + `resolve_local_target()` (5) + `ExecutionTarget` struct (10) |
| **Modified code** | ~15 lines | `launch()` call site (5) + `compose_prompt()` guard condition (10) |
| **Removed code** | 0 lines | No deletion — only moves |
| **Renamed** | ~70 lines | `ensure_worktree()` → `prepare_git_target()` (logic unchanged) |
| **Total changed** | ~45 lines net new/modified | Across 1 file (`engine.rs`) |

---

## 6. Regression Matrix

| Subsystem | Status | Why |
|-----------|--------|-----|
| **Git Workspace** | **UNCHANGED** | `prepare_git_target()` is the old `ensure_worktree()` with a new name. Byte-for-byte identical. |
| **Merge** | **UNCHANGED** | Only reachable for git tasks. `existing_worktree()` unchanged. |
| **Retry** | **UNCHANGED** | Reuses recorded `worktree_folder_id` (git) or folder_id (local). |
| **Return** | **UNCHANGED** | Same worktree/folder reuse logic. |
| **Review** | **UNCHANGED** | Pure DB state machine, no git dependency. |
| **Existing Conversation** | **UNCHANGED** | Not currently supported; plan identifies the seam (see §8). |
| **Queue** | **UNCHANGED** | `pump_folder()` / `claim_for_run()` are git-agnostic. |
| **Automation** | **UNCHANGED** | Separate engine; already handles LocalFolder. |
| **Task Board** | **UNCHANGED** | Already consumes native folder registry. |
| **Folder Registry** | **UNCHANGED** | Already correct. |
| **Chat** | **UNCHANGED** | Separate engine. |
| **Providers** | **UNCHANGED** | Separate engine. |

---

## 7. Risk Assessment

| Risk | Severity | Likelihood | Mitigation |
|------|----------|------------|------------|
| **Git behavior regression** | High | Low | `prepare_git_target()` is a pure rename — no logic change. All existing tests pass. |
| **compose_prompt guard bypass** | Medium | Low | Guard becomes conditional on `git_info.is_some()`. Non-git tasks skip the guard entirely (correct — no branch to protect). |
| **Merge on non-git task** | High | Impossible | Merge mode requires `existing_worktree()` which fails fast for non-git. No path to merge without git. |
| **spawn_agent with non-git path** | Low | Low | Already proven: `spawn_agent()` takes `working_dir: Option<String>` — any path works. |
| **create_conversation_core non-git** | Low | Low | Already proven: `detect_git_branch()` returns `None`, column nullable. Test confirmed. |
| **Upstream merge conflict** | Medium | Medium | Changes are localized to `engine.rs`. No API changes. No new dependencies. |

---

## 8. Existing Conversation — Architectural Seam

**Where it belongs:** Inside `resolve_execution_target()`.

**Current gap:** The task model has `conversation_id` but no `existing_conversation_id` field. The automation engine has `existing_conversation_id` in `AutomationConfig` (`automation.rs:106`).

**The seam:** `LaunchMode` already separates Fresh from Retry/Return/Merge. A new variant:
```rust
LaunchMode::ExistingConversation { conversation_id }
```
would bypass `resolve_execution_target()` entirely (the conversation already has a folder_id) and go straight to resume + spawn in that folder's path.

**Scope note:** This is a separate feature. The non-git execution plan does NOT need to implement it — but the `ExecutionTarget` pattern makes it trivial to add later.

---

## 9. Working Directory Flow — Local Folder Path

```
Task targets folder_id = 42 (Local Folder, path = "/home/user/my-project")
  ↓
launch() gets root = get_folder_core(42) → FolderDetail { id: 42, path: "/home/user/my-project", kind: Regular }
  ↓
resolve_execution_target(task, root)
  ├─ is_git_repo("/home/user/my-project") → false
  └─ resolve_local_target(root)
       └─ ExecutionTarget {
            folder_id: 42,         ← the original folder
            path: "/home/user/my-project",  ← run directly here
            git_info: None,        ← signals non-git
          }
  ↓
spawn_agent(working_dir: Some("/home/user/my-project"))  ← agent runs in the folder
  ↓
create_conversation_core(folder_id: 42)  ← conversation tied to the folder
  ↓
compose_prompt() → skips worktree guard (git_info is None), skips merge instructions
```

**Key insight:** The agent runs DIRECTLY in the user's folder. No isolation. This matches the automation engine's `LocalFolder` behavior (shared_in_root isolation).

---

## 10. Step-by-Step Implementation Order

### Step 1: Add `ExecutionTarget` struct (no behavior change)
- **Where:** `src-tauri/src/work_task/engine.rs` (near `WorktreeRef`)
- **What:** Replace `WorktreeRef` with `ExecutionTarget { folder_id, path, git_info: Option<GitTargetInfo> }`
- **LOC:** ~10 lines
- **Risk:** Pure addition. Zero behavior change.

### Step 2: Rename `ensure_worktree()` → `prepare_git_target()`
- **Where:** `src-tauri/src/work_task/engine.rs`
- **What:** Rename only. Logic is byte-for-byte identical.
- **LOC:** 1 line (function signature)
- **Risk:** Zero. Pure rename.

### Step 3: Add `resolve_local_target()` helper
- **Where:** `src-tauri/src/work_task/engine.rs`
- **What:** ~5 lines: return `ExecutionTarget` from root folder, `git_info: None`
- **LOC:** ~5 lines
- **Risk:** New code, not yet called. Zero behavior change.

### Step 4: Add `resolve_execution_target()` dispatcher
- **Where:** `src-tauri/src/work_task/engine.rs`
- **What:** ~15 lines: `is_git_repo()` check → branch to `prepare_git_target()` or `resolve_local_target()`
- **LOC:** ~15 lines
- **Risk:** New code, not yet called. Zero behavior change.

### Step 5: Update `launch()` call site
- **Where:** `src-tauri/src/work_task/engine.rs` L728-751
- **What:** Replace `ensure_worktree()` call with `resolve_execution_target()`. Update `WorktreeRef` → `ExecutionTarget`.
- **LOC:** ~5 lines changed
- **Risk:** Low. Git path is identical logic. Only new branch for non-git.

### Step 6: Update `compose_prompt()` guard condition
- **Where:** `src-tauri/src/work_task/engine.rs` L2371-2391
- **What:** Make worktree guard conditional on `git_info.is_some()`. Non-git tasks skip it.
- **LOC:** ~10 lines changed
- **Risk:** Low. Non-git tasks get a simpler prompt (no branch guards). Git tasks unchanged.

### Step 7: Update `existing_worktree()` return type
- **Where:** `src-tauri/src/work_task/engine.rs` L1027
- **What:** Return `ExecutionTarget` instead of `WorktreeRef`. Merge generation always has git.
- **LOC:** ~3 lines
- **Risk:** Low. Merge is always git.

### Step 8: Run full test suite
- **Command:** `cargo test --features test-utils`
- **Expected:** All existing tests pass (git behavior unchanged). No new tests needed for git path.

---

## 11. Completion Verification

### MCP tools used:
1. `qartez_map` — Phase 1 Discovery
2. `codebase-memory:search_graph` — Phase 1 Discovery
3. `qartez_calls` — Phase 2 Tracing (launch, compose_prompt callee trees)
4. `qartez_deps` — Phase 2 Tracing (engine file dependencies)
5. `qartez_context` — Phase 2+3 (smart context + impact + test gaps)
6. `qartez_impact` — Phase 3 (blast radius)
7. `qartez_test_gaps` — Phase 4 (test coverage)

### MCP tools available but NOT used (with reason):
- `qartez_read` — parameter binding issue; fell back to Read
- `qartez_refs` — used in prior audit; not needed after qartez_calls covered the same ground
- `qartez_security` — not relevant to implementation planning
- `qartez_wiki` — not relevant to single-feature plan
- `qartez_refactor_plan` — explicitly out of scope (no implementation)
- `qartez_rename`/`qartez_move`/etc. — explicitly out of scope (no code changes)

### Skipped tools with reason:
- `codebase-memory:get_architecture` — used in prior audit; not needed for focused plan
- `codebase-memory:search_code` — grep covered the specific function lookups
- `qartez_understand` — qartez_calls provided sufficient detail
- `qartez_cochange` — qartez_context already returned co-change partners

**Status: COMPLETE** — all 4 phases executed, all responsibilities classified, implementation steps ordered, regression matrix verified.
