# Architecture Audit — Phase 2: Scheduler & Automations

**Date:** 2026-08-03
**Branch audited:** `plugin-dev` (`73484387`)
**Scope:** Scheduler / Automations subsystem only. No other subsystem audited.
**Method:** Read-only. No code was modified. All findings cite `file:line` in the audited tree.

---

## 1. How is an automation created?

The UI (`src/components/automations/automations-page.tsx`) captures a composer snapshot and saves it wholesale (a "saved composer" — the editor loads the whole automation and saves it back, no partial-patch semantics, `src-tauri/src/models/automation.rs:53-55`). Wire form mirrors `Automation` in `src/lib/types.ts` (`models/automation.rs:8`).

1. `automationCreate(draft)` / `automationUpdate(id, draft)` (`automations-page.tsx:348-349`) → `automation_create_core` / `automation_update_core` (`src-tauri/src/commands/automation.rs:35-62`), shared by both modes (Tauri `#[tauri::command]` wrappers at `commands/automation.rs:137-192`, Axum handlers use the same `_core` fns).
2. `automation_service::create` (`src-tauri/src/db/service/automation_service.rs:276-309`) validates (`validate_draft`, `:180-219`: name, prompt, folder requirement for `EnqueueTask`, remote-branch/shared-root incompatibility) and computes `next_run_at` via `next_run_for` (`:223-231`) — only `enabled && trigger_kind == Schedule` automations get a next-fire instant; manual/disabled store `None`.
3. The config is stored as an **opaque JSON string** (`config` Text column, `automation.rs:52-55`), replayed wholesale at fire, never queried (`automation_service.rs:3`).

The editor's "next run" preview (`automation_compute_next_run_core`, `commands/automation.rs:99-104`) shares the exact evaluator the scheduler uses, so preview and actual fire can never diverge (`commands/automation.rs:97-98`).

## 2. Cron parsing & scheduling math

All in `automation_service.rs`, `cron` crate + `chrono_tz`:

- **`normalize_cron`** (`:142-158`) — converts the UI's 5-field `min hour dom mon dow` to the crate's 6-field `sec min hour dom mon dow` by prepending a zero-seconds field; 6/7-field expressions pass through as crate-native.
- **`remap_dow_field`** (`:76-135`) — shifts day-of-week from POSIX 0-6 (Sun-Sat, 7=Sun) to the crate's 1-7 (Sun=1) via `(n % 7) + 1`, expanding numeric tokens to an explicit sorted set to sidestep wrap-around ranges; symbolic names (`mon`, …) pass through untouched. Without this, weekly automations would fire a day early and Sunday would be unschedulable (`:69-75`).
- **`compute_next_run`** (`:164-178`) — the **single source of truth**: parse → evaluate `schedule.after(now)` in the configured IANA timezone → return the next instant in UTC. Shared by create/update, `set_enabled`, the scheduler's `claim_due`, and the editor preview.

## 3. Where is the schedule stored?

On the `automation` row (`src-tauri/src/db/entities/automation.rs:30-65`):

| Column | Purpose |
|---|---|
| `trigger_kind` | `schedule` \| `manual` (`automation.rs:9-14`) — the scheduler only considers `Schedule` |
| `cron` | 5-field expression, `Some` iff `trigger_kind == Schedule` (`:38`) |
| `timezone` | IANA name the cron is evaluated in (`:40-41`) |
| `next_run_at` | **Next fire instant, stored UTC** — the scheduler's due key; recomputed forward after every fire so restart catch-up fires at most once (`:42-44`) |
| `enabled` / `deleted_at` | Scheduling gates; `set_enabled` (`service.rs:340-357`) recomputes `next_run_at` on re-enable, `delete` (`:360-368`) soft-deletes and nulls it |

Runs live on `automation_run` (`src-tauri/src/db/entities/automation_run.rs:23-50`): `trigger` provenance (`'schedule'|'manual'`, `:30-31`), `scheduled_for` (the claimed slot instant — audit of which slot a crash missed, `:32-34`), `status` (`Running/Succeeded/Failed/Cancelled/Skipped`, `:10-21`). A **partial unique index** `idx_automation_run_one_active ON automation_run (automation_id) WHERE status = 'running'` (`src-tauri/src/db/migration/m20260621_000001_automation.rs:242-245`) is the hard DB backstop against duplicate concurrent fires.

## 4. How does the scheduler wake up?

