# Architecture Audit — Phase 1: Conversation & Session

**Date:** 2026-08-03
**Branch audited:** `plugin-dev` (`82b138f4`)
**Scope:** Conversation and Session architecture only. No other subsystem audited.
**Method:** Read-only. No code was modified. All findings cite `file:line` in the audited tree.

---

## 1. How is a conversation created?

A conversation is a **row in the `conversation` table** (`src-tauri/src/db/entities/conversation.rs:39`). Three creation paths, all funneling through `conversation_service`:

| Path | Service | Kind | Trigger |
|---|---|---|---|
| UI "New conversation" | `create` (`src-tauri/src/db/service/conversation_service.rs:12`) | `regular` | Sidebar/folder action → `create_conversation` command |
| Folderless chat mode | `create_chat` (`conversation_service.rs:35`) | `chat` | Chat section → hidden chat folder |
| Delegation child | `create_with_delegation` (`conversation_service.rs:60`) | `delegate` | `delegate_to_agent` MCP broker (`DelegationBroker`) |
| Import | `src-tauri/src/db/service/import_service.rs:308` | `regular` | Import picker — deduped by `(external_id, agent_type)` |

The row carries `folder_id`, `agent_type`, `status`, `kind`, `title`, `external_id`, parent/delegation linkage, `message_count`, `pinned_at`, `origin_cwd`, and soft-delete `deleted_at` (`src-tauri/src/db/entities/conversation.rs:41-73`).

**Critical second path:** if a prompt reaches a connection with no row yet, the backend creates it inline — `send_prompt_linked` Branch B (`src-tauri/src/acp/manager.rs:939-1003`) — so a conversation can be born from the send path, not just the create button.

## 2. How is a session created?

A session is a **live agent process over Agent Client Protocol (ACP)**:

1. `acp_connect` handler (`src-tauri/src/web/handlers/acp.rs:77`) builds a runtime env, preflights the agent binary, then calls `ConnectionManager::spawn_agent` (`src-tauri/src/acp/manager.rs:400`).
2. `spawn_agent` generates a server-side `connection_id` (uuid, `manager.rs:459`) and calls `spawn_agent_connection` (`src-tauri/src/acp/connection.rs:1098`), which spawns the agent CLI subprocess and registers an `AgentConnection` (`connection.rs:330`).
3. The **agent's own session id** (`external_id`) arrives later, when the process emits `SessionStarted`; the one-shot signal at `src-tauri/src/acp/session_state.rs:359` coordinates dedup waiters.

Dedup: a resumption with `session_id` reuses a live connection for the same `(agent_type, working_dir, session_id)` under a spawn lock (`manager.rs:411-457`) — this is what makes browser refresh re-attach instead of double-spawning.

## 3. Difference between conversation and session

| | **Conversation** | **Session** |
|---|---|---|
| Nature | Durable DB row — codeg's own bookkeeping | Live process + in-memory runtime state |
| Identity | `id: i32` (`src-tauri/src/db/entities/conversation.rs:43`) | `connection_id: uuid` (`src-tauri/src/acp/connection.rs:331`) |
| Session id | `external_id: Option<String>` on the row (`conversation.rs:55`) | `SessionState.external_id` (`session_state.rs:242`) |
| Lifecycle | Survives restarts, soft-deletable | Ephemeral — dies with the process |
| Contents | Metadata only — **no message bodies** | `LiveMessage`, `active_tool_calls`, pending permissions, `event_seq`, recent-events ring buffer (`session_state.rs:257-377`) |
| Status | `InProgress / PendingReview / Completed / Cancelled` (`conversation.rs:7`) | `Connecting / Connected / Prompting / Disconnected / Error` (`src-tauri/src/acp/types.rs:661`) |

A conversation exists without a session (cold history); a session is bound to at most one conversation row at a time. The agent's *on-disk* session (native store or codeg transcript) is the third, independent layer — the durable history (see Q5).

## 4. How are they linked?

The binding is `SessionState.conversation_id: Option<i32>` (`src-tauri/src/acp/session_state.rs:241`), established **at prompt time** in `send_prompt_linked_with_message_id` (`src-tauri/src/acp/manager.rs:816`):

- **Branch A** — caller pre-created the row: adopt via `AcpEvent::ConversationLinked` (`manager.rs:917-929`), no DB write.
- **Branch B** — no row: `create_with_delegation` + `ConversationLinked` + sidebar upsert broadcast (`manager.rs:957-1002`).
- `external_id` is persisted onto the row (`update_external_id`, `manager.rs:1023-1026`; `src-tauri/src/db/service/conversation_service.rs:255`), including the reverse-order case where `SessionStarted` fired before the link.
- **Reverse lookup:** `acp_find_connection_for_conversation` (`src-tauri/src/web/handlers/acp.rs:570`) → `ConversationConnectionInfo { connection_id, event_seq }` (`types.rs:683`) — used for cross-client viewer attach.

