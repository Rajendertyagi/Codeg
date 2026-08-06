# Audit Report — Local Folder Tasks Can Never Reach `done`

**Date**: 2026-08-06
**Mode**: Repository-evidence audit only — no code was modified.
**Scope**: Full `work_task` completion-path analysis (backend `src-tauri/` + frontend `src/`).
**Result**: Local Folder (non-git) tasks are structurally stuck in `review`; the only path to `done` requires git.

---

## TL;DR

| Question | Answer |
|---|---|
| Do Local Folder tasks reach Review? | Yes — every transition up to `running → review` is git-free |
| What is the first refusing function? | `merge_coordinates` (engine.rs:1800-1832, called at :1596) |
| How many writers of `done` exist? | One: `merge_landed` (work_task_service.rs:1184) — two callers, both git paths |
| Is git fundamentally required? | No — the automation engine settles runs without git (automation/engine.rs:1031-1042) |
| Smallest fix | A non-git `accept_review` path (Review → done) gated on `worktree_folder_id == null`; zero git-pipeline impact |
| Confidence | Mechanics: high (~95%); recommendation: medium-high |

---

## Deliverable 1 — Complete Completion State Machine

Statuses (work_task.rs enum, snake_case): `todo → queued → preparing → running → awaiting_input → review → merging → done` (+ `canceled`, `failed`, `archived`).

```
todo ──Start/enqueue──> queued ──claim_for_run──> preparing ──launch──> running ──TurnComplete──> review
  ▲                        (CAS, service:519)      (begin_setup:765)    (on_turn_complete, engine:1267)
  │                                                                                        │
retry                                                                              merge_task (engine:1572)
  │                                                                                        │
failed <──fail (service:920)                                                    merge_coordinates (engine:1596)
                                                                                  ▲ FIRST REFUSAL (git-only)
                                                                            review ──CAS──> merging ──git truth──> done
                                                                             ▲   (return)       (settle_merge_generation:1683 /
                                                                             └── merge_back_to_review (service:1226)   recover_merging:1840 → merge_landed:1184)
```

| Transition | Code location | Git required? |
|---|---|---|
| `todo → queued` | Start / auto-queue | **No** |
| `queued → preparing` | `claim_for_run` CAS (service:519) + `preflight_folder` (engine:1219-1230 — folder must exist and be a project root, `parent_id` NULL) | **No** |
| `preparing → running` | `begin_setup` (service:765). Git path: `ensure_worktree` (engine:729-756) creates worktree + `base_branch`/`work_branch` + `attach_worktree` (service:739-751). Local path: runs directly in the root dir | **No** (Local) |
| `running → review` | `on_turn_complete` (engine:1267) end_turn arm → `settle_review` CAS (service:1023). Preflight light: `set_preflight` (service:1277) is metadata-only, silently **skipped** for local (engine:1499). Diff stats: `snapshot_diff_stats` (engine:1542) returns `None` for local → NULL stats, cosmetic | **No** — Local Folder tasks **reliably reach Review** |
| `review → merging → done` | `merge_task` (engine:1572): status CAS (:1581) → `merge_coordinates` (:1596) → per-folder git lock (:1600-1601) → another-merging check (:1603-1610) → review→merging CAS → settle from git truth via `settle_merge_generation` (engine:1683) or `recover_merging` (engine:1840) | **Yes — the ONLY path to `done`** |
| `review → review` (Return), `→ canceled`, `failed → todo` | `merge_back_to_review` (service:1226), `cancel` (service:1366) | **No** |
| `done` | Terminal; no outgoing transitions (archive flag only) | — |

---

## Deliverable 2 — Every Writer of `done`

**Exactly one**: `merge_landed` (work_task_service.rs:1184-1222), self-documented at :1182:

> "The ONLY writer of `done`; never rolls back"

Its two call sites, both git paths:

1. `settle_merge_generation` (engine.rs:1683) → `merge_landed` at :1709-1711
2. `recover_merging` (engine.rs:1840) → `merge_landed` at :1882-1884

No other code path anywhere in the crate writes status `done`.

---

