# agent.md - Agent Operating Rules

Working guidance for Code Agent when working in this repository (Codeg).

> **Scope note:** this file is repo-owned documentation — it encodes this repository's
> conventions, not the user's personal instructions. Directives given by the user in
> conversation always take precedence over this file.

## Core System Profile

- **ROLE:** Building a custom platform **on top of** Codeg.
- **POLICY:** Never edit Codeg native engine files. Manage custom files/hooks only.

## Immutable Architect Rules

1. **Codeg = base platform/engine.** The custom platform is layered on top of it.
2. **Never edit Codeg native engine files** - this covers the Rust engine (`src-tauri/src/**`), the core TypeScript engine, and vendored native components.
3. **Custom work lives in `newplugin/` and custom platform files only.** New features for the custom platform are expressed as custom hooks, adapters, and extension points - not as patches to the engine.
4. **Engine code stays read-only** even for known defects. Bugs in the engine are flagged as open debt with `file:line` citations, never silently fixed.

## Carried State (repo invariants)

- **PATCH-ARCHIVE MODEL** (2026-08-06): engine + frontend tree = 100% pure `origin/main`
  (0.23.x) — zero custom seams in Codeg-owned files. Every custom feature lives ONLY as an
  apply-on-demand patch under `newplugin/patches/` (46 files: 17 legacy auto-approve +
  9 task-accept + 20 launch-target) and is OFF by default. Apply with
  `git apply newplugin/patches/<file>.patch` from the repo root on a clean `origin/main`
  checkout; all 46 pass `git apply --check` and compose cleanly in sequence (verified
  2026-08-06).
- **Archived features:** auto-approval (`web/handlers/auto_approve.rs` + `custom_hooks`
  hydration in `lib.rs`), task-accept (`workTaskAccept` command + route + review UI),
  launch-target (`local_folder_path` + `existing_conversation_id` resume for work-task and
  automation runs, incl. non-git Local Folder execution). Engine stays read-only even for
  defects; new features are expressed as `newplugin/` hooks or new patches, never edits.
- **Custom workflow feature is fully removed** (2026-08-06): sidebar tab, placeholder
  component, and route died with the upstream overwrite; no trace remains in tree or archive.
- Untracked, leave alone: `.qartez/`, `.github/workflows/codeg-portable-win64.yml`
- Open debt (read-only awareness, engine-side - flagged, not fixed): delete-channel ACP leak at `chat_channel.rs:78-90`.

## Extension Surface for the Custom Platform

- AgentType registry + `acp_adapter_relation` (`acp/registry.rs:240`)
- `ConnectionSpawner` trait (`acp/delegation/spawner.rs:86`)
- DB-persisted custom agents (`db/service/custom_agent_service.rs:160-162`)
- Sole event emission path: `emit_with_state_gated` (`web/event_bridge.rs:402-425`)
- Five prompt surfaces route through ConnectionManager (architectural center): `commands/acp.rs:8495-8507`, `web/handlers/acp.rs:165-188`, `automation/engine.rs:551-562`, `work_task/engine.rs:782-793`, `chat_channel/session_commands.rs:1563-1593`

## Project

Codeg (Code Generation) is a multi-agent coding workbench that unifies multiple agents
(Claude Code, Codex CLI, OpenCode, Gemini CLI, OpenClaw, Cline, ...) into a single
workspace: session aggregation, multi-agent collaboration, desktop install, and
server/Docker deployment.

## Tech Stack

- **Desktop runtime**: Tauri 2 (Rust backend + webview frontend)
- **Server runtime**: standalone Rust binary (Axum HTTP + WebSocket)
- **Frontend**: Next.js 16 (static export mode) + React 19 + TypeScript (strict)
- **Styling**: Tailwind CSS v4 + shadcn/ui (radix-maia style)
- **i18n**: next-intl
- **Database**: SeaORM + SQLite
- **Package manager**: pnpm

## Our Workflow (hard rules)

1. **Branch discipline**
   - `main` is a clean upstream mirror. NEVER commit to, modify, or merge into it.
   - All work happens on `plugin-dev` (or a task branch off it).
2. **Audit-first development**
   - Architecture understanding is done as phased audits; each phase produces a report
     under `audit/` (e.g. `audit/<phase>.md`) committed to `plugin-dev`.
   - Report format: objective / verified facts with `file:line` citations / anatomy /
     known gaps / next steps.
3. **Token economy**
   - Prefer indexed tooling over blind greps when safe (see Tooling).
   - Keep reports, comments, and commits tight — no filler.
