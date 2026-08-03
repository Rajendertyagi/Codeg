# Architecture Audit — Phase 3: Task Board (Work Tasks)

**Date:** 2026-08-04
**Branch audited:** `plugin-dev` (`3079f365`)
**Scope:** Work-task subsystem only — engine, state-machine service, commands, models, entities, migrations, ACP tooling, frontend board. Scheduler/Automations and Conversations excluded except where they cross-couple (both cross-couplings documented).
**Method:** Read-only. No code was modified. All findings cite `file:line` in the audited tree.

---

## 0. Anatomy

The task board is a **folder-bound delegation pipeline**: a user writes a task (prompt snapshot) on a project folder, an engine launches a dedicated ACP agent session inside a git worktree of that folder, and the result flows back through a review → merge → done pipeline whose final truth is git, not the agent's word.

```
┌─ user/UI (board) ─┐   ┌─ commands/work_task.rs ─┐   ┌─ work_task/engine.rs ─┐
│ tasks-page.tsx    │──▶│ 27× *_core (CRUD→svc,   │──▶│ TaskEngine: launch,  │
│ task-card / dialogs│   │  start/retry/return/   │   │ reconcile, merge,    │
│ tasks-view-context │  │  cancel/merge→engine)   │   │ recover              │
└───────┬────────────┘   └──────────┬─────────────┘   └──────┬───────────────┘
        │ task://changed            │                         │ spawn_agent (ACP)
┌───────▼────────────┐   ┌──────────▼─────────────┐   ┌──────▼───────────────┐
│ web/handlers/      │   │ db/service/             │   │ acp/work_task_tools  │
│ work_task.rs (27)  │   │ work_task_service.rs    │   │ delegation/{transport│
│ (Axum, calls _core)│   │ (CAS state machine)     │   │ ,listener,companion} │
└────────────────────┘   └──────────┬──────────────┘   └──────────┬───────────┘
                                    │                             │ task_progress/
                            ┌───────▼──────────────┐              │ task_complete (MCP)
                            │ db: work_task,        │              ▼
                            │ work_task_event,      │      agent session (worktree cwd)
                            │ work_task_settings,   │      (Claude/Codex/Gemini/… via ACP)
                            │ work_task_template    │
                            └──────────────────────┘
```

Files: `src-tauri/src/work_task/{mod,engine,git}.rs` (engine, 2293 lines), `db/service/work_task_service.rs` (2144), `commands/work_task.rs`, `web/handlers/work_task.rs`, `models/work_task.rs`, `db/entities/work_task{,_event,_settings,_template}.rs`, `db/migration/m20260801_0000{01,02,03}_work_task*.rs`, `acp/work_task_tools.rs`, `acp/delegation/{transport,listener,companion}.rs`, plus frontend `src/components/tasks/*`, `src/contexts/tasks-view-context.tsx`, `src/lib/{api.ts,task-rounds.ts,types.ts}`.

**Mode-agnostic by construction:** service fns take a plain `&DatabaseConnection` (`work_task_service.rs:1-31`), so Tauri commands (`commands/work_task.rs:360+`), Axum handlers (`web/handlers/work_task.rs`, 27 endpoints), and the engine share one code path. The engine is built at boot in both desktop and server mode (`work_task/mod.rs:1-8`).

---

## 1. Task lifecycle

Pipeline `todo → queued → running ⇄ awaiting_input → review → merging → done`, with `failed`/`canceled` as side paths (`db/entities/work_task.rs:4-38`; `migration/m20260801_000001_work_task.rs:9-11`). Two hard invariants (`entities/work_task.rs:6-10`):

- **`done` ⟺ merged** — only `merge_landed` writes `done` and it never rolls back (`service:1101-1102`).
- **Every transition is a CAS** — conditional UPDATE on expected status (+ current `run_seq` for engine-driven ones), with the `work_task_event` row written in the SAME transaction. The CAS UPDATE is the first statement so SQLite takes the write lock up front (busy-snapshot pitfall, `service:1-31`).