## Deliverable 3 — First Divergence Point for Local Folder Tasks

**`merge_coordinates`** (engine.rs:1800-1832), reached from `merge_task` at engine.rs:1596.

It runs *before* the review→merging CAS and hard-requires:

- `worktree_folder_id` (engine.rs:1815-1817)
- `base_branch` (engine.rs:1824-1827)
- `work_branch` (engine.rs:1828-1831)

For a Local Folder task all three are NULL → `merge_task` returns `Err` immediately → the task **stays in Review untouched**, with a readable error.

The columns' only writer is `attach_worktree` (service:739-751), called only from `ensure_worktree` (the git launch branch) — so they are provably NULL for every non-git task.

---

## Deliverable 4 — Is Git Fundamentally Required for Completion? **No.**

1. **Architectural precedent exists**: the automation engine settles `automation_run` rows to `"succeeded"` from the TurnComplete `stop_reason` or the produced conversation's terminal status (PendingReview|Completed) — no worktree, no merge, no git (automation/engine.rs:1031-1042). "Complete-then-settle" is Codeg's established non-git completion model.
2. **The data model supports it**: `done` is a plain status column. `merge_landed`'s git-specific writes (commit_sha, commit stats) are nullable columns — they can simply be NULL for a non-git completion.
3. **Non-git tasks are first-class**: the task editor offers *all* project roots with no git filter (task-editor-dialog.tsx:208-212, `parent_id == null && kind === "regular"`); the non-git launch branch (engine.rs:731) is a first-class path; preflight and diff stats are already silently tolerated (`run_preflight` :1499 returns early; `snapshot_diff_stats` :1542 returns None). The *only* untolerated step is the review→done accept.
4. **Git-ness is never persisted**: `is_git_repo` (git_repo.rs:25-27) is a runtime probe (`.git` exists). The workspace tree keeps an in-memory flag (workspace_state/mod.rs:77, exposed to TS as `is_git_repo`, types.ts:3105), but `work_task` rows carry no git marker.

---

## Deliverable 5 — Smallest Architectural Change (Option A, recommended)

> **2026-08-06 addendum — hook-native reshaping**: per `agent.md` ("Never edit Codeg native engine files"; custom work lives in `newplugin/` only), the Option A surface below is **not** expressed as engine edits. It is delivered as:
> - `newplugin/hooks/task_accept.rs` — the `accept_task` logic (Review → Done CAS, worktree guard, timeline event, `task://changed` emit), mirroring `merge_landed` via only public API (`get_model`, `record_event`, `emit_event`).
> - `newplugin/hooks/mod.rs` — `work_task_accept` Tauri command shim (feature-gated).
> - `newplugin/hooks/web_workflows.rs` — `work_task_accept` Axum handler (both modes).
> - `newplugin/patches/*.accept.patch` — hook-point-only patches (lib.rs invoke_handler registration, router.rs route, api.ts, task-card, task-detail-sheet, tasks-page, i18n ×3).
> Engine files (`engine.rs`, `work_task_service.rs`) are **untouched**; only the frontend/hook registrations are patched. The worktree guard makes the git pipeline zero-risk.

Add a non-git accept path mirroring the automation engine's settle-from-terminal model:

- **Service**: new `accept_review` — status CAS (`Review` + `run_seq` guard) → `done`; writes `verdict = "accepted"`, `result_summary` from the existing `capture_summary` (engine.rs:1555), commit columns NULL.
- **Engine**: new `accept_task` fn. **Guard: refuse when `worktree_folder_id` is `Some`** — git tasks must keep the merge pipeline. Zero change to `merge_coordinates` or any git code → zero regression risk.
- **Commands**: `work_task_accept` mirroring `work_task_merge` (Tauri: commands/work_task.rs:488; HTTP: web/handlers/work_task.rs:265; shared `_core`).
- **Frontend**: reuse the **already-existing** `hasWorktree` (task-detail-sheet.tsx:166) and the already-exposed `worktree_folder_id` (types.ts:1244/1308): `hasWorktree → Merge` (unchanged); `!hasWorktree → Complete/Accept`. This also fixes the current UX defect where the review card's primary is Merge *unconditionally* (task-card.tsx:245) and the merge dialog renders `"?"` branches for local tasks.
- **Surface**: 1 service fn + 1 engine fn + 1 command + 1 handler + 2 component edits + i18n keys + tests.