The whole link-check + DB-write + emit sequence runs under a per-connection `prompt_lock` (`manager.rs:861`) so concurrent sends (multi-tab, chat-channel race) can't double-create rows.

## 5. How are messages stored?

**There is no message table.** The entities inventory contains no `message` entity; storage is file-based + in-memory:

1. **Built-in agents** — their *native session stores* on disk (Claude Code JSONL under `~/.claude/projects/…`, Hermes SQLite, etc.). Read **on demand** by per-agent parsers (`src-tauri/src/parsers/claude.rs`, `parsers/hermes.rs`, …) — never written by codeg.
2. **Custom agents** — codeg records its own **ACP-native transcript**: `<root>/<registry-id>/<session-id>.jsonl` of raw `session/prompt` + `session/update` wire records, write-behind with a flush window (`src-tauri/src/acp_transcript.rs:1-65`), replayed by `parsers/acp_native.rs`.
3. **Live content** — `SessionState.live_message` / `active_tool_calls` in memory, broadcast over WS, snapshotted (`LiveSessionSnapshot`, `session_state.rs:1391`).
4. **Caches** — `message_count` on the row is a cache (set at insert/import, **recomputed from parsed turns at detail fetch**, `src-tauri/src/commands/conversations.rs:1099`); parser summaries are memoized by file fingerprint (`src-tauri/src/parsers/summary_cache.rs:34`).

The `chat_channel_message_log` table exists but belongs to the chat-channel subsystem — out of audit scope.

## 6. How does an agent attach to a conversation?

1. `ConversationDetailPanel` → `useConnectionLifecycle` (`src/hooks/use-connection-lifecycle.ts:110`) auto-connects: `acpConnect` (`src/lib/api.ts:173`) → `spawn_agent`.
2. If the conversation already has a live connection (another client), `acpFindConnectionForConversation` returns it and the new client attaches as a **viewer** (`isViewer`, `src/hooks/use-connection.ts:48`) — it subscribes but never owns/kills the agent (`shouldDisconnectOnUnmount`, `use-connection-lifecycle.ts:87`).
3. Attach protocol: cold snapshot (`acpGetSessionSnapshot`, `src/lib/api.ts:389`) → subscribe to the WS event stream (`src-tauri/src/web/ws_attach.rs`) with an `event_seq` cursor; mid-turn attach is served from `to_snapshot()`.
4. The **conversation↔agent row binding** itself only happens on first prompt (Q4) — until then the connection is conversation-less.

## 7. Where is conversation state stored?

Layered, backend-authoritative:

| Layer | Location | Contents |
|---|---|---|
| Durable identity | SQLite `conversation` table (`src-tauri/src/db/entities/conversation.rs`) | metadata, status, kind, linkage, soft-delete |
| History | Agent-native stores / codeg ACP transcripts (Q5) | message turns |
| Live authoritative | `SessionState` in `Arc<RwLock>` (`src-tauri/src/acp/session_state.rs:338`), per `AgentConnection` | stream, tool calls, permissions, seq |
| Frontend mirror | Zustand `src/stores/conversation-runtime-store.ts` (timeline: `persisted / optimistic / streaming` phases, `conversation-runtime-store.ts:50-61`) | rendered turns |
| Connection mirror | `src/contexts/acp-connections-context.tsx` (store keyed by `contextKey`) | connection status, selectors, pending dialogs |

## 8. What components own the conversation lifecycle?

**Backend**

- `ConnectionManager` (`src-tauri/src/acp/manager.rs:190`) — spawn/dedup/disconnect, prompt locks, idle sweeps, staleness.
- Connection driver + lifecycle subscriber (`src-tauri/src/acp/connection.rs`) — applies `AcpEvent`s to `SessionState`.
- `conversation_service` (`src-tauri/src/db/service/conversation_service.rs`) — row CRUD.
- `commands/conversations.rs` + `web/handlers/conversations.rs` — API + `conversation://changed` sidebar upsert broadcasts (`emit_conversation_upsert`).

**Frontend**

- `ConversationDetailPanel` (`src/components/conversations/conversation-detail-panel.tsx:1909`) — the workspace surface.
- `useConnectionLifecycle` (`src/hooks/use-connection-lifecycle.ts:110`) — connect/disconnect policy (owner vs viewer, transient unmount).
- `useConnection` (`src/hooks/use-connection.ts:163`) + `acp-connections-context.tsx` — connection store.
- `conversation-runtime-store.ts` — timeline reducer (optimistic → streaming → persisted).
- `ConversationShell` (`src/components/chat/conversation-shell.tsx:108`) — **pure presentational**; all state flows in via props.

## 9. Extension points