`canceled` is not a dead end: `requeue_canceled` moves it back to `todo` with the worktree reused (`entities/work_task.rs:35-37`; `service:687`).

| Transition | Writer | CAS guard | Site |
|---|---|---|---|
| create (todo) | user | — | `service:378` |
| todo → queued | engine/user (`start`/`start_all`) | status=todo | `engine.rs:289-349`, `service:518 claim_for_run` |
| queued → running | engine | status=queued + run_seq | `engine.rs:761 mark_running`, `service:760` |
| running ⇄ awaiting_input | engine | status + run_seq | `service:1005 flip_awaiting` |
| running/awaiting → review | engine | status + run_seq | `service:942 settle_review` |
| review → merging | engine | status=review | `service:1038 begin_merge` |
| merging → done | engine | status=merging | `service:1103 merge_landed` |
| merging → review | engine | status=merging | `service:1145 merge_back_to_review` |
| running/awaiting → failed | engine | status + run_seq | `service:839 fail` |
| any active → canceled | user (conversation stop) | status | `service:1285 cancel` |
| requeue canceled → todo | user | status=canceled | `service:687` |
| archive / unarchive | user | terminal only | `service:1240 set_archived` |

User entry points on the engine (all validate + claim under `run_seq`): `start` `:289`, `start_all` `:310`, `retry` `:351`, `return_task` `:376`, `cancel` `:407`, `merge_task` `:1303`, `cleanup_task` `:1640`. Pure CRUD (create/update/delete/reorder/archive/settings/templates) goes straight to the service and only nudges the pump (`commands/work_task.rs:31-37 nudge_pump`).

**Board presentation:** DB statuses aggregate into 4 columns `todo / inProgress / attention / done` (`board-columns.ts:4-36`). `merging` deliberately stays in the attention column so the card doesn't bounce when the user clicks merge (`board-columns.ts:26-30`). Archived tasks are hidden unless toggled; `canceled` hidden unless toggled (`board-columns.ts:44-67`).

---

## 2. Task execution (engine)

**Single-engine invariant:** one engine per process, elected by an exclusive advisory lock on `<data-dir>/<db-name>.lock` (`work_task/mod.rs:1-4`; `engine.rs:151-189`); a second process sharing the data dir runs none — the precondition that makes boot reconciliation safe.

`run_task_engine` (`engine.rs:190-240`) does, in order:

1. **Boot reconcile:** `boot_reconcile_interrupted` — no connections survive a restart, so `queued/running/awaiting_input` → `failed(interrupted)`; `merging` is exempt (`service:1371`) and instead:
2. **Merging scan:** every `merging` row → `recover_merging` (git-truth recovery, `engine.rs:1566+`).
3. **Loop:** `tokio::select!` over the internal ACP event bus (`on_event`) and a 30s reconcile tick (`RECONCILE_INTERVAL_SECS=30`, `engine.rs:55`), with lag-throttled logging (`:218-235`).

**The launch pipeline** (`launch`, `engine.rs:565-821`), under `task_lock`:

1. Reload task; abort if status ≠ `mode.expected_status()` (a cancel won the race, `:572-574`).
2. Resolve effective agent/config: task override > folder task settings > folder default agent (`effective_agent_config` `:1948`); audited as a `config_effective` event (values inherited live, never frozen, `:625-636`).
3. Worktree: reuse the recorded one (retry/return), else mint fresh. A merge generation **never** creates one (`:605-607`). A freshly created tree runs the folder's `init_command` (deps install) before the agent sees it; failure = `setup_error` (`:612-621`).
4. Resume the previous session (retry/return/merge) via `conversation.external_id` when it exists (`:645-658`); `build_session_runtime_env` + `verify_agent_installed`.
5. **Cancel gate** `still_expected` before spawning the CLI (`:669-671`).
6. `manager.spawn_agent(agent_type, Some(worktree_path), resume_session, env, "work_task", …)` (`:676-686`). Resume failure → `resume_fallback` event + fresh session in the same worktree (`:689-716`).
7. Conversation row: reuse on resume, else create (`:722-735`); folder + conversation upserts broadcast so clients group them.
8. Register `conn_id → (task_id, run_seq)` in the `index` **before** prompting so a fast TurnComplete can't race ahead (`:742-745`).
9. `mark_running` / `mark_merging_live` CAS; losing → tear down with zero side effects (`:750-778`).
10. `send_prompt_linked_with_message_id`; record a `round` event (`kind`, `run_seq`, `prompt_head`) that the transcript viewer uses to label turns (`:798-809`).

