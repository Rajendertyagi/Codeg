# Audit: Dissect ensure_worktree()

**Date:** 2026-08-05
**Scope:** `ensure_worktree()` and the full work-task launch pipeline
**Method:** Qartez MCP (`qartez_map`, `qartez_calls`, `qartez_deps`, `qartez_context`, `qartez_impact`, `qartez_test_gaps`) + codebase-memory (`search_graph`) + targeted reads

---

## 1. Complete Call Graph

```
Task Launch
  └─ launch() [engine.rs:654]
       ├─ preflight_folder() [engine.rs:1186] — structural check (reject worktrees)
       ├─ begin_setup() [engine.rs:708] — queued → preparing (CAS)
       ├─ ensure_worktree() [engine.rs:954] ← THE FUNCTION
       │    ├─ get_folder_core() [folders.rs:562] — reuse check
       │    ├─ resolve_git_head() [folders.rs:1077] — requires git
       │    ├─ task_git::rev_parse() [git.rs:38] — requires git
       │    ├─ git_worktree_add() [folders.rs:1843] — requires git
       │    ├─ open_worktree_folder_core() [folders.rs:655] — registers worktree folder
       │    └─ attach_worktree() [work_task_service.rs:729] — records git refs in DB
       ├─ run_init_command() [engine.rs:1046] — runs shell in worktree path
       ├─ spawn_agent() [manager.rs:400] — launches CLI with working_dir
       ├─ create_conversation_core() [conversations.rs:1477] — creates DB row
       ├─ compose_prompt() [engine.rs:2256] — builds prompt blocks
       └─ send_prompt_linked_with_message_id() — sends to agent
```

---

## 2. Complete Responsibility Graph

```
ensure_worktree() [engine.rs:954-1023]
  │
  ├── Responsibility A: Reuse Check
  │     ├─ What: Check if task already has a worktree_folder_id that exists on disk
  │     ├─ Why: Retry/return reuses the same worktree instead of minting a new one
  │     ├─ Git required? NO — pure DB + filesystem check
  │     └─ Could work with normal folder? YES — any folder path works
  │
  ├── Responsibility B: Git Detection + Branch Resolution
  │     ├─ What: resolve_git_head() gets branch name; rev_parse() gets HEAD sha
  │     ├─ Why: Worktree must be pinned to a specific commit (no drift window)
  │     ├─ Git required? YES — fails for non-repo ("not on a branch")
  │     └─ Could work with normal folder? NO — no branch/sha to record
  │
  ├── Responsibility C: Worktree Creation
  │     ├─ What: git_worktree_add() creates an isolated checkout at a sibling path
  │     ├─ Why: Isolation — agent works in its own tree, never touches the base
  │     ├─ Git required? YES — git worktree command requires a repository
  │     └─ Could work with normal folder? NO — no git = no worktree
  │
  ├── Responsibility D: Runtime Folder Registration
  │     ├─ What: open_worktree_folder_core() registers the worktree path as a Codeg folder
  │     ├─ Why: Conversation needs a folder_id FK; sidebar needs to render it
  │     ├─ Git required? NO — registers ANY path as a folder
  │     └─ Could work with normal folder? YES — add_folder() works for any path
  │
  ├── Responsibility E: State Tracking (DB)
  │     ├─ What: attach_worktree() records worktree_folder_id, base_branch, base_sha, work_branch
  │     ├─ Why: Merge generation needs base_branch + base_sha to verify landing
  │     ├─ Git required? NO — pure DB write (columns can be NULL)
  │     └─ Could work with normal folder? YES — columns are nullable
  │
  └── Responsibility F: Retry-on-Collision
        ├─ What: If worktree_add fails (leftover from prior attempt), retry with suffix
        ├─ Why: Crash recovery — a half-created worktree shouldn't block the task
        ├─ Git required? YES — only relevant to git worktree creation
        └─ Could work with normal folder? NO — no collision possible without worktrees
```

---

## 3. Git-Specific Responsibilities

