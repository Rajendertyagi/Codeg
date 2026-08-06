# Phase 6 Audit — Plugin & Extension Architecture

> **Status:** Complete (read-only; no patches applied, no code changed)
> **Commit context:** working tree at `3745933d`; custom layer committed in `aec0b9ff`
> **Date:** 2026-08-04
> **Method:** Qartez graph + codebase-memory (cbm) semantic search + targeted reads of every custom-layer file and every engine extension surface. All citations are `file:line` from the committed tree.

---

## Objective

Determine, from evidence, whether a large personal AI-assistant platform can be built **primarily through Codeg's custom hooks/extension layer** while staying compatible with future upstream Codeg releases — or whether the architecture forces a long-term fork.

Primary question, answered in §Anatomy–Verdict: **hybrid — buildable via custom hooks, with a small (3-seam) engine touch surface; fork only under specific conditions.**

---

## Verified Facts

### A. The custom layer (source-out-of-tree, compile-time coupled)

1. **Backend hook files are git-tracked, out-of-tree Rust modules.** `git ls-files newplugin/` → `hooks/{mod.rs, custom_auto_approve.rs, custom_cron.rs, web_workflows.rs, task_accept.rs}`, `frontend/{custom-page.tsx, automation-editor.tsx, automation-conversation-picker.tsx}`, `patches/` (per-file patch archive). They are **committed** (part of `aec0b9ff`), not gitignored.
2. **Mount mechanism** — `src-tauri/src/lib.rs:15`: `#[path = "../../newplugin/hooks/mod.rs"] pub mod custom_hooks;`. The hooks module compiles *into* the engine crate and addresses engine internals via `crate::` paths: `crate::db::AppDatabase`, `crate::acp::manager::ConnectionManager`, `crate::acp::types::PromptInputBlock`, `crate::db::entities::conversation`, `crate::app_state::AppState` (all confirmed in the four backend files).
3. **Intent, documented in-code** — `newplugin/hooks/mod.rs:1-7`: "kept outside the upstream crate tree so they survive upstream merges"; Tauri shims "feature-gated: `codeg-server` builds without `tauri-runtime`".
4. **`newplugin/hooks/mod.rs` (107 lines)** — 6 `#[cfg(feature = "tauri-runtime")] #[tauri::command]` shims: `toggle_auto_approve_global` :19-37, `get_auto_approve_global` :40-53, `save_custom_workflow` :66-71, `delete_custom_workflow` :74-78, `list_custom_workflows` :80-85, `set_custom_workflow_enabled` :89-93, `run_custom_workflow_now` :97-105; serde response shapes `AutoApproveToggleResult`/`AutoApproveGetResult` :56-64; `pub use custom_cron::CustomWorkflow;` :107.
5. **Auto-approve hook** — `newplugin/hooks/custom_auto_approve.rs`: `AUTO_APPROVE_KEY = "auto_approve_global"` persisted in the engine's `app_metadata` KV store :15; `OnceLock<Mutex<Option<bool>>>` cache, **fail-closed** (:21-25: `None` ⇒ treated as disabled); `AutoApproveError` (NotFound/PermissionDenied/Internal) :28-36; `map_db_error` :38-40; accessors `is_auto_approved_sync` :44-49, `is_auto_approved` :54-56.
6. **Workflow scheduler hook** — `newplugin/hooks/custom_cron.rs` (425 lines): JSON store `custom_workflows.json` in the data dir beside SQLite :37; `CustomCronEngine` struct :232-238, `new` :241-247, `run` :250-257, `tick` :259-293 (30s interval), `fire` :299-302 → fires via `ConnectionManager::send_prompt_linked_with_message_id`; **owns no approval state**; FILE_LOCK serializes read-modify-write.
7. **Server-mode shims** — `newplugin/hooks/web_workflows.rs` (94 lines): Axum handlers (`SaveWorkflowRequest`, `WorkflowIdRequest`, `SetWorkflowEnabledRequest`); `storage_error` → `AppErrorCode::IoError` :40-46; `custom_workflow_list` :49-51; delegates to `custom_cron`.
8. **Frontend hook files** — `newplugin/frontend/custom-page.tsx` (731 lines): `CustomWorkflowsPage` master–detail UI; doc comment :75-86 states "Custom Workflows (custom hooks). Backed by the `custom_cron` scheduler"; consumes engine UI kit (`@/components/ui/*`, `@/lib/api`, `@/lib/utils`). `newplugin/frontend/automation-editor.tsx` (488 lines): **verbatim copy** of the native Automations editor with the folder target swapped for a target-conversation picker (explicit in comments :38-43, :720-722); emits `WorkflowDraft = {name, conversation_id, cron, prompt}` :62-67.
9. **Frontend mount points (engine files already carrying the custom-layer route):**
   - `src/components/workbench/workbench-content.tsx:13` — `import { CustomWorkflowsPage } from "../../../newplugin/frontend/custom-page"`; `:25` — `"custom-workflows": CustomWorkflowsPage` in `WORKBENCH_ROUTES`.
   - `src/contexts/workbench-route-context.tsx:21-25` — `"custom-workflows"` added to the engine `WorkbenchRouteId` union (1-line engine touch).
   - `src/components/layout/sidebar.tsx:442-445` — `SidebarNavButton` labelled "Custom Workflows".
   - i18n `CustomWorkflows` namespace: `src/i18n/messages/en.json:4260+` (plus zh-CN/zh-TW).
   - Transport-agnostic RPCs `src/lib/api.ts:2602-2609` (auto-approve) and `:2614-2653` (workflow CRUD) via `getTransport().call(...)` — auto-switches `invoke()`/`fetch()`.