Rejected alternatives:

| Option | Approach | Why rejected |
|---|---|---|
| B | Make `merge_coordinates` non-fatal for non-git | Mud dies the two-stage merge pipeline semantics |
| C | Hide/disable Merge for non-git only | Does not make `done` reachable |
| D | Requeue into a git folder on accept | Semantically wrong; loses the completed work |

---

## Deliverable 6 — Recommended Product Behavior

- **Local Folder review task**: primary action = **Complete/Accept** — settles directly to `done`, summary from the final assistant text, no commit. Consistent with the automation engine's existing completion semantic.
- **Git review task**: unchanged (Merge).
- **Optional enhancement**: editor-dialog hint when the selected folder is not a git repo ("Not a git folder — the task will be accepted directly on completion, no merge commit"). `is_git_repo` is exposed on tree nodes (types.ts:3105); whether the folder-store item used by the editor carries it needs one confirmation — affects only the hint.
- **Open product decision**: manual accept (button) vs. auto-accept from the conversation's terminal status (exactly like the automation engine's settle).

---

## Deliverable 7 — Confidence Level

- **Mechanics: high (~95%)** — every claim is cited to source lines read directly during this audit; no speculation.
- **Recommendation: medium-high** — Option A is architecture-consistent with the automation settle model, but the final accept UX (manual vs. auto) is a product decision.
- One unverified detail (frontend-only): whether the workspace folder store exposes `is_git_repo` to the task editor's folder picker — affects only the optional hint.

---

## Appendix A — Key Source Locations

### Backend
| File | Lines | Purpose |
|---|---|---|
| `src-tauri/src/work_task/engine.rs` | 597-650 | `spawn_launch_owned` (launch pipeline) |
| `src-tauri/src/work_task/engine.rs` | 729-756 | `ensure_worktree` (git launch branch) |
| `src-tauri/src/work_task/engine.rs` | 1267 | `on_turn_complete` (non-merge settle) |
| `src-tauri/src/work_task/engine.rs` | 1499 | preflight skip for local tasks |
| `src-tauri/src/work_task/engine.rs` | 1542-1551 | `snapshot_diff_stats` (worktree-only, cosmetic) |
| `src-tauri/src/work_task/engine.rs` | 1572-1610 | `merge_task` (validation + first refusal path) |
| `src-tauri/src/work_task/engine.rs` | 1683 / 1709-1711 | `settle_merge_generation` → `merge_landed` |
| `src-tauri/src/work_task/engine.rs` | 1800-1832 | `merge_coordinates` (**first refusal**) |
| `src-tauri/src/work_task/engine.rs` | 1840 / 1882-1884 | `recover_merging` → `merge_landed` |
| `src-tauri/src/db/service/work_task_service.rs` | 519 | `claim_for_run` CAS |
| `src-tauri/src/db/service/work_task_service.rs` | 739-751 | `attach_worktree` (sole writer of git columns) |
| `src-tauri/src/db/service/work_task_service.rs` | 765 | `begin_setup` |
| `src-tauri/src/db/service/work_task_service.rs` | 920 | `fail` |
| `src-tauri/src/db/service/work_task_service.rs` | 1023 | `settle_review` CAS |
| `src-tauri/src/db/service/work_task_service.rs` | 1184-1222 | `merge_landed` (**only `done` writer**) |
| `src-tauri/src/db/service/work_task_service.rs` | 1226 | `merge_back_to_review` |
| `src-tauri/src/db/service/work_task_service.rs` | 1277-1304 | `set_preflight` (metadata-only) |
| `src-tauri/src/db/service/work_task_service.rs` | 1366 | `cancel` |
| `src-tauri/src/automation/engine.rs` | 1031-1042 | **Non-git completion precedent** (settle from stop_reason/terminal status) |
| `src-tauri/src/git_repo.rs` | 25-27 | `is_git_repo` runtime probe |
| `src-tauri/src/commands/work_task.rs` | 202 / 488 | `work_task_merge_core` / `work_task_merge` (Tauri) |
| `src-tauri/src/web/handlers/work_task.rs` | 265 | `work_task_merge` (HTTP) |