**Generation (run_seq) semantics:** every claim (start/retry/return/merge) bumps `run_seq` (`begin_merge` bumps it `service:1054-1057`). All events carry `(connection_id, run_seq)` and settle through CAS updates, so a cancel racing a late TurnComplete is a zero-side-effect no-op (`engine.rs:20-32` header).

**TurnComplete settle** (`on_turn_complete`, `engine.rs:998-1097`):
- Merge generation → `settle_merge_generation` from git truth regardless of stop reason (`:1011-1021`).
- `end_turn` → the generation's `task_complete` verdict decides: `blocked` → `failed(verdict_blocked)`; `success`/`needs_review` → `settle_review` (+ diff stats + spawned preflight) (`:1023-1070`).
- `cancelled` (user stopped the agent from the conversation UI) → task `cancel` (`:1072-1078`); anything else → `fail(agent_error)`.
- A slot freed → `pump_folder` to keep the queue draining (`:1093-1096`).

**awaiting_input:** the engine subscribes to `Question/Permission/PlanApproval` request+resolve ACP events and flips `running ⇄ awaiting_input` on the empty↔non-empty edges of a per-task outstanding-set (`on_event` `:965-996`; `track_request` `:1101-1131`). Rationale: no global pending-question channel exists for unopened conversations (`engine.rs:33-42` header).

**Reconcile tick** (`reconcile_once`, `engine.rs:1790-1869`): a `running/awaiting_input` task whose connection is gone settles from the produced conversation's status (PendingReview/Completed → review; Cancelled → cancel; else `fail(interrupted)`). Non-in-flight `merging` rows → `recover_merging` (spawned off-thread, waits on the per-folder git lock). Pending folders → pump.

**Preflight acceptance light** (P2): a folder-configured command runs against the worktree after settle into review; result written CAS (review + run_seq) so a slow finish after the task moved on is a no-op (`engine.rs:1191-1272`; `service:1196 set_preflight`; `PREFLIGHT_TAIL_CHARS=4000`, `engine.rs:58`).

---

## 3. Repository dependency

The task model is **hard-wired to git**. Every task runs in a dedicated git worktree of its project folder; the project folder itself is "never a worktree folder" (`entities/work_task.rs:45-46`). The task row carries its git identity: `base_branch`, `base_sha`, `work_branch`, `merge_commit` (`entities:66-78,91`). `base_sha` is recorded **before** the worktree is created so a concurrent branch switch can't drift it (`entities:67-69`; `ensure_worktree` `engine.rs:823-825`).

All git plumbing is in `work_task/git.rs` (thin CLI wrappers mirroring `commands::folders`, composed by the engine under the per-folder git mutex):