| Responsibility | Function | Git Required? | Why |
|---------------|----------|---------------|-----|
| Branch resolution | `resolve_git_head()` | **YES** | Needs `.git/HEAD` to read branch name |
| SHA pinning | `task_git::rev_parse()` | **YES** | Needs git to resolve HEAD to commit sha |
| Worktree creation | `git_worktree_add()` | **YES** | `git worktree add` requires a repository |
| Collision retry | suffix-based retry | **YES** | Only relevant to worktree creation |
| Merge verification | `merge_landed_commit()` | **YES** | Uses `is_ancestor`, `trees_equal` |
| Merge prompt | `LaunchMode::Merge` branch in `compose_prompt()` | **YES** | Instructs agent to run git merge commands |
| Worktree guard prompt | `compose_prompt()` guard block | **YES** | Tells agent to NOT merge/push base branch |

---

## 4. Non-Git Responsibilities

| Responsibility | Function | Git Required? | Why |
|---------------|----------|---------------|-----|
| Reuse check | `get_folder_core()` + `Path::exists()` | NO | Pure DB + filesystem |
| Folder registration | `open_worktree_folder_core()` | NO | Registers any path as a folder |
| State tracking | `attach_worktree()` | NO | DB write, columns nullable |
| Agent spawn | `spawn_agent()` | NO | Takes `working_dir: Option<String>` — any path |
| Conversation creation | `create_conversation_core()` | NO | `detect_git_branch()` returns `None` for non-git |
| Init command | `run_init_command()` | NO | Runs shell in any path |
| Fresh/Retry/Return prompt | `compose_prompt()` non-merge branches | NO | Task description + feedback, no git ops |
| Stage prompts | `stage_prompt_block()` | NO | User-authored, no git dependency |

---

## 5. Working Directory Flow

```
ensure_worktree() returns WorktreeRef { folder_id, path }
  │
  ├─ path → used as:
  │    ├─ spawn_agent(working_dir: Some(wt.path.clone())) [engine.rs:806]
  │    │    └─ spawn_agent_connection(working_dir, ...) [connection.rs:1098]
  │    │         └─ Agent CLI launched with --cwd <path>
  │    ├─ run_init_command(cwd: &wt.path) [engine.rs:745]
  │    └─ compose_prompt() references wt.path as root_path for merge
  │
  └─ folder_id → used as:
       ├─ create_conversation_core(wt.folder_id, ...) [engine.rs:854]
       └─ emit_folder_upsert(wt.folder_id) [engine.rs:768]
```

**Key finding:** `spawn_agent()` takes `working_dir: Option<String>` — it does NOT require a worktree. It passes the path straight to `spawn_agent_connection()` which launches the agent CLI with `--cwd <path>`. Any valid directory works.

---

## 6. Conversation Flow

```
create_conversation_core(folder_id, agent_type, title) [conversations.rs:1477]
  │
  ├─ detect_git_branch(&folder.path) [conversations.rs:1487]
  │    └─ git rev-parse --abbrev-ref HEAD
  │    └─ Returns None if: git not installed, not a repo, detached HEAD, unborn branch
  │    └─ Test confirmed: create_conversation_core_non_git_path_yields_no_branch
  │
  └─ conversation_service::create(folder_id, agent_type, title, git_branch)
       └─ DB INSERT — git_branch column is nullable
```

**Key finding:** Conversation creation does NOT require git. `detect_git_branch()` gracefully returns `None` for non-repo folders. The `git_branch` column is nullable. The conversation is tied to a `folder_id`, not to git.

---

## 7. Prompt Flow

```
compose_prompt(cfg, task, mode, settings, resumed, conn) [engine.rs:2256-2398]
  │
  ├── LaunchMode::Fresh
  │    └─ Replays task.prompt_blocks (user's task description)
  │    └─ GIT? NO — pure user content
  │
  ├── LaunchMode::Retry
  │    └─ "Continue working in this worktree" + original task if not resumed
  │    └─ GIT? NO — references worktree but no git commands
  │
  ├── LaunchMode::Return(feedback)
  │    └─ User feedback + "Address it in this same worktree"
  │    └─ GIT? NO — references worktree but no git commands
  │
  ├── LaunchMode::Merge { root_path, base_branch, work_branch, strategy, message }
  │    └─ Full git merge instructions: commit, merge, land, commit message
  │    └─ GIT? YES — fundamentally git operations
  │
  ├── Worktree guard block (appended to ALL non-merge modes) [engine.rs:2371-2391]
  │    └─ "You are working inside a dedicated git worktree... do NOT merge into, rebase onto, or push the base branch"
  │    └─ References task.work_branch and task.base_branch
  │    └─ GIT? YES — assumes worktree + branch exist
  │
  └── Stage prompts (appended last) [engine.rs:2396]
       └─ User-authored instructions from folder settings
       └─ GIT? NO — pure user content
```