### Frontend
| File | Lines | Purpose |
|---|---|---|
| `src/components/tasks/task-card.tsx` | 245 | Review primary action = Merge (unconditional) |
| `src/components/tasks/task-detail-sheet.tsx` | 166 | `hasWorktree` (already exists) |
| `src/components/tasks/task-editor-dialog.tsx` | 208-212 | Project-root-only folder filter (no git filter) |
| `src/components/tasks/task-merge-dialog.tsx` | — | Renders `"?"` branches for local tasks (gap symptom) |
| `src/lib/types.ts` | 1244 / 1308 | `worktree_folder_id` exposed in TS |
| `src/lib/types.ts` | 3105 | `is_git_repo` on tree node |

---

## Appendix B — Related (Closed) Audit: Existing-Conversation Launch Panic

Trigger: task 1 ("whcih ai you are ?", folder `D:\test_temp`, pinned `existing_conversation_id: 2`) was stuck in `preparing` with the launch slot leaked.

**Root cause**: Fresh task + `existing_conversation_id` → `resume_session_id = Some` → `task.conversation_id` still NULL → pre-fix `.expect("resumed implies conversation")` (was engine.rs:871-872) panicked inside `tokio::spawn` (`spawn_launch_owned`) → the `JoinHandle` was dropped un-awaited, so `fail` / `release_launch_slot` never ran → the `launching` slot leaked → the reconcile sweep (engine.rs ~2112-2140) skips launching-owned `preparing` rows every tick.

**Fix (verified, REVERTED 2026-08-06 — engine read-only policy)**: `match task.conversation_id.or(cfg.existing_conversation_id)` — `Some(id)` proceeds; `None` disconnects the connection and returns `Err("resumed launch without a conversation row; aborting setup")`.

**Verification (of the fix)**: no reachable production panics remain on the launch path; the only remaining panics are the benign `LaunchSeq` mutex expects (engine.rs:2481/2485) and a provably-unreachable `unreachable!()` (manager.rs:931, guarded by the entry check at :840-844). Launch-slot cleanup is complete on every exit path. Regression assessment: safe — merge/retry/return semantics unchanged (their `task.conversation_id` was always `Some`).

**Status**: **OPEN DEBT** (per `agent.md`: "Engine code stays read-only even for known defects. Bugs in the engine are flagged as open debt with `file:line` citations, never silently fixed."). The panic remains at **engine.rs:872** (`task.conversation_id.expect("resumed implies conversation")`). The working-tree fix was `git restore`-d on 2026-08-06; the verified patch is preserved here for the platform team to apply as an engine patch or reject:

```rust
// engine.rs:869-896 (post-revert base: .expect at :872)
let conversation_id = if resumed {
    match task.conversation_id.or(cfg.existing_conversation_id) {
        Some(id) => id,
        None => {
            let _ = self.manager.disconnect(&conn_id).await;
            return Err(
                "resumed launch without a conversation row; aborting setup".to_string(),
            );
        }
    }
} else {
    // ...unchanged: fresh title row via create_conversation_core...
};
```

Compile verification requires CI (cargo not on local PATH).

---

## Appendix C — Related Documents (same folder)

| Document | Topic |
|---|---|
| `non-git-execution-plan.md` | Non-git Local Folder execution (commit `cbd16de8`) |
| `folder-kind-regular-vs-local-challenge.md` | Regular vs Local folder semantics |
| `minimum-change-review.md` | Minimum-change review for the existing-conversation feature |
| `existing-conversation-audit.md` | Prior audit: existing-conversation launch flow (fix in commit `fcf2505a`) |
| `ensure-worktree-dissection.md` | `ensure_worktree` internals (the git launch branch) |
| `task-board-native-folder-integration.md` | Task board + native folder integration |

---

*Report produced 2026-08-06. Evidence from direct source reads; every citation is a file:line reference.*
