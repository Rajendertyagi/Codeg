# AGENTS.md

Working guidance for Code Agent when working in this repository (Codeg).

> **Scope note:** this file is repo-owned documentation — it encodes this repository's
> conventions, not the user's personal instructions. Directives given by the user in
> conversation always take precedence over this file.

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
3. **Verification gate** — nothing is "done" until it compiles and passes:
   - Frontend: `pnpm eslint .`, `pnpm test`, `pnpm build`
   - Rust (desktop, in `src-tauri/`): `cargo check`, `cargo test --features test-utils`,
     `cargo clippy --all-targets --features test-utils -- -D warnings`
   - Server: `cargo check --no-default-features --bin codeg-server`
     and `cargo clippy --no-default-features --bin codeg-server --lib -- -D warnings`
   - MCP: `cargo check --no-default-features --bin codeg-mcp`
4. **Token economy**
   - Prefer indexed tooling over blind greps when safe (see Tooling).
   - Keep reports, comments, and commits tight — no filler.
5. **No unnecessary installs** — prefer portable/built-in tooling.

## Tooling (available via mcpproxy MCP)

- **qartez** — codebase graph: `qartez_map`, `qartez_stats`, `qartez_refs`, `qartez_deps`,
  `qartez_impact`, `qartez_outline`, `qartez_read`, `qartez_context`, `qartez_test_gaps`,
  `qartez_diff_impact`, `qartez_grep`, `qartez_find`, ...
- **codebase-memory (cbm)** — semantic knowledge graph. Project id for this repo:
  `D-Temp-Codeg` (`index_status`, `search_graph`, `get_code_snippet`, `manage_adr`, ...)
- **ICM** — session memory, facts, transcripts.

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