**Polling, not OS timers.** `run_automation_engine` (`src-tauri/src/automation/engine.rs:218-286`) is a single `tokio::select!` loop over four arms:

```
boot_reconcile_interrupted (once, engine.rs:225)
└── loop {
      rx.recv()                 → on_event (TurnComplete settling)
      reconcile.tick()          → reconcile_once (30s, engine.rs:51, :255)
      schedule.tick()           → list_due → claim_due → spawn run_automation (30s, :53, :256-276)
      prune.tick()              → prune_old_runs (6h, :57, :277-283)
    }
```

- `SCHEDULER_INTERVAL_SECS = 30` (`engine.rs:54`) — cron is minute-granular, so 30s catches each slot.
- `RECONCILE_INTERVAL_SECS = 30` (`:51`); `PRUNE_INTERVAL_SECS = 6h`, `RUN_RETENTION_DAYS = 30` (`:57-58`); `MAX_RUN_MINUTES = 180` (`:48`).
- Spawned once per process: desktop `lib.rs:680-692` (`tauri::async_runtime::spawn`), server `src-tauri/src/bin/codeg_server.rs:468` (`tokio::spawn`).
- **Single-engine invariant:** `build_engine` (`engine.rs:113-152`) acquires an exclusive advisory lock on `<data-dir>/<db-name>.lock` (`:171-212`, `flock`/`LockFileEx`) held for the process lifetime. A second process sharing the data dir gets `None` and runs no engine — the precondition that makes the destructive boot reconcile safe (`:85-92`, `:214-229`).

## 5. How does a run fire?

1. **Due detection:** `schedule.tick()` → `automation_service::list_due` (`service.rs:599-611`) — `enabled AND deleted_at IS NULL AND trigger_kind = Schedule AND next_run_at <= now`.
2. **CAS claim:** `claim_due` (`service.rs:622-660`) — inside a transaction: re-reads the row, verifies still enabled/scheduled/actually due, computes the **next** instant via `compute_next_run(..., now)` (forward from now, never replaying missed minutes), and advances `next_run_at` with a `WHERE next_run_at = slot` CAS. Exactly one runner wins the slot — even across a desktop + server sharing one DB, and across restarts. Losers get `None`.
3. **Fire:** each won slot spawns `engine.run_automation(id, "schedule", slot)` off-thread (`engine.rs:263-274`) so a slow git/worktree launch never blocks the loop arms.
4. **`run_automation`** (`engine.rs:301-363`): per-automation `fire_lock` (async mutex, `:310-311`, `:706-712`) serializes overlap-check + insert + launch → `has_active_run` overlap guard (`service.rs:393-403`; on overlap, `record_skipped_run` `:442-466` and return) → `start_run` inserts the `Running` row + stamps parent `last_run_at/status` (`:406-439`) → early `RunStarted` broadcast (`engine.rs:338-341`) → `launch` (`:418-576`).
5. **Launch:** parse config → `resolve_cwd` (`:581-696`; see below) → broadcast folder upsert → `build_session_runtime_env` (`:450-452`) + `verify_agent_installed` (`:453-455`) → cancel re-check (`run_no_longer_running`, `:462-478`) → `manager.spawn_agent` (`:481-494`) → `create_conversation_core` (`:496-506`) → conversation upsert broadcast (`:513`) → register `connection_id → (run_id, automation_id)` in the in-memory index (`:517-520`) → `attach_run_runtime` (`:521-528`) → re-emit `RunStarted` with live "View conversation" link (`:533-536`) → final cancel gate (`:544-549`) → `send_prompt_linked_with_message_id` (`:551-575`).
6. **Settle:** `AcpEvent::TurnComplete` (keyed by `connection_id`, the event has no conversation id — `engine.rs:5-7`) → `on_event` (`:716-756`): `classify_stop_reason` (`end_turn`→succeeded, `cancelled`→cancelled, refusal/max_tokens/etc→failed, `:1027-1033`) → capture summary from `last_assistant_text` (`:760-764`) → `settle_run` (`service.rs:499-558`, transactional CAS on `status = running`, denormalizes onto parent, bumps `unseen_failures` on failure) → drop index + disconnect.

**Reconcile backstops** (`engine.rs:768-844`): owned runs with a dead connection settle from the conversation's terminal status (`settle_from_conversation`, `:850-875`); unowned runs force-fail past `MAX_RUN_MINUTES`. **Boot recovery** force-fails every still-`running` row as "interrupted by restart" (`service.rs:575-593`) — never re-fires; the schedule re-fires naturally.