| Helper | Purpose | Actually used by engine? |
|---|---|---|
| `rev_parse` `:20` | pin a rev to a full sha | yes (`engine.rs:847,1360,1480`) |
| `staged_clean` `:37` | pre-merge guard | yes (`:1350,1502`) |
| `has_changes`/`commit_all`/`commit_staged` `:43-93` | engine-side commit | **no** (dead) |
| `merge_base_into_worktree` + `MergeAttempt` `:96-125` | engine-side stage A | **no** (dead) |
| `merge_squash`/`merge_no_ff` `:130-149` | engine-side stage B | **no** (dead) |
| `reset_merge` `:153` | clean half-done stage B | yes (`:1504`) |
| `has_merge_head` `:162` | crash-recovery probe | yes (`:1501`) |
| `is_ancestor` `:169` | merge truth (branch ancestry) | yes (`:1489`) |
| `trees_equal` `:184` | merge truth (squash = tree equality) | yes (`:1492`) |
| `diff_numstat` `:195` | review change stats | yes (`:1278`) |
| `remove_worktree_and_branch` `:223` | cleanup | yes (`:1711`) |

**Key finding (design shift):** the engine performs **zero** git mutations. The two-stage merge is executed **in-session by the agent**: stage A (sync base INTO the worktree, conflicts land there) and stage B (land on the base checkout at the project root) are literal instructions in the merge-mode prompt (`compose_prompt`, `engine.rs:2076-2091` — "doing all git operations yourself… Run `git merge {base_branch}` here and resolve every conflict… Land onto the base checkout at `{root_path}`"). The engine's remaining job is verification and cleanup: `merge_landed_commit` (`:1474-1496`) decides "landed" purely from git truth — base HEAD moved **and** (`is_ancestor(work_branch, head)` for merge commits **or** `trees_equal(head, work_branch)` for squashes) — and **deliberately never consults the commit message** (`:1472-1473`). The engine-side landing helpers (`commit_all`, `commit_staged`, `merge_squash`, `merge_no_ff`, `merge_base_into_worktree`) are never invoked from anywhere (grep: definitions + self-references only) — vestiges of an earlier design where the engine landed merges itself. See Findings F1/F2.

**Merge guards** (all surfaced as readable errors, `merge_task` `engine.rs:1303-1362`): task must be in `review`; one merge per project at a time (checked under the per-folder git lock); project folder must be on `base_branch`; index must be clean; `pre_merge_head` pinned right before the CAS. Merge intent (`WorkTaskMergeState { pre_merge_head, message, strategy, delete_worktree, auto_message }`, `models/work_task.rs:184-204`) is persisted in the SAME transaction as the review→merging CAS (`service:1038-1099`) — the crash-recovery anchor.

**Crash recovery** (`recover_merging` `:1566+`): a `merging` task with a live connection is not stuck (its TurnComplete settles it). Otherwise the engine reads git truth: landed (`merge_landed` back-fills `done` honoring the persisted `delete_worktree`) or not (`back_to_review` + `clean_merge_residue` which resets MERGE_HEAD / staged residue, `:1500-1506`).

---

## 4. Agent interaction

Every task run is an **ACP session** spawned with the worktree as cwd and origin `"work_task"` (`engine.rs:676-686`), with a runtime env built from the effective agent/mode/config (`build_session_runtime_env`).

**Rounds:** four prompt modes (`LaunchMode`, `engine.rs:243-283`), each composing its own prompt (`compose_prompt` `:1983-2119`):
- `Fresh` — the task's own prompt blocks.
- `Retry` — "previous run was interrupted, continue in this worktree" (+ replay + latest return feedback so it survives restarts, `:2005-2024`).
- `Return(feedback)` — "the user reviewed your work and returned it with the following feedback; address it in this same worktree" (`:2025-2043`).
- `Merge{…}` — the full git-landing instruction set above (`:2044-2091`), including the message rule (user message verbatim, else the agent writes a Conventional Commits message).

Every non-merge prompt appends a standing "work task context" guard block: commit to the work branch freely, but never merge/rebase/push the base branch; report milestones with `task_progress` and finish with `task_complete` (`:2097-2117`).