**Key finding:** Only the Merge mode prompt and the worktree guard block are git-specific. Fresh/Retry/Return prompts reference the worktree path but issue no git commands. For non-Git execution, the guard block could be replaced with a simpler "work in this folder" instruction.

---

## 8. Retry / Resume / Merge Dependency Table

| Operation | Requires Git? | Requires Previous Conversation? | Requires Worktree? | Evidence |
|-----------|--------------|-------------------------------|-------------------|----------|
| **Retry** | NO (but current impl reuses worktree) | NO (fresh session if no conversation) | Current: YES (existing_worktree) / Could be: NO | `launch_mode_for()` → Retry if `conversation_id.is_some()` [engine.rs:2211] |
| **Resume** | NO | YES (needs `external_id` from prior conversation) | Current: YES / Could be: NO | `resume_session_id` from `task.conversation_id.external_id` [engine.rs:776-785] |
| **Merge** | **YES** (fundamentally) | YES (needs prior work) | **YES** (must exist, never minted fresh) | `existing_worktree()` [engine.rs:1027] + `merge_landed_commit()` [engine.rs:1715] |
| **Return** | NO (but references worktree) | YES (needs prior conversation) | Current: YES / Could be: NO | `LaunchMode::Return(feedback)` [engine.rs:2299] |
| **Review** | NO | NO | NO | Settled by `on_turn_complete()` — pure DB state machine |
| **Fresh** | NO | NO | Current: YES / Could be: NO | `LaunchMode::Fresh` — no prior state needed |

---

## 9. Exact Minimum Code That Truly Requires Git

| Code | Location | Why Git Is Fundamental |
|------|----------|----------------------|
| `resolve_git_head(&root.path)` | engine.rs:970 | Reads `.git/HEAD` — fails for non-repo |
| `task_git::rev_parse(&root.path, "HEAD")` | engine.rs:974 | Resolves HEAD to commit sha |
| `git_worktree_add(root, branch, path, base_sha)` | engine.rs:983 | Creates git worktree |
| `attach_worktree()` recording base_branch/base_sha/work_branch | engine.rs:1009 | Records git refs (could be NULL) |
| `existing_worktree()` for merge generation | engine.rs:1027 | Merge needs the worktree to exist |
| `compose_prompt()` Merge branch | engine.rs:2318-2366 | Instructs agent to run git merge |
| `compose_prompt()` worktree guard block | engine.rs:2371-2391 | Tells agent git worktree constraints |
| `merge_landed_commit()` | engine.rs:1715 | Verifies merge via `is_ancestor` + `trees_equal` |
| `settle_merge_generation()` | engine.rs:1650 | Recovers merge from git truth |
| `recover_merging()` | engine.rs:1807 | Crash recovery for merge via git |
| `cleanup_task()` → `remove_worktree_locked()` | engine.rs:1881 | `git worktree remove` + branch delete |
| `snapshot_diff_stats()` | engine.rs:1509 | `git diff --numstat` for changed files |
| `task_git::*` functions | git.rs | All git CLI wrappers |

---

## 10. Exact Minimum Code That Could Execute in a Normal Folder