## 6. Why a fresh session per run?

An automation run is **one prompt, one turn, then teardown**:

- `spawn_agent(agent_type, Some(workdir), None /* session_id */, env, "automation", emitter, mode_id, config_values)` (`engine.rs:481-494`) — the `None` session id means a **brand-new ACP connection** each fire; no resumption, no dedup hit.
- `create_conversation_core(..., folder_id, agent_type, Some(title))` (`:496-506`) mints a fresh conversation row bound to the run; `attach_run_runtime` links it (`:521-528`).
- On `TurnComplete` the index entry is removed and the connection disconnected (`:744-747`) — `last_assistant_text` is cleared at the next turn start, so an automation connection is never reused (`:744-745`).
- Isolation is per-run by default: `IsolationMode::WorktreePerRun` (`automation.rs:23-28`) mints `git worktree add` on branch `automation/<id>/run-<run_id>` in a sibling dir `<basename>-automation-<id>-run-<run_id>` (`engine.rs:590-623`, retry with `r<run_id>b` suffix on collision). `SharedInRoot` checks a pinned branch out in the root tree (serialized per root via `root_locks`, `:624-694`), refusing dirty trees / ambiguous remote branches.

## 7. Where is it implemented?

| Layer | File |
|---|---|
| Engine (loop, fire, launch, reconcile, cancel, settle) | `src-tauri/src/automation/engine.rs` (1146 lines) |
| Cron math + run lifecycle + due/claim DB ops | `src-tauri/src/db/service/automation_service.rs` (1075 lines) |
| CRUD + run-now/cancel command surface (both modes) | `src-tauri/src/commands/automation.rs` |
| Module root | `src-tauri/src/automation/mod.rs` (`build_engine`, `run_automation_engine`) |
| Schema | `src-tauri/src/db/migration/m20260621_000001_automation.rs` (partial unique index `:242-245`) |
| Entities | `src-tauri/src/db/entities/automation.rs`, `automation_run.rs` |
| Wire models | `src-tauri/src/models/automation.rs` (`AutomationDraft` `:56-68`, `AutomationAction` `:75-82`, `AutomationConfig` `:89-102`) |
| Boot wiring | `src-tauri/src/lib.rs:680-692` (desktop), `src-tauri/src/bin/codeg_server.rs:468` (server) |
| UI | `src/components/automations/automations-page.tsx` |

## 8. What data is passed into the run?

From the stored config blob (`models/automation.rs:89-102`, `#[serde(default)]`-tolerant):

- `action`: `LaunchSession` (default) | `EnqueueTask` (`:75-82`) — enqueue-task automations bypass the session machinery entirely: `enqueue_task` (`engine.rs:369-415`) creates a todo work task via `work_task_create_core` and settles the run synchronously (no session to wait for).
- `prompt_blocks: Vec<Value>` — the replayed composer blocks (deserialized to `PromptInputBlock`, `engine.rs:427-432`; empty ⇒ hard error `:433-435`).
- `display_text` — run/conversation title source (`first_chars(..., 80)`, `engine.rs:497`).
- `mode_id` + `config_values` — forwarded to `spawn_agent` (`engine.rs:490-491`).
- `label_snapshot` — display-only.

Plus non-snapshot runtime inputs: `agent_type` (column), the **current** settings-derived `runtime_env` (never snapshotted, `engine.rs:448-452`), the resolved working directory (`cwd.working_dir`), and `root_folder_id`. Data flows into the agent via the existing ACP launch chain (`send_prompt_linked_with_message_id`, `engine.rs:551-575`) — no new transport.

## 9. Extension points & risks

**Extension points**

- `AutomationAction::EnqueueTask` (`models/automation.rs:75-82`) — the designed split between the session path and the work-task pipeline; a new action extends this enum + the `launch` dispatch (`engine.rs:423-425`).
- `TriggerKind` (Schedule/Manual) — a new trigger kind slots into `list_due`/`claim_due` predicates + `next_run_for`.
- `IsolationMode` (WorktreePerRun/SharedInRoot) — new isolation strategies extend `resolve_cwd` (`engine.rs:581-696`).
- Cron math is centralized in `compute_next_run` — new schedule syntax only touches `normalize_cron`/`remap_dow_field`.
- The engine is the documented lifecycle-subscriber hook point for the plugin system (`plugins/backend/`).
- `connection_id → run` index (`engine.rs:78`) is the correlation seam for completion.

