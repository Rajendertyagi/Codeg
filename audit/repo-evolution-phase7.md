# Architecture Audit — Phase 7: Repository Evolution & Stability Analysis

**Date:** 2026-08-04
**Branch audited:** `plugin-dev` (HEAD `3745933d`, 36 commits ahead of `upstream/main`; merge-base `d665f7b1` = v0.23.0)
**Scope:** Whole-repository evolution and stability audit. Not a subsystem audit.
**Method:** Read-only. No code modified, no patches generated, no implementations proposed. All conclusions cite git history (commit hashes, tag dates) and the current tree (file:line). Primary sources: `git log/tag/shortlog/blame -S`, qartez index (1,187 files, 34,215 symbols), Phase 1–6 audit reports.

**Headline question — "Where should long-term software be built so it survives years of upstream Codeg evolution with minimal maintenance?"**

Answer from evidence: **on the four native extension surfaces (custom_registry, codeg-mcp contract, ConnectionSpawner, app_metadata) plus out-of-tree hook files — never inside `src-tauri/src/acp/connection.rs`, `manager.rs`, `web/router.rs`, `lib.rs`, `src/lib/api.ts`, or the i18n files.** Details and rankings in §3, §5, §10–§12, §15.

---

## 1. Repository Evolution

**Scale.** 2,053 commits, 129 release tags (`v0.0.14` → `v0.23.1`), ~150 days (2026-03-06 → 2026-08-03). One dominant author: `xintaofei` with 1,968/2,053 (95.8%); ~10 external contributors via PRs (Rajendertyagi 36, AnotiaWang, youxikexue, cnYui, noxenys, asxuen, ijry …). Velocity is ~400 commits/month, with no slow month (03:410, 04:431, 05:327, 06:480, 07:362, 08:43-to-date).

**Architectural timeline (subsystem birth dates, from `git log --diff-filter=A`):**

| Date | Milestone | Evidence |
|---|---|---|
| 2026-03-06 | Repo born; ACP core, parsers, terminal, `app_metadata` in initial commit | `54d1097b` |
| 2026-03-25 | Web/Axum server mode | `ac09d3db` ("初始化web服务功能") |
| 2026-03-26 | Transport abstraction introduced | `f61f9fb0` (first `src/lib/transport` change) |
| 2026-03-29 | `codeg_server` bin + `EventEmitter` enum (server/desktop split) | `080a16f2` ("支持无GUI的Server运行模式") |
| 2026-03-30 | Chat channels (IM bridge) | `d18cec33` |
| 2026-05-22 | `ConnectionSpawner` trait + `codeg_mcp` companion binary (delegation architecture) | `c80ed6d9`, `450e7fc1` |
| 2026-06-05 | Real-time sync; `send_prompt_linked_with_message_id` linking | `4eb9b8a9` ("feat(sync)") |
| 2026-06-21 | Automations/scheduler + workbench route registry | `063c4148`, `029a4d31` |
| 2026-07-03 | Frontend runtime stores (`conversation-runtime-store`) | `42e40a67` |
| 2026-07 | Custom-agent registry (`custom_registry.rs`, 4 commits, all July) | 0.21/0.22 window |
| 2026-08-01 | Work-task board engine (`work_task`, 4 commits) | `39d82ae7` |
| 2026-08-02 | Our `newplugin/` layer (F1–F6) | `89e4ba44`/`aec0b9ff` |

**Major architectural shifts (in order):**
1. **Desktop-only chat tool → dual-mode** (03-25/03-29): Axum server + `EventEmitter` enum split events per mode; `_core` command functions shared by Tauri wrappers and Axum handlers. This is the single most durable architectural decision in the repo — still the shape of every command today (`commands/*.rs` + `web/handlers/*`).
2. **Coding tool → collaboration tool** (03-30, 04-10…): chat channels, webhooks, real-time desktop/browser sync.
3. **Fixed agents → delegation model** (05-22): `ConnectionSpawner` + `codeg_mcp` companion with UDS broker round-trip; sub-agent sessions become a first-class concept.
4. **Interactive → scheduled** (06-21): cron automations engine with DB-backed CAS claim semantics.
5. **N fixed agents → any ACP agent** (07): `custom_registry.rs` runtime registry; agents became data (`custom_agent` DB rows), not code.
6. **Chat → task execution** (08-01): work-task engine with per-run git worktree isolation and agent-driven merging — born 2 days before v0.23.0.