### B. Engine-native extension surfaces (no patches required)

1. **Custom-agent runtime registry** — `src-tauri/src/acp/custom_registry.rs` (1355 lines): user-registered ACP agents as `custom_agent` DB rows, promoted to `&'static AcpAgentMeta` via `crate::intern` with **fingerprint-based leak discipline** (module doc :1-32); `CustomDistributionKind {Npx, Uvx, Binary}` :47-72; `NpxSpec`/`UvxSpec`/`BinaryPlatformSpec` paste-compatible with the ACP registry `distribution` object :74-120+. Consumed by `registry.rs:202-205` (`AgentType::try_from` → `custom_registry::is_registered`). This is the engine's native "add an agent" surface.
2. **codeg-mcp companion injection** — `src-tauri/src/acp/connection.rs:2770-2854` (`inject_codeg_mcp`): per-launch UUID token registered in the delegation `TokenRegistry`; args `--parent-connection-id`, `--socket-path`, `--token`, `--parent-pid` (self-cleanup watchdog), `--features` (tool-group gate: delegation/feedback/ask/sessions), `--custom-agents` / `--disabled-agents` (custom agents become delegate targets; disabled built-ins subtracted companion-side). Binary located via `CODEG_MCP_BIN`, exe sibling, PATH :2795-2803. This is the native "extend tool surface" mechanism.
3. **Delegation spawner trait** — `src-tauri/src/acp/delegation/spawner.rs:72-101`: `ConnectionSpawner { spawn, send_prompt_linked_for_delegation, cancel, disconnect }`; trait-decoupled so the broker never leaks engine types; `MockSpawner` for tests :103-119. Native "host child sessions" surface.
4. **KV store** — `app_metadata` service: the persistence primitive the auto-approve hook leverages (`custom_auto_approve.rs:15`); generic, already engine-native.
5. **Emit path** — `src-tauri/src/web/event_bridge.rs` `EventEmitter` enum is the **sole** event-emission channel; grep for `custom`/`CustomWorkflow` → **0 hits**. The custom layer currently emits no events (command/handler-driven only). This is a genuine extension ceiling (see Gaps).
6. **Adapter relations** — `registry.rs:240-260`: `acp_adapter_relation` covers exactly `ClaudeCode`/`Codex` (vendor-CLI ≠ ACP-adapter split); new adapters are engine-built constants.
7. **Binaries** — `src-tauri/Cargo.toml:39-50`: four targets — `codeg` (bin), `codeg_lib` (lib), `codeg-server` (no-default-features), `codeg-mcp` (no-default-features). Dual-mode compilation is a first-class engine capability.