**MCP reporting tools** (`task_progress`, `task_complete`): injected into the agent session's tool list (`acp/connection.rs:3447` tool group; `acp/delegation/companion.rs:189,626-680` — `task_progress` requires a non-empty message; `task_complete` requires `success | needs_review | blocked` + summary). The broker listener authenticates by per-launch token, resolves the parent connection, and routes to the `WorkTaskToolAccess` implementation (`acp/work_task_tools.rs:1-6`; `delegation/listener.rs:505-515`). The production impl is `EngineWorkTaskTools` (`engine.rs:2227-2258`):

- `record_progress` — connection index → append `agent_progress` event (the card's realtime milestone) + board broadcast; generation-guarded so a stale connection's report is a no-op (`:1137-1160`).
- `record_complete` — `set_verdict` CAS stashes verdict+summary on the current generation (`:1164-1184`); the verdict column is cleared on every claim, so a present verdict always belongs to the current generation (`engine.rs:1025-1030`; `service:898 set_verdict`; `begin_merge` clears it `service:1059`).

The verdict decides the `end_turn` settle (Section 2); a recorded summary outranks the captured last-assistant text (`capture_summary` `:1286-1301`).

**Timeline:** `work_task_event` rows (`created / status_changed / config_effective / agent_progress / agent_verdict / merge_attempt / merge_conflict / cleanup_failed / resume_fallback / user_action / diff_stat / round`, `entities/work_task_event.rs:13-15`) render in the task detail sheet. The `round` markers let the transcript viewer label turns by pure first-match against `prompt_head` (`src/lib/task-rounds.ts:26-57`; deliberate — the thread is virtualized, `task-rounds.ts:10-15`).

**Realtime sync:** the engine runs headless, so `WORK_TASK_CHANGED_EVENT` (`"task://changed"`) with id-only payloads `{Upsert, Deleted, Settings, Refresh}` is the only way an open board learns a task advanced (`event_bridge.rs:320-339`; `emit_event` unifies Tauri webview + WebSocket, `:343-364`). Frontend: always-mounted `TasksViewProvider` refetches on every event + on transport reconnect (`tasks-view-context.tsx:82-107`), derives the sidebar attention badge (`awaiting_input | review | failed`, `:23`), and emits system notifications on review/failed flips via fetch-to-fetch diff (`:129-156`).

**Methodology skill:** the repo bundles the `subagent-driven-development` expert skill (`src-tauri/experts/skills/subagent-driven-development/` — implementer/task-reviewer/re-review prompts + `task-brief`/`review-package`/`sdd-workspace` scripts). It defines how an agent is *expected* to execute task work (fresh subagent per task, review loop, ledger), and is wired through the experts/commands link machinery — a task-facing extension point, not a TaskBoard runtime dependency.

---

## 5. Storage

Four tables (newest domain in the repo; migrations dated 2026-08-01):

**`work_task`** (32 columns, `migration/000001:12-133`; entity `db/entities/work_task.rs`): `folder_id` (soft ref, no hard FK — folders soft-delete and every query joins the live folder, `000001:24-27`), `title`, `config` (opaque JSON), `status`, `failure_reason` (`agent_error | setup_error | verdict_blocked | interrupted`, `:39-40`), `last_error`, `run_seq`, `sort_order`, `worktree_folder_id`, `conversation_id`, `connection_id` (live-only, not durable), `base_branch`, `base_sha`, `work_branch`, `merge_state` (JSON), `pending_merge` (JSON — **never written**, F2), `cleanup_state`, `verdict`, `result_summary`, `files_changed/additions/deletions`, `merge_commit`, `preflight` (JSON), `archived_at` (cleared by any resurrection), `created/updated/started/settled/finished/deleted_at`. Indexes: `idx_work_task_folder`, `idx_work_task_status` (`:114-133`).

**`work_task_event`** — append-only timeline; FK → work_task with `ON DELETE CASCADE`; index `(task_id, created_at)` (`000001:135-181`; `entities/work_task_event.rs`).

**`work_task_settings`** — one row per folder (unique `folder_id`), JSON `WorkTaskFolderSettings`; dies with the folder (`000001:183-217`; `entities/work_task_settings.rs`). `GLOBAL_SETTINGS_FOLDER_ID = 0` sentinel; a folder's own row wins wholesale (no field-by-field merge — one save detaches from global, `service:1405-1448`).

**`work_task_template`** — global blueprints (name + title seed + same JSON config); hard-deleted, nothing references them (`000001…_000003`; `entities/work_task_template.rs`).

Migration `000002` added `pending_merge`, `preflight`, `archived_at` in three ALTERs (SQLite allows one ADD per ALTER, `000002:9-10`). Migration `000001` also adds `conversation.origin_cwd` — the cwd a conversation actually ran in when it differs from its folder's path; the stale-external-id fallback matches on `origin_cwd ?? folder.path`; only ever set when deleted task worktrees' conversations are re-parented (`000001:219-231`).

Wire DTOs mirror `src/lib/types.ts` exactly (`WorkTask/WorkTaskStatus/WorkTaskConfig/WorkTaskEvent/WorkTaskTemplate/WorkTaskFolderSettings/WorkTaskChangedFile`, `types.ts:1248-1374`). `WorkTaskConfig` is serde-tolerant (`#[serde(default)]`) so older/newer snapshots still deserialize (`models/work_task.rs:93-113`).

---

## 6. Extension points

| Extension point | Mechanism | Site |
|---|---|---|
| Agent-side reporting | `WorkTaskToolAccess` trait (mirrors `SessionInfoAccess`); production impl `EngineWorkTaskTools` | `acp/work_task_tools.rs:20+`; `engine.rs:2227-2258` |
| Task prompt shape | Opaque `WorkTaskConfig` snapshot (`prompt_blocks`, `display_text`, `agent_type`/`mode_id`/`config_values`/`label_snapshot`), replayed at launch | `models/work_task.rs:93-113` |
| Per-folder knobs | `WorkTaskFolderSettings`: default agent/mode, `auto_process` (scheduler claims due todos — "stored now, hidden in the P0 UI"), `max_concurrent` (default 2), `merge_strategy` (squash\|merge), `delete_worktree_default`, `preflight_command_id`/`preflight_command` (acceptance light), `init_command` (worktree seeding) | `models/work_task.rs:116-170` |
| Reuse | Templates (upsert by exact name) | `models:84-91`; `000003` |
| Cross-feature: Automations → Tasks | The `enqueue_task` automation action builds a `WorkTaskDraft` from the automation config and calls `work_task_create_core` — deliberately "not the bare service so the task board gets its `task://changed` broadcast and the work-task pump its nudge for free" | `automation/engine.rs:378-395`; folder choice narrowed to project roots `automation-editor.tsx:145-151` |
| Realtime UI sync | `WORK_TASK_CHANGED_EVENT` id-only broadcast + always-mounted provider (badge, notifications) | `event_bridge.rs:320-339`; `tasks-view-context.tsx` |
| Serialization seams | per-task and per-folder `Mutex` maps | `engine.rs:1873-1887` |
| Queue reactivation | `nudge_pump` best-effort folder pump from CRUD creates/edits/requeues/settings | `commands/work_task.rs:31-37` |
| Engine access | `engine()` process-global accessor; ownership file lock | `engine.rs:64-66,151-189` |

---

## 7. Generic vs. Git-specific — verdict

**The pipeline is generic; the execution substrate is git-specific.**

Generic (would port to any repo-backed VCS): the `todo → queued → running ⇄ awaiting_input → review → merging → done` state machine, CAS+event-transaction invariants, `run_seq` generations, session resume/fallback, awaiting_input tracking, MCP verdict reporting, preflight acceptance light, archive/cleanup, templates, broadcast sync.

Git-specific (hard requirements, not abstractions): worktrees + branches as the isolation unit; `base_sha` pinning; worktree removal + `-D` branch delete; two-stage merge with `squash`/`no-ff` strategies; merge truth derived from `is_ancestor`/`trees_equal` (commit message deliberately ignored); the merge prompt teaches the agent `git -C {root}` landing commands; pre-merge guards require the project folder to be on the base branch with a clean index (`engine.rs:1344-1359`).

Consequence: a non-git folder cannot run a task (`launch` requires worktree minting; `merge_coordinates` requires `base_branch`/`work_branch`, `engine.rs:1546-1557`), and the automations UI already encodes this ("task boards bind to project roots only", `automation-editor.tsx:145-151`). The merge design inverts the usual pattern: rather than the engine orchestrating the merge, the agent executes it and the engine *verifies* — a trust-the-git-truth model that makes `done` provable (HEAD moved + content contained) and crash-recoverable without relying on agent reports.

---

## 8. Verified findings

**F1 — Dead engine-side merge/commit helpers (~100 lines).** `commit_all` (`git.rs:53`), `commit_staged` (`:72`), `merge_base_into_worktree` + `MergeAttempt` (`:96-125`), `merge_squash` (`:130`), `merge_no_ff` (`:139`) are never called anywhere outside `git.rs` itself (verified by grep across `src-tauri/src`). They are vestiges of an earlier design where the engine landed merges; the shipped design executes both merge stages in-session by the agent (`engine.rs:2076-2091`) and the engine only verifies/cleans up. **Action:** delete, or resurrect for an engine-orchestrated merge mode.

**F2 — `pending_merge` column is dead.** Added in `000002:14-19`, cleared at five sites (`service:424, 542, 697, 862, 1296`), **never written** (grep: no `PendingMerge` set anywhere). The entity doc describes the P2 auto-remerge cycle ("set when a stage-A conflict dispatches the agent, consumed when the repaired run settles into review", `entities/work_task.rs:77-82`) but that dispatch never landed; `merge_back_to_review` (`service:1145-1191`) simply returns the task to review. The clears are harmless but the column is noise. **Action:** finish P2 (remerge generation) or drop the column in a future migration.

**F3 — `done`-recovery asymmetry is intentional and safe.** `merge_landed` never rolls back and is the only `done` writer (`service:1101-1102`); boot recovery exempts `merging` from the interrupted sweep (`service:1371`; `engine.rs:190-210`) because it recovers from git truth. Clean.

**F4 — Reconcile scans merge rows every 30s.** `reconcile_once` spawns `recover_merging` for every `merging` row not in the in-flight set each tick (`engine.rs:1850-1859`); cheap in practice (per-folder git lock + `rev-parse`/`is-ancestor` probes) but the in-flight-set membership is the only guard. Worth noting if merge volume grows.

**F5 — Design debt: merge requires the project folder to be exactly on `base_branch` with a clean index** (`engine.rs:1344-1359`). Any drift (user switched branch, staged changes) blocks the merge with a readable error — correct but user-visible; no auto-recovery beyond the message.

**F6 — `config_effective` vs. frozen config.** Effective values are inherited live and audited on a `config_effective` event rather than frozen into the task (`engine.rs:583-636`; `models/work_task.rs:93-97`). This means a task's actual execution config at launch time is only reconstructible from the audit trail — a deliberate trade (documented), not a bug.

---

## 9. Next steps

1. F1: remove the dead git helpers (or wire an engine-side stage-B for a future "auto-merge without agent" mode).
2. F2: decide P2 auto-remerge — implement the conflict-repair generation or drop `pending_merge`.
3. Optional: a phase-3 follow-up on the frontend board interactions (drag-reorder, merge/return dialogs, task-settings dialog preflight UX) and `src/lib/api.ts:2657-2820` transport surface was out of scope here beyond the data-layer.
4. Optional: extend the phase-2 finding — `automation/engine.rs:378-395` is now the canonical example of a cross-feature consumer of the task CRUD surface; keep it in mind when changing `work_task_create_core`'s validation.