**Which subsystems were rewritten vs. unchanged:** the ACP module was *continuously extended*, never rewritten; the frontend workspace shell was rebuilt repeatedly (title-bar tabs, four-topbar columns — `refactor(workspace)` commits in 0.20.4/0.21.x); settings pages were rebuilt multiple times ("rebuild the Kimi Code panel" 0.22.1, "rebuild the page layout" 0.23.0); the git-log tab was rebuilt (0.21.2 "redesign the commit-history tab as a virtualized, paginated timeline"); sidebar structure refactored through 0.5→0.10 era and again in 0.21. The parser layer and DB entity layer are the least-touched large surfaces (see §3).

## 2. Change Frequency

Measured over full history with `git log --name-only` (file-touch counts; each line = one commit touching that path):

**Directories** (top-level): `src/` 8,278 · `src-tauri/` 3,984 · `docs/` 500 · `newplugin/` 41.

**Backend (`src-tauri/src/`):**

| Path | Touches | Class |
|---|---|---|
| `acp/` | 729 | **Constantly Changing** (heartbeat) |
| `commands/` | 566 | **Constantly Changing** |
| `web/` | 455 | High Churn |
| `db/` | 253 | Moderate (34 migrations) |
| `parsers/` | 211 | Moderate |
| `lib.rs` | 165 | High Churn (registration point) |
| `chat_channel/` | 179 | High Churn (young, active) |
| `models/` | 93 | Stable |

**Frontend (`src/`):** `i18n/` 3,585 · `components/` 2,894 · `lib/` 971 · `contexts/` 377 · `app/` 233 · `hooks/` 164 · `stores/` 47.

**Classification:**

- **Very Stable:** `src-tauri/src/db/entities/conversation.rs` (6 touches ever), `app_state.rs` (25, last change July), `src/lib/transport/` (22; **zero touches since June**), `delegation/spawner.rs` (6, **all in May**), `src-tauri/src/models/` (93).
- **Stable:** `event_bridge.rs` (25, 1 in Aug), `parsers/` (211, mostly early), `db/` (253), `stores/` (29).
- **Moderate:** `chat_channel/` (179), `src/contexts/` (377).
- **High Churn:** `web/router.rs` (125: 11/24/21/37/25/7 per month), `lib.rs` (165), `src/lib/api.ts` (153: 14/32/25/42/33/7), `types.ts` (157), `commands/acp.rs` (115), `registry.rs` (104).
- **Constantly Changing:** `src-tauri/src/acp/` (729), `commands/` (566), `components/` (2,894), and the 10 i18n locale files (~355 touches **each** — every feature release touches all 10).

i18n deserves emphasis: `en.json` 363, `zh-CN` 366, `zh-TW` 367, and 7 more at 354 — the most-touched files in the repo after nothing. Any feature adds keys across all locales; any UI string change ripples through them. **Never patch i18n files.**

## 3. Stable APIs

APIs that survived across releases, with why they look stable:

| API | Born | Changes since | Evidence of durability |
|---|---|---|---|
| `app_metadata` KV service | 03-06 `54d1097b` | last touched July (25 commits) | Present in initial commit; used by the auto-approve hook (`newplugin/hooks/custom_auto_approve.rs:15`). A generic KV store survives because it has no policy baked in. |
| `EventEmitter` enum + `emit_with_state_gated` | 03-29 `080a16f2` | 25 commits, 1 in Aug | Created for the server split; still the sole event lane (`web/event_bridge.rs`). Shape stable despite ACP growth. |
| `_core` dual-mode command pattern | 03-25 | pervasive | Every command is `_core` fn + `#[tauri::command]` wrapper + Axum handler. The pattern is enforced by convention and has never been challenged. |
| Transport abstraction (`getTransport().call`) | 03-25 `ac09d3db` | **0 changes since June** | Last touched 06 (3 commits); remote-desktop transport added 05-13. Frozen — the most stable frontend seam. |
| `ConnectionSpawner` trait | 05-22 `c80ed6d9` | **0 changes since May** | 6 commits, all in the birth month. Delegation contract stable for 2.5 months through 20+ releases. |
| `send_prompt_linked_with_message_id` | 06-05 `4eb9b8a9` | manager.rs 69 total | Introduced by sync feature; is now the launch primitive used by UI, automations (`engine.rs:551`), tasks. |
| `compute_next_run` / cron math | 06-21 | `automation_service.rs` 3 commits | Single source of truth for schedule evaluation; young but centralized by design (Phase 2). |
| DB entity layer | 03-06 | `conversation.rs` 6 commits | Entities barely move; migrations are additive (34 migrations, none destructive). |
| `WORKBENCH_ROUTES` + `workbench-route-context.tsx` | 06-21 `029a4d31` | 3 commits | Frontend full-page registry; stable because it is just a union type + lookup. |
| `custom_registry.rs` | 07 (0.22) | 4 commits, none since | Too young to certify, but designed as the extension point (module doc `custom_registry.rs:1-32`). |