4. **No installations under any circumstances** — the platform is built entirely from
   GitHub-hosted sources (pnpm/npm packages from the lockfile, crates from the Cargo
   lock, GitHub Actions, GitHub-hosted MCP servers). Do NOT propose or run `npm install`,
   `pip install`, `cargo install`, `brew install`, or any other package manager install.
   If a dependency is missing, flag it as open debt with `file:line` citation — do not
   silently add it. Vendored/built-in tooling only.

## Tooling (available via mcpproxy MCP)

Server names below are the EXACT `server:tool` prefixes to call — do NOT invent
abbreviations.

- **qartez** — codebase graph. Tools: `qartez_map`, `qartez_stats`, `qartez_refs`,
  `qartez_calls`, `qartez_deps`, `qartez_impact`, `qartez_context`, `qartez_test_gaps`,
  `qartez_diff_impact`, `qartez_grep`, `qartez_find`, `qartez_read`, `qartez_outline`,
  `qartez_hierarchy`, `qartez_security`, `qartez_wiki`, `qartez_hotspots`,
  `qartez_smells`, `qartez_health`, `qartez_cochange`, `qartez_semantic`,
  `qartez_blame`, `qartez_understand`, `qartez_path`, `qartez_unused`.
- **codebase-memory** — semantic knowledge graph. Server name is `codebase-memory`
  (NOT "cbm" — that shorthand appears only in older docs and is WRONG). Project id
  for this repo: `D-Temp-Codeg`. Tools: `search_graph`, `search_code`, `get_code_snippet`,
  `get_architecture`, `get_graph_schema`, `index_repository`, `ingest_traces`.
- **ICM** — session memory, facts, transcripts.

### MCP Tool Mandate (hard rules)

Indexed MCP tools MUST be used before any direct file read. They are faster,
graph-aware, and surface relationships that grep/Read cannot. Falling back to
manual reads when an indexed tool is available is a protocol violation.

Indexed MCP tools MUST be used before any direct file read. They are faster,
graph-aware, and surface relationships that grep/Read cannot. Falling back to
manual reads when an indexed tool is available is a protocol violation.

### Required tools by task type

| Task type | Required MCP tools (use BEFORE Read/grep) |
|-----------|------------------------------------------|
| Symbol/definition lookup | `qartez_find` or `qartez_grep` |
| Caller/callee tracing | `qartez_calls` + `qartez_refs` |
| Dependency graph | `qartez_deps` |
| Impact / blast-radius analysis | `qartez_impact` |
| Context gathering (files to read first) | `qartez_context` |
| Semantic / concept search | `codebase-memory:search_graph` |
| Architecture overview | `codebase-memory:get_architecture` |
| Test coverage gaps | `qartez_test_gaps` |
| Architecture wiki / cluster map | `qartez_wiki` |
| Code health / smells | `qartez_health` + `qartez_smells` |

### Pre-task discovery gate

Before ANY implementation or audit task:
1. Call `retrieve_tools` with a query matching the task.
2. State which MCP tools you will use and why.
3. Begin with those tools — do NOT default to Read/grep.

### Schema verification (MANDATORY before every MCP call)

The MCP tools do NOT share a common parameter schema. Before calling any tool you
have not used in the current session, verify the exact parameter names via the
`describe_tool` output or the schema shown in `retrieve_tools`. Known landmines:

| Tool | Wrong param | Correct param |
|------|-------------|---------------|
| `qartez_refs` | `name` | `symbol` |
| `qartez_calls` | `symbol` | `name` |
| `qartez_find` | `query` | `name` |
| `codebase-memory:search_graph` | `project_id` | `project` |

Using the wrong parameter name returns "missing property" — DO NOT retry with a
different guess. Call `describe_tool` first, then call with the correct schema.

### Security scanner avoidance

The qartez security scanner flags long digit sequences as `credit_card` (critical
severity). To avoid false positives:
- Do NOT pass raw UUIDs (e.g. `8d95177f-...`) as tool arguments.
- Do NOT pass long numeric ids (e.g. `1234567890`) as bare arguments.
- Wrap identifiers in objects or use short string keys instead.
- If a call triggers a credit_card detection, sanitize the input and retry.

### Graceful degradation when MCP fails

If an MCP tool call fails (server timeout, unavailable tool, any error):
1. Fall back to `Read`/`grep` immediately — do NOT stop the task.
2. Report the MCP failure in the response.
3. Continue with the audit using available tools.
4. MCP server flakiness is NOT a reason to abandon indexed tooling — retry the
   MCP tool later in the session; it may come back.

