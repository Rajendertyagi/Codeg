# Minimum Change Review: Non-Git Execution

**Date:** 2026-08-05
**Objective:** Challenge every abstraction in the original plan. Find the smallest possible diff.

---

## 1. Abstraction Audit: What Can Be Removed

### ❌ ExecutionTarget struct — REMOVE

**Proposed:** New `ExecutionTarget { folder_id, path, git_info }` struct.

**Challenge:** `WorktreeRef` already has exactly `{ folder_id, path }`. For a local folder, `folder_id = root.id`, `path = root.path`. No new struct needed.

**Evidence:**
```rust
// engine.rs:2202 — already exists
struct WorktreeRef {
    folder_id: i32,
    path: String,
}
```

**Verdict:** REJECT. Reuse `WorktreeRef`.

---

### ❌ resolve_execution_target() dispatcher — REMOVE

**Proposed:** New ~15-line dispatcher function.

**Challenge:** `launch()` already has `root: FolderDetail`. The check is 3 lines inline:

```rust
let wt = if is_git_repo(&root.path) {
    self.ensure_worktree(&task, &root).await?
} else {
    WorktreeRef { folder_id: root.id, path: root.path }
};
```

**Verdict:** REJECT. Inline the check in `launch()`.

---

### ❌ Rename ensure_worktree() → prepare_git_target() — REMOVE

**Proposed:** Rename for clarity.

**Challenge:** The rename provides zero functional value. `ensure_worktree()` is only called for git folders now, but its name still accurately describes what it does. Renaming forces changes to all call sites for cosmetic benefit only.

**Evidence:** `ensure_worktree()` has 1 caller (`launch()` at L731). The call site changes regardless (to add the `if` branch). The function body doesn't change at all.

**Verdict:** REJECT. Keep `ensure_worktree()` unchanged.

---

### ❌ resolve_local_target() helper — REMOVE

**Proposed:** New ~5-line helper.

**Challenge:** The "local target" is just `WorktreeRef { folder_id: root.id, path: root.path }`. That's 3 lines. A helper function for 3 lines is overhead.

**Verdict:** REJECT. Construct `WorktreeRef` inline.

---

### ❌ WorktreeRef → ExecutionTarget rename — REMOVE

**Proposed:** Rename the struct.

**Challenge:** No functional value. `WorktreeRef` already works for both cases.

**Verdict:** REJECT. Keep `WorktreeRef`.

---

### ✅ compose_prompt() guard skip — KEEP (but simplify)

**Proposed:** Add `is_git` parameter to `compose_prompt()`.

**Challenge:** Can avoid even a parameter change. The guard references `task.work_branch` and `task.base_branch`. For a local folder, `attach_worktree()` is never called, so these are NULL. Skip the guard when `task.work_branch.is_some()` — no new parameter needed.

**Evidence:**
```rust
// compose_prompt() L2371 — current condition:
if !matches!(mode, LaunchMode::Merge { .. }) {

// Minimum change — add one clause:
if !matches!(mode, LaunchMode::Merge { .. }) && task.work_branch.is_some() {
```

**Verdict:** KEEP the guard skip, but use existing `task.work_branch.is_some()` instead of adding a parameter.

---

## 2. The Absolute Minimum Implementation

### Changes

**File:** `src-tauri/src/work_task/engine.rs`

**Change 1 — Add import (1 line):**
```rust
use crate::git_repo::is_git_repo;
```

**Change 2 — Replace worktree section in `launch()` (~20 lines → ~10 lines):**

Current (L728-751):
```rust
let wt = if matches!(mode, LaunchMode::Merge { .. }) {
    self.existing_worktree(&task).await?
} else {
    let wt = self.ensure_worktree(&task, &root).await?;
    // init command section...
    wt
};
```

Minimum:
```rust
let wt = if matches!(mode, LaunchMode::Merge { .. }) {
    self.existing_worktree(&task).await?
} else if is_git_repo(&root.path) {
    self.ensure_worktree(&task, &root).await?
} else {
    WorktreeRef { folder_id: root.id, path: root.path }
};
// init command section UNCHANGED (runs on wt.path for both cases)
```

**Change 3 — Guard condition in `compose_prompt()` (1 line):**

Current (L2371):
```rust
if !matches!(mode, LaunchMode::Merge { .. }) {
```

Minimum:
```rust
if !matches!(mode, LaunchMode::Merge { .. }) && task.work_branch.is_some() {
```

### Total Impact

| Metric | Original Plan | Minimum |
|--------|--------------|---------|
| Files changed | 1 | 1 |
| Functions changed | 6 | 2 |
| New structs | 1 | 0 |
| New functions | 3 | 0 |
| Renames | 2 | 0 |
| LOC changed | ~45 | ~12 |
| New abstractions | 4 | 0 |

---

## 3. Before vs After LOC

### Before (current code)
```
launch() worktree section:     24 lines (L728-751)
compose_prompt() guard:         1 line  (L2371)
                              = 25 lines total
```