- **New built-in agent** = new parser implementing the parser contract + registry entry (see `src-tauri/src/parsers/*`); **custom agents** need no parser — they get the ACP-native transcript path (`src-tauri/src/acp_transcript.rs`).
- `AcpEvent` enum (`src-tauri/src/acp/types.rs:63`) is the wire contract — new events flow: `apply_event` → `emit_with_state` → reducer; opaque `meta: Option<serde_json::Value>` on `ToolUse` (`src-tauri/src/models/message.rs:118`) is the agent-defined extensibility channel (used by delegation).
- **Delegation:** `delegate_to_agent` MCP tool → `DelegationBroker` (`src-tauri/src/acp/delegation/broker.rs:1148`) → `create_with_delegation` child rows.
- **Lifecycle subscriber** pattern — this is where the plugin system hooks (auto-approve, cron, web workflows live under `plugins/backend/`).
- **`ConversationKind`** has a reserved `loop` variant for the loop engine (`src-tauri/src/db/entities/conversation.rs:33`).
- Frontend route registry `WORKBENCH_ROUTES` (`src/components/workbench/workbench-content.tsx:22`) — sidebar-visible full-page additions.
- Snapshot/attach protocol — any client can cold-attach mid-turn.

## 10. Risks of modifying this system

1. **No message table ⇒ parser fragility.** History fidelity depends on reverse-engineering each agent's private store; any persistence-shape change must touch parsers + `acp_transcript` + detail fetch together.
2. **Prompt-time linking is a delicate critical section.** `prompt_lock` + Branch A/B + `external_id` backfill ordering (`manager.rs:914-1034`) — a regression double-creates rows or strands the binding. The `SessionStarted`-before-link ordering is handled specially and is easy to break.
3. **`turn_in_flight` invariant** — rejecting a second prompt prevents silent drops; loosening it duplicates prompts/rows.
4. **Live state is authoritative for the UI.** Any new `AcpEvent` must be handled by the reducer AND `to_snapshot()` or mid-turn attach/refresh/cross-client viewers render stale state.
5. **`message_count` is recomputed from a parse at fetch** (`src-tauri/src/commands/conversations.rs:1099`) and used for sidebar sort (`:254`) — changing the parse path silently changes counts and ordering.
6. **Background-overlay watermark contract** — the race-free hand-off depends on both sides measuring the *same file* (`src/stores/conversation-runtime-store.ts:71-74`); changing file location/format breaks it.
7. **Snapshot payload size** — `ToolCallState.images` can be multi-MB per entry (`session_state.rs:103`); growth compounds on every attach.
8. **Soft-delete + import dedup invariants** — `ScanSessionStatus::Deleted` rows are never resurrected (`src-tauri/src/models/conversation.rs:169`); the `kind == Delegate ⟺ parent_id IS NOT NULL` invariant (`src-tauri/src/db/entities/conversation.rs:24`) and the delegation/`conversation_id` incompatibility guard (`manager.rs:849`) must not be weakened.

---

## Execution flow: User → Conversation → Session → Agent → Response → Storage

```
User
 ├─ ConversationDetailPanel → ChatInput → message-input.tsx (composer)
 ├─ useConnectionLifecycle.handleSend (hooks/use-connection-lifecycle.ts:110)
 │    └─ useConnection.sendPrompt → api.acpPrompt(connectionId, blocks,
 │         folderId, conversationId, clientMessageId) (api.ts:235)
 └─ Optimistic user turn pushed to conversation-runtime-store ("optimistic" phase)

Conversation
 ├─ If no row yet: send_prompt_linked_with_message_id (manager.rs:816)
 │    · Branch A: adopt caller row  /  Branch B: create_with_delegation
 │    · emit AcpEvent::ConversationLinked  →  session_state.conversation_id set
 │    · update_external_id backfill if SessionStarted already fired
 ├─ Else: existing row, status → InProgress (lifecycle subscriber)
 └─ Sidebar refresh via conversation://changed upsert

Session
 ├─ (already spawned) AgentConnection + SessionState; prompt_lock held
 └─ send_prompt_inner enqueues ConnectionCommand::Prompt → cmd_tx

Agent
 ├─ Connection driver task sends session/prompt over ACP (spawned process)
 └─ Agent assigns/keeps its session id; SessionStarted sets state.external_id

Response
 ├─ Agent streams session/update chunks
 ├─ apply_event → SessionState.live_message / active_tool_calls, seq++
 ├─ emit_with_state broadcasts → WS attach stream → frontend reducer
 │    (ai-elements-adapter) → timeline "streaming" phase
 ├─ ToolCall permission/questions interleave via PendingPermissionState
 └─ TurnComplete → status settle, turn_in_flight cleared

Storage
 ├─ Built-ins: turns land in the agent's native session store (codeg never writes)
 ├─ Custom agents: ACP wire appended to <root>/<registry-id>/<session-id>.jsonl
 │    (write-behind, acp_transcript.rs)
 └─ On re-open: get_folder_conversation_core (commands/conversations.rs:984)
      = DB row + parser re-parse → MessageTurns (summary_cache memoized)
      → message_count recomputed → sidebar/counts converge
```

---

*Scope note: the chat-channel subsystem (`chat_channel*` tables/handlers) was intentionally excluded per audit instructions.*