| Code | Location | Why It Works Without Git |
|------|----------|-------------------------|
| Reuse check (folder exists) | engine.rs:959-968 | Pure filesystem check |
| `spawn_agent(working_dir: Some(path))` | manager.rs:400 | Takes any path as `--cwd` |
| `create_conversation_core(folder_id, ...)` | conversations.rs:1477 | `detect_git_branch()` returns `None` for non-git |
| `run_init_command(cwd: &path)` | engine.rs:1046 | Runs shell in any directory |
| `compose_prompt()` Fresh/Retry/Return | engine.rs:2272-2317 | User content + feedback, no git ops |
| `stage_prompt_block()` | engine.rs:2402 | User-authored, no git dependency |
| `attach_worktree()` with NULL refs | engine.rs:1009 | Columns are nullable |
| `mark_running()` / `mark_merging_live()` | engine.rs:878 | Pure DB state machine |
| `on_turn_complete()` settlement | engine.rs:1234 | DB CAS updates |
| `preflight_folder()` | engine.rs:1186 | Structural check (reject worktrees), not git |
| `pump_folder()` / `claim_for_run()` | engine.rs:490 | Queue management, no git |

---

## 11. Existing Conversation — Architectural Seam

Could Existing Conversation fit WITHOUT touching Git?

**YES.** The seams already exist:

1. `spawn_agent()` takes `working_dir: Option<String>` — any folder path works
2. `create_conversation_core()` takes `folder_id: i32` — any folder works
3. `resume_session_id` is already plumbed through `launch()` [engine.rs:773-786]
4. The automation engine already has `existing_conversation_id` in `AutomationConfig` [automation.rs:106]

The only blocker: `ensure_worktree()` runs BEFORE spawn/conversation. If a task targets an existing conversation in a non-git folder, the launch would fail at `ensure_worktree()` before it ever reaches the resume logic.

**Architectural observation:** The `LaunchMode` enum already separates Fresh from Retry/Return/Merge. A `LaunchMode::ExistingConversation { conversation_id, folder_id }` variant could bypass `ensure_worktree()` entirely and go straight to resume + spawn in the folder's path.

---

## 12. Core Finding: ensure_worktree() Is NOT One Responsibility

`ensure_worktree()` currently packs **6 unrelated responsibilities** into one function:

| # | Responsibility | Git? | Independently testable? |
|---|---------------|------|------------------------|
| A | Reuse check | NO | YES |
| B | Git detection | YES | YES |
| C | Worktree creation | YES | YES |
| D | Folder registration | NO | YES |
| E | State tracking | NO | YES |
| F | Collision retry | YES | YES |

The function is 70 lines long. Only responsibilities B, C, and F truly require git. Responsibilities A, D, and E are git-agnostic infrastructure that could serve ANY folder type.

---

## 13. Completion Verification

### MCP tools used:
1. `qartez_map` — Phase 1 Discovery (engine landscape)
2. `codebase-memory:search_graph` — Phase 1 Discovery (semantic search for launch pipeline)
3. `qartez_calls` — Phase 2 Tracing (ensure_worktree, compose_prompt, spawn_agent call hierarchies)
4. `qartez_deps` — Phase 2 Tracing (engine file dependencies)
5. `qartez_context` — Phase 2+3 (smart context + impact + test gaps)
6. `qartez_impact` — Phase 3 (blast radius of engine changes)
7. `qartez_test_gaps` — Phase 4 (test coverage verification)

### MCP tools available but NOT used (with reason):
- `qartez_read` — parameter binding issue (tool expects `symbol_name` but schema shows `symbols`); fell back to Read
- `qartez_refs` — used earlier in prior session; not needed after qartez_calls covered the same ground
- `qartez_security` — not relevant to architecture audit
- `qartez_wiki` — not relevant to single-function dissection
- `qartez_refactor_plan` — explicitly out of scope (no implementation)
- `qartez_rename`/`qartez_move`/etc. — explicitly out of scope (no code changes)

### Skipped tools with reason:
- `codebase-memory:get_architecture` — used in prior audit; not needed for single-function focus
- `codebase-memory:search_code` — grep covered the specific function lookups needed
- `qartez_understand` — qartez_calls provided sufficient detail
- `qartez_cochange` — qartez_context already returned co-change partners
- `qartez_hotspots`/`qartez_smells` — not relevant to responsibility classification

**Status: COMPLETE** — all 4 phases executed, all responsibilities classified with repository evidence.