### After (minimum)
```
launch() worktree section:     12 lines (net -12)
compose_prompt() guard:         1 line  (net +0, just added && clause)
new import:                     1 line  (net +1)
                              = 13 lines total
```

**Net change: ~12 lines modified, 0 lines added (structs/functions).**

---

## 4. Exact Files/Functions Affected

| File | Function | Change |
|------|----------|--------|
| `src-tauri/src/work_task/engine.rs` | `launch()` L728-751 | Add `is_git_repo()` branch |
| `src-tauri/src/work_task/engine.rs` | `compose_prompt()` L2371 | Add `&& task.work_branch.is_some()` |
| `src-tauri/src/work_task/engine.rs` | imports | Add `use crate::git_repo::is_git_repo;` |

**Nothing else changes.** `ensure_worktree()`, `existing_worktree()`, `WorktreeRef`, `spawn_agent()`, `create_conversation_core()` — all untouched.

---

## 5. Plan A vs Plan B Comparison

| Dimension | Plan A (Original) | Plan B (Minimum) |
|-----------|-------------------|------------------|
| Files changed | 1 | 1 |
| Functions changed | 6 | 2 |
| New structs | 1 (`ExecutionTarget`) | 0 |
| New functions | 3 (`resolve_execution_target`, `resolve_local_target`, `prepare_git_target`) | 0 |
| Renames | 2 (`ensure_worktree`→`prepare_git_target`, `WorktreeRef`→`ExecutionTarget`) | 0 |
| LOC | ~45 | ~12 |
| New abstractions | 4 | 0 |
| Merge conflict risk | Medium (touches 6 functions) | Low (touches 2 functions) |
| Review complexity | Medium (new struct + dispatcher + renames) | Low (one if branch + one && clause) |
| Cognitive complexity | Medium (new pattern to understand) | Low (obvious runtime check) |
| Future maintenance | New abstraction to maintain | No new code to maintain |
| Git behavior | Identical | Identical |

---

## 6. Regression Matrix

| Subsystem | Status | Why |
|-----------|--------|-----|
| Git Workspace | **UNCHANGED** | `is_git_repo()` returns true → `ensure_worktree()` called exactly as before |
| Merge | **UNCHANGED** | Only reachable for git tasks (`existing_worktree()` requires worktree) |
| Retry | **UNCHANGED** | Reuses recorded `worktree_folder_id` (git) or folder_id (local) |
| Return | **UNCHANGED** | Same reuse logic |
| Review | **UNCHANGED** | Pure DB state machine |
| Queue | **UNCHANGED** | Git-agnostic |
| Automation | **UNCHANGED** | Separate engine |
| Task Board | **UNCHANGED** | Already consumes native folder registry |
| Folder Registry | **UNCHANGED** | Already correct |
| Chat | **UNCHANGED** | Separate engine |
| Providers | **UNCHANGED** | Separate engine |

---

## 7. Why This Is The Minimum

1. **No new struct** — `WorktreeRef { folder_id, path }` already represents both cases.

2. **No new function** — the git check is a single `if` clause, not a dispatcher.

3. **No rename** — `ensure_worktree()` keeps its name and body.

4. **No signature change** — `compose_prompt()` keeps its parameters; the guard uses existing `task.work_branch.is_some()`.

5. **No new import beyond one line** — `is_git_repo` from `crate::git_repo`.

6. **The init command section is untouched** — it runs on `wt.path` which is correct for both git and local.

7. **The spawn/conversation sections are untouched** — they use `wt.folder_id` and `wt.path` which work for both.

---

## 8. Final Recommendation

**Use Plan B (Minimum).**

The original plan was over-engineered. It introduced 4 new abstractions to solve a problem that requires:
- One `if` branch in `launch()`
- One `&&` clause in `compose_prompt()`
- One import

The minimum implementation is **4x smaller** (12 vs 45 lines), introduces **zero new concepts**, and is **impossible to make smaller** without removing functionality.

---

## 9. Completion Verification

### MCP tools used:
1. `codebase-memory:search_graph` — verified `is_git_repo`, `WorktreeRef`, `compose_prompt` locations
2. `qartez:qartez_calls` — verified `compose_prompt` callers (11 callers, 1 production)

### MCP tools available but NOT used (with reason):
- `qartez_map` — used in prior audit; not needed for this focused review
- `qartez_read` — parameter binding issue; fell back to Read
- `qartez_refs` — not needed; `qartez_calls` covered the same ground
- `qartez_impact` — used in prior audit; co-change partners already known
- `qartez_context` — used in prior audit; impact/test gaps already known
- All others — not relevant to minimum-change review

### Skipped tools with reason:
- `qartez_deps` — already verified in prior audit
- `qartez_test_gaps` — already verified in prior audit
- `qartez_understand` — `qartez_calls` provided sufficient detail

**Status: COMPLETE.**