### C. The patch seams (the price of the custom-layer approach)

Twenty patches in `newplugin/patches/` (untracked, read-only — **not** to be applied/regenerated per user constraint). They represent the one-time engine modifications committed in `aec0b9ff`; the tree is already at post-patch state (blob-hash spot check: all `NEITHER`/diverged — patches would not re-apply cleanly). Exactly **5 engine seams**:

1. `lib.rs` — module mount `:15`; startup: cron spawn `:714-726`, auto-approve hydrate `:727-738`; command registration `:1273-1279`.
2. `connection.rs` — auto-approve gate inside `handle_permission_request` :4515-4655, decision at `:4620`.
3. `router.rs` — auto-approve routes `:1152-1157`; workflow routes `:1197-1222` (`web_workflows::*` — note: the committed router patch's `b/` side references `handlers::custom_workflows::*`, which does not exist in the tree; the tree uses `web_workflows::*`, i.e. **the router patch is stale vs the committed design**).
4. `handlers/mod.rs` + `handlers/auto_approve.rs` (`:13-37` — global get/toggle HTTP handlers).
5. Frontend engine files carrying the route (see A.9) + `pendingPermissions` plumbing in `acp-connections-context.tsx` / `permission-dialog.tsx` (permission-queue cluster).

### D. Graph-level facts

- Qartez index: 1,187 files, 928 src / 259 test, 419,966 LOC, 34,215 symbols, 672 edges.
- **`newplugin/hooks/*` has 0 import edges in the qartez import graph** — the `#[path]` cross-tree mount is invisible to file-import indexing. Only frontend edge resolves: `workbench-content.tsx → custom-page.tsx → automation-editor.tsx`. Engineering implication: the custom layer is a blind spot for any import-graph tooling.
- cbm (codebase-memory): project `D-Temp-Codeg` indexed; `search_graph` live (804/791 results); anchors verified: `handle_permission_request` → `is_auto_approved`, `CustomCronEngine` chain, `CustomWorkflowsPage`.

---

## Anatomy

**Data flow (desktop):** UI (`custom-page.tsx`) → `lib/api.ts` RPC (`getTransport().call`) → `invoke()` → Tauri command (shim in `newplugin/hooks/mod.rs`) → business logic in `newplugin/hooks/custom_cron.rs` / `custom_auto_approve.rs` → engine `AppDatabase`/`ConnectionManager`/`app_metadata`. **Server:** same UI → `fetch()` → Axum handler in `web_workflows.rs` → same hook logic.

**Lifecycle:** `CustomCronEngine` spawned once from `lib.rs:714-726` (Tauri setup); auto-approve flag hydrated `:727-738`. Plugin modules own no windows/threads beyond the engine's own tokio runtime — the engine is the sole lifecycle owner.

**Three-layer coupling profile:**

| Layer | File location | Compile decoupling | Runtime/compile coupling |
|---|---|---|---|
| Hooks backend | `newplugin/hooks/` | survives upstream merges (committed, out-of-tree) | `crate::` paths ⇒ breaks on engine-internal moves |
| Hooks frontend | `newplugin/frontend/` | survives upstream merges | imports engine UI kit + `@/lib/api`; verbatim-copy drift risk |
| Engine seams | `src-tauri/src/*`, `src/components/*`, i18n | — | 5 seams; merge surfaces on every upstream pull |

**Fork/no-fork verdict.** The custom-layer approach is **viable for a large personal platform**: the four native surfaces (custom_registry, codeg-mcp, ConnectionSpawner, app_metadata) already cover agent registration, tool-surface extension, child-session delegation, and generic KV. The three backend seams (lib.rs mount/commands, connection.rs gate, router.rs routes) are small, stable, and re-appliable by hand after each upstream pull. **A fork is required only if** upstream churns those seams frequently, the platform needs to inject events into the engine's own pipeline (EventEmitter), needs UI component *reuse* rather than verbatim copies, or a major Tauri/Next upgrade breaks the `#[path]` + relative-import mechanics.

---

## Known Gaps

1. **Frontend copy-not-extend** — `automation-editor.tsx` is a verbatim copy of the native Automations editor. Any native editor change (props, composer API, AgentConfigSection) silently drifts the copy. Highest long-term maintenance risk.
2. **No hook event emission** — grep of `event_bridge.rs` returns zero custom-channel hits. Push-style hook features (progress, notifications, permission-request UI) have no native lane; they'd need a new seam.
3. **Router patch staleness** — `src-tauri-src-web-router.rs.patch` references `handlers::custom_workflows::*`; the tree registers `web_workflows::*`. The patch set is documentation, not a live mirror of the committed design.
4. **Graph blindness** — `newplugin/hooks/*` invisible to import-graph tooling (qartez 0 edges). Any future code-health tooling must special-case the `#[path]` mount.
5. **Merge-surface accounting** — the 5 seams live in engine files that upstream may rewrite. Each upstream pull needs a seam re-check (no automated rebase journal exists).
6. **`pendingPermissions` plumbing** (permission-queue cluster) reaches into `acp-connections-context.tsx` reducer + `conversation-shell.tsx` + `use-connection.ts` — a wider frontend seam than the backend's three.

## Next Steps

1. (Recommended) Keep custom-layer architecture; add a **seam re-application checklist** to `agent.md` for post-upstream-pull workflow.
2. Long-term: replace the connection.rs gate seam with an engine-native hook (e.g., a `PermissionResolver` trait defaulting to the current behavior) so the auto-approve feature needs zero engine edits — eliminates seam #2.
3. Long-term: convert `automation-editor.tsx` from copy to a parametrized native export (or accept drift with a diff-check script).
4. If push features are needed: propose a custom `EventEmitter` variant + WebSocket/tauri event channel as a new, additive seam (documented, not patched).
5. Store the 5-seam map + native surfaces as a cbm/ICM fact for future sessions (recorded — see below).

---

## Repository Knowledge Captured

- **Ownership:** engine = `src-tauri/src/**`, `src/**`, `src/i18n/**` (never edit); custom = `newplugin/hooks/**`, `newplugin/frontend/**` (edit freely); `newplugin/patches/**` = read-only archive.
- **Extension points (native):** `custom_registry.rs` (agents), `inject_codeg_mcp` `--features` contract (tool groups), `ConnectionSpawner` (delegation), `app_metadata` (KV).
- **Extension points (patch seams):** lib.rs mount/commands, connection.rs permission gate, router.rs routes, handlers, frontend route union + i18n.
- **Registration mechanics:** commands must be added in `lib.rs` (engine) but can live in `newplugin/hooks/mod.rs` as `#[tauri::command]` re-exports; routes can be added in `newplugin/hooks/web_workflows.rs` but must be registered in `router.rs` (engine).
- **Lifecycle:** engine tokio runtime owns all hook async; hook state via `OnceLock`/`Mutex` + engine `AppState`.
- **Data flows:** single transport abstraction (`getTransport().call`) covers desktop `invoke` + server `fetch`; hook RPCs must be mirrored in `lib/api.ts`.
- **Merge strategy:** upstream pulls land on engine files; the 5 seams are the only manual re-application points; `newplugin/hooks` + `newplugin/frontend` merge cleanly by virtue of being newplugin-only paths.