### Phase-gated audits

Architecture audits MUST follow these phases in order:
- **Phase 1 — Discovery**: `qartez_map` + `codebase-memory:search_graph` to map the landscape.
- **Phase 2 — Tracing**: `qartez_calls` + `qartez_refs` + `qartez_deps` to trace the full path.
- **Phase 3 — Impact**: `qartez_impact` + `qartez_context` to measure blast radius.
- **Phase 4 — Verification**: `qartez_test_gaps` to confirm coverage.

You may NOT skip a phase. Each phase's output must cite the MCP tools used.

### Completion verification

Before claiming any audit or implementation is complete, answer:
1. Which MCP tools did I use? (list them)
2. Which MCP tools were available but I did NOT use? (list them)
3. Why did I skip them?

If available tools were skipped without documented reason, the task is NOT complete.

## Architecture

### Dual-mode binaries (Cargo feature flags)

- **`codeg`** (`tauri-runtime`, default): full desktop app — Tauri window, notifications,
  auto-update
- **`codeg-server`** (no features, `--no-default-features`): standalone server — Axum
  HTTP API + WebSocket only
- **`codeg-mcp`** (no features): per-launch stdio MCP companion injected into agent CLI
  MCP configs; exposes **async** sub-agent delegation tools to the LLM

### Shared core

- **`app_state.rs`** — `AppState` shared state; `EventEmitter` enum distinguishes
  event emission per mode
- **`web/event_bridge.rs`** — `EventEmitter::Tauri(AppHandle)` or
  `EventEmitter::WebOnly(Arc<WebEventBroadcaster>)`
- **`web/router.rs`** — Axum router taking `Arc<AppState>`
- **`web/handlers/`** — HTTP API endpoints, all using `Extension<Arc<AppState>>`

### Rust backend (`src-tauri/src/`)

Reads/parses agent session files on the local filesystem:

- **`app_state.rs`** — shared state (db, connection manager, terminal manager, event
  broadcaster)
- **`models/`** — shared data structures
- **`parsers/`** — one parser per agent
- **`commands/`** — business logic; `_core` functions shared by both modes,
  `#[tauri::command]` functions desktop-only
- **`web/`** — Axum HTTP API + WebSocket + static file serving + auth middleware
- **`acp/`** — Agent Client Protocol connection management
- **`db/`** — SeaORM + SQLite

### Frontend (`src/`)

- **`lib/transport/`** — Transport abstraction (auto-switches `invoke()`/`fetch()` for
  Tauri/Web)
- **`lib/adapters/`** — AI response → component rendering adapters
- **`lib/types.ts`** — TypeScript mirror of Rust models; **`lib/api.ts`** — main API
  client; **`lib/tauri.ts`** — Tauri API wrapper
- **`i18n/`** — next-intl; 10 languages (en, zh-CN, zh-TW, ja, ko, es, de, fr, pt, ar);
  message files in `i18n/messages/`

### Data flow

- Desktop: frontend `invoke()` → Tauri command → business logic → data
- Server: frontend `fetch()` → Axum HTTP API → same business logic → JSON
- Real-time: backend events → EventEmitter (Tauri event / WebSocket broadcast) → frontend

### Conditional compilation

- `#[cfg(feature = "tauri-runtime")]` — desktop-only (Tauri window, notifications,
  `tauri::State` params, ...)
- `#[cfg_attr(feature = "tauri-runtime", tauri::command)]` — always compiled; only marked
  as a Tauri command in desktop mode
- `_core`-suffixed functions — plain reference params (`&AppDatabase`, `&EventEmitter`),
  shared by web handlers and Tauri commands

## Key Constraints

- **Static export only**: `next.config.ts` sets `output: "export"`; no dynamic routes
  (`[param]`) — use query params instead
- **Path alias**: `@/*` → `./src/*` (e.g. `@/lib/utils`, `@/components/ui/button`)
- **Server deployment**: env vars `CODEG_PORT`, `CODEG_HOST`, `CODEG_TOKEN`,
  `CODEG_DATA_DIR`, `CODEG_STATIC_DIR`
- **Docker**: multi-stage build (Node.js + Rust), `docker-compose` one-command deploy

## Code Style

- Prettier: no semicolons, trailing commas (es5), 2-space indent, 80-char width
- ESLint: next/core-web-vitals + typescript + prettier
- TypeScript: strict, `noUnusedLocals` + `noUnusedParameters`
- Rust: 2021 edition, `thiserror` for error types