**Why these appear stable:** each is (a) a *boundary* with no feature policy — KV stores data, traits define contracts, registries list entries; (b) born at an architectural pivot (server split, delegation, sync) and then left alone; or (c) enforced by convention (`_core` pattern) rather than machinery. Stability correlates with *generality*, not age: the 06-05 sync primitive is younger than `connection.rs` but far more stable.

## 4. High-Risk Files

Files with the highest touch counts and the reason custom code should avoid them:

| File | Touches | Why it churns | Architectural importance | Custom-code policy |
|---|---|---|---|---|
| `src-tauri/src/acp/connection.rs` | 129 | ACP wire protocol, permission handling, agent-version adaptations; every agent integration touches it | The execution plane (Phase 5: `run_connection` loop `:2994`) | **Red — never touch.** Our permission gate seam sits here (`:4515-4655`); each upstream pull re-checks it. |
| `src-tauri/src/acp/registry.rs` | 104 | Agent table/`AgentType::try_from` churns with every agent vendor release and custom-agent additions | Agent identity mapping | **Yellow.** Consume `is_registered`/`AcpAdapterRelation` (`:200-260`); never edit. |
| `src-tauri/src/acp/manager.rs` | 63 | Prompt admission, linking, lifecycle; 22 touches in June alone | The control plane (Phase 5) | **Red — never touch.** |
| `src-tauri/src/commands/acp.rs` | 115 | Command surface grows with every feature | Public API surface | **Yellow.** Use `_core` fns; don't add to it. |
| `src-tauri/src/lib.rs` | 165 | `invoke_handler` + module list + startup grow every release | Registration point (our seam: mount `:15`, spawn `:714-738`, commands `:1273-1279`) | **Yellow.** Our 6 hook commands re-register here; re-apply after each pull. |
| `src-tauri/src/web/router.rs` | 125 | Route registration grows with every web feature | Route registry (our seam `:1152-1157`, `:1197-1222`) | **Yellow/Red.** Same re-application burden. |
| `src/lib/api.ts` | 153 | Transport-agnostic RPC layer; mirrors every backend command | Frontend API surface (our hook RPCs at `:2602-2653`) | **Yellow.** Additive only; expect merge conflicts each pull. |
| `src/lib/types.ts` | 157 | Wire types mirror Rust models | Shared types | **Yellow.** Additive only. |
| `src/i18n/messages/*.json` (×10) | ~354-367 each | Every feature + every string change | Localization | **Red — never patch.** Add namespaces only via upstream flow. |
| `src/components/conversations/conversation-detail-panel.tsx` | 142 | Continuous UI evolution | Workspace surface | **Red — never touch.** |
| `src/components/chat/message-input.tsx` | 115 | Composer hot path | Composer | **Red — never touch.** |
| `src/contexts/acp-connections-context.tsx` | 87 | Connection store + reducer evolves | Our `pendingPermissions` seam lives here (Phase 6 gap #6) | **Yellow.** Wider frontend seam than the backend's three. |

## 5. Long-Term Seams

Seams that have survived multiple releases, classified:

**Very Stable (survived 2.5+ months / 20+ releases unchanged):**
- Transport abstraction (`src/lib/transport/index.ts`) — frozen since June.
- `ConnectionSpawner` trait (`delegation/spawner.rs:72-101`) — frozen since May.
- `app_metadata` KV — present since initial commit.
- `EventEmitter` + `emit_with_state_gated` — stable since 03-29.
- `_core` dual-mode command pattern — invariant since 03-25.

**Moderately Stable (survived but churn on approach):**
- `WORKBENCH_ROUTES` + route union (3 commits since 06-21).
- `compute_next_run` cron evaluator (young, centralized).
- `send_prompt_linked_with_message_id` launch primitive (06-05).
- `custom_registry` custom-agent registry (born 0.22 — native, additive; but only 4 commits of history).

**Likely to Change (churning every release — do not build on directly):**
- Command registration in `lib.rs` (165 touches; our seam #1).
- Route registration in `router.rs` (125; seam #3).
- Permission gate in `connection.rs` (129; seam #2).
- `api.ts` / `types.ts` transport surface (153/157).
- i18n files (~355 each).
- `acp-connections-context.tsx` reducer (87).

## 6. Release Evolution

Release cadence (tag dates from `git log -1 --format=%ad`):

| Release | Date | Days since prev |
|---|---|---|
| v0.0.14 (first) | 03-06 | — |
| v0.1.0 | 03-11 | 5 |
| v0.5.0 | 03-29 | 18 |
| v0.10.0 | 04-23 | 25 |
| v0.15.0 | 06-06 | 44 |
| v0.20.0 | 07-11 | 35 |
| v0.21.0 | 07-18 | 7 |
| v0.22.0 | 07-29 | 11 |
| v0.23.0 | 08-02 | 4 |
| v0.23.1 | 08-03 | **1** |

129 releases in ~150 days ≈ **one release every 1.2 days**. Cadence accelerated sharply in July–August (weekly → daily). Direction per window (commit subjects):

- **0.1→0.5:** multi-agent breadth (Gemini history scan, agent icons for cline/goose/codebuddy/corust…).
- **0.5→0.10:** folder/branch UX, sidebar polish, provider expansion.
- **0.10→0.15:** server mode, channel webhooks, real-time sync, delegation dialogs, self-update.
- **0.15→0.20:** 11th agent (Grok), Claude out-of-turn activity, science skills, **performance investment** (parser summary cache, bundle lazy-loading).
- **0.20→0.21:** workspace chrome rebuild (title-bar tabs, edge chrome), Telegram topics, custom skills tab.
- **0.21→0.22:** **custom agents** (registry, editing, MCP servers for custom agents, delegation targets, skills dirs), tab groups, git-log rebuild.
- **0.22→0.23:** **work-task board** (worktree isolation, agent-driven merging, conflict auto-repair, live transcripts), automations page rebuild, permission-option explanations.
- **0.23→0.23.1:** task-stage instructions, workspace folder linking, task result rendering.

**Direction:** coding tool → agent platform → **workflow/automation platform**. Each 0.x release adds a new "operating" layer rather than deepening the editor: agents (0.22), tasks (0.23). The editor remains but the investment shifts to orchestration.

## 7. Architectural Trends

Recurring themes, evidenced from commits:

1. **Generalization over specialization** — the strongest trend. Fixed agent list → `custom_registry` (data-driven agents); built-in-only skills → custom skills (0.20.2, 0.21.x); fixed channel set → `ChatChannelBackend` trait with default-impl half-backends (Phase 4, `backends/mod.rs:11-66`). Each feature is re-architected from "N special cases" to "N + open registry" within one or two releases.
2. **Dual-mode everything** — every backend feature is built once as `_core` and exposed to both Tauri and Axum (invariant since 03-25). Frontend mirrors this with the transport abstraction.
3. **Isolation as a feature** — worktree-per-run isolation (`automation/engine.rs:590-623`, work tasks), process-tree kill backstops, per-run DB advisory lock (`engine.rs:171-212`). The platform increasingly executes *untrusted* long-running work.
4. **Event-driven UI, not RPC-polled UI** — `AcpEvent` wire contract (Phase 1, `acp/types.rs:63`), real-time sync, `send_prompt_linked_with_message_id` dedup, global event listener (0.22.1 fix).
5. **Plugin investment is upstream-owned now** — 0.21/0.22 absorbed the plugin features we re-implemented (custom agents, permission options, skills) into the core natively; our `newplugin/` layer (08-02) rides on top, and upstream continues shipping extension points (permission-option explanations 0.23.0, `AcpAdapterRelation`).
6. **Perf hardening** — only during 0.15–0.20 (parser cache, bundle splits, memoized timeline), then paused as features took over (0.20→0.23: 1 `perf` commit).

## 8. Technical Debt

Evidence of areas maintainers are actively improving (and some they are not):

- **Repeated UI rebuilds:** workspace shell rebuilt 3× in 0.20.4–0.21.x; git-log tab rebuilt twice (0.21.2, 0.21.6); Kimi panel rebuilt (0.22.1); automations page rebuilt (0.23.0). High UI churn is *deliberate* — the chrome is the product.
- **Dead code / stale schema found in prior phases** (still open): `git.rs` dead merge/commit helpers (~100 lines, Phase 3 F1); `pending_merge` column never written (Phase 3 F2); delete-channel ACP leak `chat_channel.rs:78-90` (Phase 4, medium); in-memory `SessionBridge` with no restart recovery (Phase 4); `SessionState` snapshot uncapped (Phase 5).
- **Migration cadence is healthy:** 34 additive migrations, 35 commits touching them; no destructive migration seen.
- **Monolith files** that keep growing: `session_commands.rs` (2,201 lines), `event_subscriber.rs` (1,734), `custom_registry.rs` (1,355), `connection.rs` — the maintainer ships features before refactors; debt is concentrated but documented.

## 9. Upstream Priorities

Subject-area classification of the last ~335 commits (v0.20.0..v0.23.1), by `(area)` prefix:

| Area | Commits | Reading |
|---|---|---|
| `acp` | 43 | **#1 — the protocol and manager layer is where most engineering goes.** |
| `chat` | 30 | Composer/transcript UX — constant polish. |
| `workspace` | 19 | Shell chrome — active design churn. |
| `tasks` | 12 | Newest subsystem, front-loaded in 0.23.0. |
| `settings` | 11 | Rebuilt repeatedly. |
| `codex` + `grok` + `kimi` + `claude` | 19 | Per-agent vendor integrations — never-ending treadmill. |
| `agents` + `skills` | 8 | Custom-agent generalization. |
| `tabs`/`delegation`/`sidebar`/`editor` | 5-6 each | Ongoing. |
| `perf` | 0-1 | Paused. |

**Investment ranking:** ACP (protocol+manager) → UI polish → per-agent vendor integration → feature engines (tasks, automations, channels). Infrastructure (`perf`, `test`, `i18n`) is minimal. The maintainer spends the largest share keeping the ACP core adapting to vendor protocol churn — which is exactly why `connection.rs`/`registry.rs` are the highest-risk files for us.

## 10. Plugin Survivability

If someone maintained a custom layer for 2–3 years (using our custom layer as the reference):

**Integration points likely to survive:**
- `app_metadata` KV reads/writes (day-one API, no policy, stable).
- `getTransport().call` frontend RPCs (frozen since June).
- `custom_registry` custom-agent registration (native since 0.22 — upstream is *investing here*, the best sign of durability).
- `ConnectionSpawner`/delegation contract (frozen since May).
- i18n *namespaces* (additive; the files churn but the mechanism is permanent).
- `WORKBENCH_ROUTES` full-page registration (3 commits in 6 weeks).
- Out-of-tree `newplugin/hooks/**` + `newplugin/frontend/**` files themselves — git-tracked on our branch, they merge cleanly by being newplugin-only paths (Phase 6 §3).

**Integration points requiring repeated rebasing (evidence-based):**
- Command registration in `lib.rs` (165 touches/5mo ≈ every 5th commit).
- Route registration in `router.rs` (125 touches — same).
- Permission gate in `connection.rs` (129 touches; our seam #2 is in the most-churned file in the backend).
- `api.ts` + `types.ts` (153/157 touches).
- i18n JSON files (~355 touches each — will conflict on every feature pull).
- `acp-connections-context.tsx` reducer (87 touches).

Quantified: our 5 engine seams sit in files that average **25–33 touches/month**. Expect a seam re-check on every upstream pull; plan for it as workflow (Phase 6 next-step #1), not as a surprise.

## 11. Engine Modification Risk

Classification for our own custom-layer work (and any custom code):

**GREEN — safe long-term (no engine edits, additive use only):**
- `app_metadata` KV (use for feature state).
- Transport `getTransport().call` (add RPC calls in `lib/api.ts`-style wrappers in our own files).
- `custom_registry` (register custom agents; no edits).
- `ConnectionSpawner` (implement the trait; no edits).
- `EventEmitter` (read events; add a new variant only as a documented additive seam — Phase 6 next-step #4).
- Out-of-tree `newplugin/hooks/**`, `newplugin/frontend/**`.

**YELLOW — needs occasional review (engine seams we currently touch):**
- `lib.rs` mount + command re-registration (`:15`, `:714-738`, `:1273-1279`).
- `router.rs` route registration (`:1152-1157`, `:1197-1222`).
- `handlers/auto_approve.rs` + `handlers/mod.rs`.
- `connection.rs` permission gate (`:4515-4655`) — the *most* fragile seam; recommend replacing with an engine-native hook (Phase 6 next-step #2) or re-checking each pull.
- Frontend route union (`workbench-route-context.tsx:21-25`) + `acp-connections-context.tsx` reducer plumbing.

**RED — avoid completely (never patch, never build on):**
- `connection.rs` internals (execution loop, permission flow).
- `manager.rs` internals (prompt admission, linking).
- `session_state.rs`, `conversation-runtime-store.ts` (invariants, Phase 1 risks).
- `session_commands.rs` / `event_subscriber.rs` (2201/1734-line state machines).
- Parser files (`parsers/*`) — tied to vendor transcript formats.
- i18n JSON files.

## 12. Future Compatibility

Inferred from repository evolution (not guesses):

- **Most likely stable:** the four native extension surfaces (§3), because upstream keeps *investing in them* (custom agents 0.22, permission explanations 0.23) rather than replacing them; the transport abstraction, because the desktop/server dual-mode is foundational (invariant since 03-25); the DB entity + migration layer, because no destructive migration has ever landed.
- **Likely stable but must re-check:** `_core` dual-mode pattern (invariant, but new commands keep landing), `send_prompt_linked_with_message_id` (the launch primitive — could be refactored as session models evolve), `WORKBENCH_ROUTES`.
- **Most likely to change:** `connection.rs`/`registry.rs`/`manager.rs` (vendor protocol churn is the maintainer's biggest work item — §9), `lib.rs`/`router.rs` registration (every feature adds entries), `api.ts`/`types.ts`, i18n files, and all UI components (deliberate chrome churn).
- **New subsystems will keep landing** (tasks in 08-01 is the pattern: a new `engine.rs` + service + UI within one release window) — expect future automation/task/channel surfaces to be added the same way, not retrofitted.

## 13. Repository Health

| Dimension | Rating | Evidence |
|---|---|---|
| Architecture consistency | **Strong** | Dual-mode `_core` pattern invariant since 03-25; single event model; Phase 5 showed every execution path flows through ConnectionManager. |
| Code organization | **Good, with hot-spots** | Clear `acp/commands/web/db/parsers` split; but 2,200-line state machines and 1,355-line registries exist. |
| Modularity | **Good** | Subsystems are directory-separated with clean seams (spawner trait, backend trait, engine/loop patterns). |
| Boundary quality | **Mixed** | Backend boundaries excellent (traits + registries); frontend boundaries weaker (verbatim-copy drift risk, Phase 6 gap #1); i18n is a cross-cutting churn magnet. |
| Extension friendliness | **High and rising** | Upstream converted 5 features to registries in 2 releases (custom agents, custom skills, custom channels, custom models, adapter relations). |
| Long-term maintainability | **Medium-High** | Solo maintainer (96% commits) is the biggest risk; UI churn is high; but the core (ACP + dual-mode + DB) is demonstrably stable. |

## 14. Architectural Direction

Based only on repository history, **Codeg is becoming an agent-operating / workflow-automation platform, not a coding tool.** Evidence:

- 0.0–0.5: coding assistant (transcript parsing, multi-agent chat). Parser-centric.
- 0.5–0.15: collaboration platform (server, channels, real-time sync, delegation).
- 0.15–0.22: general agent platform (11 vendor agents → *any* ACP agent, custom skills, MCP).
- 0.22–0.23: **automation platform** (scheduled automations → task board with worktree isolation and agent-driven merges — machines driving agents, not just humans).
- Branch naming upstream (`botwork`, `weixin`, `channel`, `remote-ssh`, `loop-0620`, `one`) shows parallel feature investment in orchestration, IM, and remote access.
- The trajectory of the last 4 releases (custom agents → tasks → automations rebuild) points to **"AI workflow operating system":** agents as resources, work as schedulable units, isolation as the safety model.

## 15. Strategic Guidance (Evidence Only)

For a large personal AI platform built on Codeg for the next five years:

**Safe to depend on (build here):**
1. `app_metadata` KV + `custom_registry` custom agents + `ConnectionSpawner` delegation + transport `getTransport().call` — the four native surfaces. Upstream invests in them (§9) and leaves them stable (§3).
2. Out-of-tree hook files (`newplugin/hooks/**`, `newplugin/frontend/**`) — merge-clean by construction (Phase 6).
3. The `_core` dual-mode + single-event model — invariant for 5 months, foundational.
4. Additive seams with precedent: new workbench routes, new i18n namespaces, new `lib/api.ts`-style RPC wrappers *in our own files*.

**Too volatile to build on directly (expect repeated rebasing or avoid):**
1. `connection.rs` permission flow (129 touches — the single most unstable backend file; our gate seam #2 is here).
2. `lib.rs`/`router.rs` registration (25–33 touches/month each).
3. `api.ts`/`types.ts` (153/157 touches).
4. All i18n JSON content (355 touches each — add keys through upstream flow, never patch).
5. Any UI component (components = 2,894 touches; chrome is deliberately rebuilt).
6. Per-agent vendor adapters (`codex/grok/kimi/claude` integration code) — the vendor-churn treadmill.

**Bottom line:** the durable core is the *mechanism* layer (transport, event model, registries, KV, delegation contract). The volatile layer is the *vendor+UI* layer (protocol adaptation, chrome, i18n). Build the platform on mechanisms, decoupled from vendor and UI churn, and it survives upstream evolution with only the known 5-seam re-application cost per pull.

---

## Repository Knowledge Captured

- **Evolution timeline:** 03-06 birth → 03-25/29 dual-mode split → 03-30 channels → 05-22 delegation+companion → 06-05 sync linking → 06-21 automations → 07 custom agents → 08-01 work tasks → 08-02 our custom layer. 129 releases, ~1 per 1.2 days, 96% single-maintainer.
- **Stable seams:** transport (`src/lib/transport/`, frozen since June), `ConnectionSpawner` (`delegation/spawner.rs:72-101`, frozen since May), `app_metadata` (day-one), `EventEmitter` (03-29), `_core` dual-mode pattern (03-25), `WORKBENCH_ROUTES` (06-21).
- **High-churn areas:** `src-tauri/src/acp/` (729 touches; `connection.rs` 129, `registry.rs` 104, `manager.rs` 63), `lib.rs` (165), `router.rs` (125), `api.ts` (153), `types.ts` (157), i18n ×10 (~355 each), `commands/acp.rs` (115).
- **Long-term extension points:** custom_registry (agents), codeg-mcp `--features` contract, ConnectionSpawner (delegation), app_metadata (KV), workbench route union, i18n namespaces.
- **Risk classification:** GREEN = 4 native surfaces + out-of-tree hooks; YELLOW = the 5 engine seams (lib.rs, router.rs, handlers, connection.rs gate, frontend route union + pendingPermissions); RED = connection.rs/manager.rs internals, session state, parsers, i18n files, UI components.
- **Upstream direction:** agent-operating/workflow-automation platform (agents → automations → tasks); ACP protocol work is #1 investment; UI chrome churns deliberately; perf investment paused since 0.20.
- **Key prior-phase debts (open):** delete-channel ACP leak (`chat_channel.rs:78-90`), dead `git.rs` helpers + `pending_merge` column (Phase 3), in-memory `SessionBridge` (Phase 4), uncapped `SessionState` snapshot (Phase 5).