**Risks**

1. **Single-engine lock is the safety core.** `build_engine` failing closed (`engine.rs:120-138`) is what makes boot reconcile + the unique index sound. Weakening the lock (or the fail-closed path) lets two engines double-fire and reconcile each other's live runs.
2. **`claim_due` CAS + `next_run_at` forward-recompute** is the exactly-once mechanism (`service.rs:622-660`). A regression here (e.g. recomputing from `slot` instead of `now`) causes replay storms after downtime.
3. **Event-bus lag** drops `TurnComplete`s — the reconcile backstop (`engine.rs:255`, `:768-844`) recovers them, but only settles to `Failed`/conversation-status fidelity, losing `stop_reason` precision. Lag metrics are logged via `LagLogThrottle` (`:37`, `:242-252`).
4. **Worktree GC gap** — `prune_old_runs` (`service.rs:664-684`) deletes run *rows* but explicitly does **not** garbage-collect per-run worktrees/branches (`automation/<id>/run-<id>`) — documented as an open follow-up (`:674-677`). Collision retry (`engine.rs:604-613`) mitigates leftovers.
5. **`stop_reason` is the settle authority but string-fragile** — `classify_stop_reason` (`:1027-1033`) treats anything other than `end_turn`/`cancelled` as failure; new ACP stop reasons (e.g. `max_turn_requests` at high budget) land as `Failed` unless remapped.
6. **Shared-in-root runs mutate the user's tree** — `git_checkout` on the root (`engine.rs:684-686`); the dirty-tree refusal (`:674-683`) is the only guard between an automation and silent branch switching.
7. **Cancel is best-effort on a wedged row** — `cancel_run` (`engine.rs:890-965`) settles first (CAS), then tears down; a run whose connection vanished mid-launch relies on the conversation converge path (`:956-963`) to avoid a stranded InProgress row.
8. **`scheduled_for` audit data depends on `start_run` being reached** — a claim that loses the `fire_lock` race still recorded nothing; only the partial unique index guarantees no duplicate *Running* rows, not that every slot is represented.

---

## Execution flow: Cron tick → Agent run → Settle

```
UI (automations-page.tsx)
 ├─ automationCreate/Update(draft) → automation_create_core
 │    └─ validate_draft → next_run_for → compute_next_run (cron+tz) → INSERT automation
 └─ editor preview: automation_compute_next_run_core (same evaluator)

Scheduler (run_automation_engine, engine.rs:218)
 ├─ every 30s: list_due(next_run_at <= now, enabled, schedule)
 ├─ per due id: claim_due → txn { verify due → next = compute_next_run(now)
 │    → UPDATE automation SET next_run_at=next WHERE next_run_at=slot }  (CAS, one winner)
 └─ tokio::spawn run_automation(id, "schedule", slot)
      ├─ fire_lock → has_active_run? → skipped : start_run (Running row)
      ├─ RunStarted emit (row visible, no link yet)
      ├─ launch:
      │    ├─ EnqueueTask → work_task_create_core → settle Succeeded (sync, no session)
      │    └─ LaunchSession:
      │         ├─ resolve_cwd → WorktreePerRun: git worktree add
      │         │        branch automation/<id>/run-<run_id> (sibling dir)   [or SharedInRoot: git checkout]
      │         ├─ build_session_runtime_env + verify_agent_installed
      │         ├─ cancel re-check → spawn_agent(conn_id, session_id=None)
      │         ├─ create_conversation_core → folder/conversation upsert broadcasts
      │         ├─ index[conn_id] = (run_id, automation_id)  + attach_run_runtime
      │         ├─ RunStarted re-emit (with "View conversation" link)
      │         └─ send_prompt_linked_with_message_id(blocks, folder, conv)
      └─ settle:
           ├─ TurnComplete → on_event → classify_stop_reason → settle_run (txn CAS)
           │    → drop index → disconnect
           ├─ (dropped event) reconcile_once → settle_from_conversation | force-fail @ 180m
           └─ (boot) boot_reconcile_interrupted → fail every Running row
```

---

*Scope note: the work-task pipeline (`work_task*` tables/services) is only referenced where automations delegate to it (`AutomationAction::EnqueueTask`); its own engine audit is out of scope for this phase. Phase 1 report: `audit/conversation-session-architecture-phase1.md`.*
