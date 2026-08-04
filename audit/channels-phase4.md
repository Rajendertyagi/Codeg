# Phase 4 Audit: Chat Channels Subsystem (`src-tauri/src/chat_channel/`)

**Date:** 2026-08-04 (branch `plugin-dev`)
**Scope:** `chat_channel/` module + channel DB entities/services + integration points (ACP bus, lib.rs startup, server binary, web router, keyring store)
**Method:** read-only audit; every claim carries a `file:line` citation against the current `plugin-dev` working tree.

---

## 1. Anatomy

```
 External IM platforms
   Telegram (long-poll getUpdates, 30s timeout)   Lark (WS pbbp2, cursor)   Weixin (iLink cursor-poll)
   backends/telegram.rs:300-353                   lark.rs:442-521           weixin.rs:595-711 (voice:608-625)
        |  IncomingCommand (types.rs)                                     ^ outbound RichMessage
        v                                                                 |
 ChatChannelManager (manager.rs) ------------------------------------------+
   Inner { channels: Mutex<HashMap<i32, ActiveChannel>>,
           command_tx/rx: mpsc::channel(256)  manager.rs:43 }
   start_background(...)  manager.rs:340-348
        | command_tx                                             ^ send_to_target
        v                                                        |
 CommandDispatcher (command_dispatcher.rs)                        |
   loop :69-143 | inbound log :79-88 | prefix from chat_command_prefix metadata (default "/")
   lang cache 30s TTL | response log :179-188                      |
   +-- /task /resume /approve /deny  -> session_commands.rs        |
   +-- /search /today /status /help -> command_handlers.rs         |
   +-- callback_data -> handle_callback (permissions/buttons)      |
   +-- no-prefix text -> followup via find_by_sender :65-69        |
        v                                                          |
 SessionBridge (session_bridge.rs)                                 |
   ActiveSession keyed by connection_id (HashMap :39-42)           |
        | ConnectionManager.spawn_agent (acp/)                     |
        v                                                          |
 ACP Engine (conversations / sessions) -----------------------------+
        | Arc<EventEnvelope>
        v
 InternalEventBus (acp/internal_bus.rs) -- broadcast, BUS_CAPACITY=4096 :32
   +-- session_event_subscriber (bridged sessions, session_event_subscriber.rs:33)
   +-- event_subscriber (global push, event_subscriber.rs:200-256)
   +-- lifecycle / pet state mapper (acp-internal, out of scope)
   +-- WebEventBroadcaster (web/event_bridge.rs -> WS clients)
        |                         |
        v                         v
 send_to_target -> backend.   chat_channel_message_log_service
 send_rich_message_to         (outbound log for global push only, :387-396)
 (telegram MarkdownV2 / lark card / weixin text)
        |
        +-- Scheduler (scheduler.rs): daily report, 60s loop, LOG_RETENTION_DAYS=30
        +-- Webhook (webhook.rs): outbound HTTP sinks, WebhookConfig
 Storage: SQLite (sea-orm) -- chat_channel | chat_channel_sender_context
          chat_channel_thread_binding | chat_channel_message_log | app_metadata
 Secrets: keyring_store.rs (desktop) / tokens.json (server)
```

**File map (16 modules + 4 entities + 5 services):**

| File | Lines | Role |
|---|---|---|
| `mod.rs` | 16 | Public module list |
| `types.rs` | 223 | `ChannelType`, per-channel configs, `ChannelMessageTarget`, `IncomingCommand`, `RichMessage`, `InteractiveMessage` (:185-223) |
| `traits.rs` | 93 | `ChatChannelBackend` trait -- the transport abstraction |
| `error.rs` | 41 | `ChatChannelError` -> `AppCommandError` conversions |
| `manager.rs` | 474 | Lifecycle, backend map, command mpsc (256), status events, `send_to_target` |
| `session_bridge.rs` | 103 | `ActiveSession`/`PendingPermission`, sessions keyed by `connection_id` |
| `scheduler.rs` | 160 | Daily report loop + message-log retention (30d) |
| `command_dispatcher.rs` | 548 | Inbound routing: prefix commands, callbacks, followups, i18n prefix/lang |
| `command_handlers.rs` | 133 | `/search`, `/today`, `/status`, `/help` sync handlers |
| `session_commands.rs` | 2201 | `/task`, `/resume`, `/cancel`, `/approve`, `/deny`; session lifecycle, streaming, owner labels |
| `message_formatter.rs` | 271 | Rich -> per-backend formatting (MarkdownV2, card JSON) |
| `tool_detail.rs` | 221 | Tool-call detail formatting |
| `event_subscriber.rs` | 1734 | Global ACP-event -> channel push + webhooks |
| `session_event_subscriber.rs` | 1592 | Bridged-session event -> reply routing, buffering, permissions |
| `i18n.rs` | 1624 | Per-language strings (`Lang` enum + tables) |
| `webhook.rs` | 344 | Webhook sinks, config, delivery |
| `backends/mod.rs` | 66 | `create_backend()` factory + config validation |
| `backends/telegram.rs` | 1051 | Telegram long-poll transport |
| `backends/lark.rs` | 760 | Lark WebSocket (pbbp2) transport |
| `backends/weixin.rs` | 802 | Weixin iLink cursor-poll transport |

DB layer: `db/entities/chat_channel.rs`, `chat_channel_sender_context.rs`, `chat_channel_thread_binding.rs`, `chat_channel_message_log.rs`; services in `db/service/` (`chat_channel_service`, `sender_context_service`, `thread_binding_service`, `chat_channel_message_log_service`, `app_metadata_service`). Command layer: `commands/chat_channel.rs` (892 lines, `_core` functions shared desktop/web).

---

## 2. Overall Architecture

**Ownership & startup.** The subsystem is owned entirely by the `chat_channel` module and instantiated in shared app state, so it exists in **both** runtimes:

- Desktop: `lib.rs:213` `.manage(ChatChannelManager::new())`; startup block `lib.rs:433-453` passes broadcaster, `InternalEventBus`, DB connection, `data_dir`, `ConnectionManager`, `EventEmitter` to `start_background(...)` (`manager.rs:340-348`).
- Server: same sequence in `bin/codeg_server.rs` (~:402-412); `EventEmitter::WebOnly(Arc<WebEventBroadcaster>)` replaces the Tauri handle.

**Two runtime roles, one module.** The module is both a *receiver* (IM -> commands/sessions) and a *sender* (agent events -> IM). The sender half has two distinct paths:

1. **Bridged sessions** (user invoked `/task`/`/resume` from the IM) -- replies route to the exact chat/thread via `session_event_subscriber` -> `manager.send_to_target` -> `backend.send_rich_message_to`.
2. **Global push** (end-of-turn events for *non-channel* sessions, e.g. desktop-initiated agent runs) -- `event_subscriber` pushes to every **enabled** channel's configured chat (fail-closed filter, `event_subscriber.rs:313-317`).

**Threading model.** One background task owns the command mpsc consumer (`command_dispatcher.rs:69-143`); each backend runs its own poll/WS task; the two bus subscribers run their own loops. Shared mutable state is confined to `Mutex<HashMap>` in `manager.rs:43` and the `SessionBridge` mutex.

**Secrets.** Desktop stores channel tokens in the OS keyring (`keyring_store.rs`, `commands/chat_channel.rs:116-119`); server uses a tokens file. No tokens live in the `chat_channel` table.

---

## 3. Complete Message Lifecycle

### 3.1 Inbound (IM -> Codeg)

1. Backend task receives raw message:
   - Telegram: long-poll `getUpdates` (`allowed_updates=["message","callback_query"]`, 30s timeout, 5s retry sleep, `api_url()` at `telegram.rs:42-44`), parse at `telegram.rs:300-353`.
   - Lark: WebSocket `pbbp2` with heartbeat/cursor, parse at `lark.rs:442-521`.
   - Weixin: iLink cursor-poll, parse at `weixin.rs:595-711`; voice converted to text (`weixin.rs:608-625`).
2. Parsed into `IncomingCommand { channel_id, sender_id, command_text, callback_data, target, metadata }` (`types.rs`) and pushed to `command_tx` (mpsc, capacity 256, `manager.rs:43`).
3. Dispatcher receives (`command_dispatcher.rs:69-143`), logs inbound (`:79-88`), routes (`dispatch_command` :192-392):
   - `callback_data` present -> `handle_callback` (button/permission responses).
   - Starts with command prefix (from `chat_command_prefix` metadata, default `/`; lang cache 30s TTL) -> named command.
   - No prefix -> followup text matched against an active session for this sender (`session_bridge.rs:65-69`) or forum topic.
4. `/task` (`session_commands.rs:428-668`): creates conversation + thread binding, `conn_mgr.spawn_agent(...)` (`:551-562`), registers `ActiveSession` in bridge (registration `:626`). `/resume` (`:910-928`, reg `:927`) and topic auto-resume (`:1311-1329`) are the other two registration sites.

### 3.2 Agent execution & reply (Codeg -> IM)

1. ACP emits `Arc<EventEnvelope>` on `InternalEventBus` (`internal_bus.rs:54-65`).
2. `session_event_subscriber` (`:33`) matches by `connection_id`; session events (`SessionStarted`, `ContentDelta`, `ToolCall`, `ToolCallUpdate`, `DelegationCompleted`, `PermissionRequest`, `TurnComplete`, `Error`, `StatusChanged`) buffer in `content_buffer` (flush 500 chars or 2s) and reply via `send_to_target` -> `backend.send_rich_message_to` (Telegram MarkdownV2 / Lark card / Weixin plain text).
3. `TurnComplete` triggers final flush (`session_event_subscriber.rs:463-466`); session stays registered for followups.
4. **Global push path:** `event_subscriber` (`:200`, subscribe `:209`, loop `:219-256`) matches `TurnComplete`, `Error`, `PermissionRequest`, `UserPromptSent`, `QuestionRequest` for non-bridged connections, applies the channel event filter, logs outbound (`:387-396`), sends formatted summary, dispatches webhooks.
5. `/cancel` / terminal error / send failure remove the session from the bridge.

**Notable asymmetry:** bridged-session replies are **not** written to the message log; only inbound messages and global-push outbound are logged. Bridged replies also bypass the event filter by design.

---

## 4. Session Model

- `ActiveSession` (`session_bridge.rs`) holds: `channel_id`, `sender_id`, `target` (`ChannelMessageTarget{channel_id, chat_id, thread_key, thread_kind}`), `conversation_id`, `connection_id`, `agent_type`, `content_buffer`, `tool_calls`/`tool_call_inputs`, `delegation_rendered`, `last_flushed`, `pending_prompt`, `permission_pending`.
- Keyed by **`connection_id`** in `HashMap<String, ActiveSession>` (`session_bridge.rs:39-42`); IM-facing lookup is `find_by_sender` (first match, `:65-69`).
- **Registration sites (exactly 3):** `/task` (`session_commands.rs:626`), `/resume` (`:927`), topic-followup auto-resume (`:1311-1329`).
- **Persistence:** the *session* is in-memory only; durable state is the **sender context** (`chat_channel_sender_context`: `folder_id`, `agent`, `conversation_id`, `connection_id`, `auto_approve`) and the **thread binding** (`chat_channel_thread_binding`: topic -> conversation/connection + title sync).
- **Lifecycle:** sessions outlive turns (followup text reuses them). Removal only on `/cancel`, terminal error, ACP status disconnect, or send failure. **No idle timeout.**
- **Concurrency:** legacy chat mode assumes **one active session per sender** (first match). Forum/topic mode keys by `thread_key` (one session per topic). Multi-user works via per-sender contexts -- but see 11/12 for Weixin's single-reply-context limitation.

---

## 5. Storage

| Table | Purpose | Writer | Reader | Lifecycle |
|---|---|---|---|---|
| `chat_channel` | name, type, `config_json`, enabled, event filter, daily-report flag/time | `chat_channel_service::create/update` | manager, subscribers, scheduler | deleted via `delete_chat_channel_core` (`commands/chat_channel.rs:78-90`) |
| `chat_channel_sender_context` | per-sender folder/agent/conversation/connection/`auto_approve` | `sender_context_service` (from `/task` etc.) | dispatcher, session_commands | kept after session end (session memory) |
| `chat_channel_thread_binding` | forum topic -> conversation/connection/title | `thread_binding_service` | session_commands, title-sync | removed on topic session cleanup |
| `chat_channel_message_log` | inbound + global-push outbound | dispatcher (`:79-88`), event_subscriber (`:387-396`) | `/search` (`command_handlers.rs`) | 30-day retention (`scheduler.rs`) |
| `app_metadata` | command prefix, language caches | `app_metadata_service` | dispatcher (30s TTL cache) | -- |
| keyring / tokens file | channel tokens | `keyring_store` | `connect_chat_channel_core` (`commands/chat_channel.rs:116`) | deleted on channel delete (`:88`) |

---

## 6. ACP Integration

- **Bus:** `InternalEventBus` -- `tokio::sync::broadcast<Arc<EventEnvelope>>`, capacity 4096 (`internal_bus.rs:32,48`), one-shot `subscribe()` at startup (`:71-73`). Rationale for the typed bus vs `WebEventBroadcaster` JSON firehose documented at `internal_bus.rs:1-20`.
- **Connections:** `ConnectionManager` (`acp/`) provides `spawn_agent`, `cancel`, `send_prompt`, `respond_permission`, `send_prompt_linked`; the channel session owns a `connection_id` from spawn onward.
- **Owner labels:** every channel-spawned connection is tagged `chat_channel:{channel_id}:{sender_id}[:thread:{thread_key}]` (`session_commands.rs:1492-1499`) -- this is how `event_subscriber` distinguishes bridged (suppressed, `:313-317`) from globally pushable events.
- **Directionality:** channels only *produce* commands/sessions and *consume* events; all control flows through `ConnectionManager` methods. No direct ACP internals mutation.

---

## 7. Permission Flow

1. Agent emits `PermissionRequest` (tool with `require_confirmation`).
2. Bridged path (`session_event_subscriber.rs:370-452`): if `auto_approve`, short-circuits to `conn_mgr.respond_permission(allow=true)` (`:381-401`) without touching the IM. Otherwise stores pending permission (`:421-426`) and sends a rich message offering `/approve | /deny | /approve always` (`:430-450`).
3. User replies; dispatcher routes to `handle_permission_response` (`session_commands.rs:1024-1113`) -> `conn_mgr.respond_permission` (`:1087-1095`); `/approve always` persists via `update_auto_approve` (`:1098-1100`).
4. **Why this lives in Channels, not ACP:** the decision needs (a) per-sender `auto_approve` context (channel table, not ACP), (b) the bridge mapping connection->sender/target to route the prompt, (c) IM-specific button/command affordances. ACP is deliberately transport-agnostic.
5. **Asymmetry:** `QuestionRequest` (interactive LLM questions) has no channel answer path -- a test at `event_subscriber.rs:1603-1630` asserts non-delivery. `/approve always` has no channel-side off switch.

---

## 8. Event Flow

| Event | Subscriber(s) | Action |
|---|---|---|
| `SessionStarted` | session_event_subscriber | reply routing setup |
| `ContentDelta` | session_event_subscriber | buffer -> flush (500 chars/2s) |
| `ToolCall`, `ToolCallUpdate` | session_event_subscriber | tool-detail rendering (`tool_detail.rs`) |
| `DelegationCompleted` | session_event_subscriber | delegation rendering |
| `PermissionRequest` | both | bridged: prompt/auto-approve; global: filtered push |
| `TurnComplete` (end_turn) | both | bridged: final flush `:463-466`; global: summary push + webhooks |
| `Error` | both | bridged: reply + cleanup; global: error push |
| `StatusChanged` | session_event_subscriber | session teardown on disconnect |
| `UserPromptSent` | event_subscriber | global push only |
| `QuestionRequest` | event_subscriber | **not delivered** (`:1603-1630`) |
| WS `chat-channel://status` | `WebEventBroadcaster` | frontend live status |

Global push is **fail-closed**: only events for non-bridged connections (or non-channel sessions) reach a channel, and only when the channel's event filter matches (`event_subscriber.rs:313-317`).

---

## 9. Dependencies

| Dependency | Tightness | Evidence |
|---|---|---|
| ACP (`ConnectionManager`, `InternalEventBus`, `EventEnvelope`) | **Tight** | spawn/respond at `session_commands.rs:551-562, 1087-1095`; bus subscriptions in both subscribers |
| Conversations (`conversation_service`, bindings, `external_id` sync) | **Tight** | conversation create/get in `/task`; `external_id` sync `session_event_subscriber.rs:122-127`; title sync (`conversations.rs:1284-1311, 1826-1851`) |
| SQLite / sea-orm services | **Tight** | 4 entities + 5 services, cited throughout |
| keyring / tokens file | **Tight** | `commands/chat_channel.rs:116-119, 88` |
| reqwest, tokio-tungstenite | **Tight** | Telegram/Lark/Weixin transports |
| `WebEventBroadcaster` | **Medium** | status events only |
| Task Board (`work_task/`) | **None direct** | no references; see 14 |
| Automation engine (`automation/`) | **None direct** | interacts only via ACP bus (indirect) |
| Webhooks | **Loose-medium** | outbound-only sinks |

---

## 10. Generic vs Channel-Specific

**Generic (channel-agnostic core):** `ChannelType` + `ChatChannelBackend` trait (`traits.rs`) + `create_backend` factory (`backends/mod.rs:11-66`), `ChannelMessageTarget`, `RichMessage`/`InteractiveMessage`/`MessageButton`/`ButtonStyle` (`types.rs:185-223`), `SessionBridge`, manager, dispatcher, both subscribers, scheduler, i18n, webhook, message log, command handlers, permission state machine.

**Channel-specific:** the three backends (poll vs WS vs cursor-poll), thread/forum semantics (Telegram-only), message formatting (`message_formatter.rs`), per-language strings (`i18n.rs`).

**The trait is the seam:** new channels implement `ChatChannelBackend` (`start`, `stop`, `status`, `send_message`, `send_rich_message`, `send_rich_message_to`, optional `create_thread`/`edit_thread_title`/interactive/update -- unsupported ops default to `Unsupported` with graceful degradation).

---

## 11. Hardcoded Assumptions

1. **One active session per sender** in legacy chat mode (`find_by_sender` first-match, `session_bridge.rs:65-69`).
2. **One conversation + one connection per sender** (scalar context columns, `chat_channel_sender_context`).
3. **One conversation per forum topic** (binding uniqueness).
4. **Thread/forum semantics are Telegram-only** though the fields are generic in `ChannelMessageTarget`; other backends get no thread support.
5. **Sender context keyed by `(channel_id, sender_id)` only** -- shared across topics within a channel.
6. **Human-only, text-only inbound** -- captions/media unhandled (voice is the single exception, Weixin-only).
7. **Single configured chat per channel** -- Telegram filters one `chat_id`; Weixin assumes a single reply context (see risk).
8. **Reply assumptions:** one reply per turn; only `end_turn`-classified `TurnComplete` pushes globally; subagent deltas dropped.
9. **auto-approve heuristic:** `allow` / `allowForSession` else first (`session_event_subscriber.rs:381-401`); no deny-default option.
10. **No idle timeout** for bridged sessions.
11. **Buffering limits:** flush 500 chars / 2s, hard 2000-char truncation, 10s heartbeat; 5s debounce on global push.
12. **Global push fail-closed** on event type (only 5 event kinds ever reach channels).

---

## 12. Risks

- **Session loss on restart (in-memory bridge).** `SessionBridge` is RAM-only; a process restart orphans all active ACP connections (persisted `connection_id` goes stale) with no reattachment path. Medium.
- **Weixin multi-user collision.** Single reply context (`weixin.rs`) means concurrent senders can get replies routed to the wrong user (last-writer-wins). Medium.
- **`/approve always` has no off-switch** from the channel; only manual DB/desktop edit. Low.
- **Streaming truncation** at 2000 chars per message with no continuation strategy. Low.
- **Delete channel leaves ACP connections running.** `delete_chat_channel_core` (`commands/chat_channel.rs:78-90`) stops the backend and deletes the row/token but never calls `ConnectionManager::cancel` for that channel's sessions; they run to completion and replies fail on send (lazy cleanup). Medium.
- **Webhooks unbound:** not debounced, no per-channel sink filtering beyond the shared config. Low.
- **Monolith file risk:** `session_commands.rs` (2201) and `event_subscriber.rs` (1734) concentrate the state machine; bridge removal invariants (clear path must mirror registration path -- forum vs legacy) are easy to break. Medium (maintenance).
- **Fragile single-consumer mpsc:** the command channel (256) has exactly one consumer; a slow backend poller can stall dispatch.

---

## 13. Future Flexibility

- **New IM channels are additive** via `ChannelType` + `ChatChannelBackend` + `create_backend` arm (`backends/mod.rs:11-66`); graceful defaults exist for unsupported ops. Cost: backend file + factory arm + frontend config UI.
- **Inbound REST/HTTP transport would need new capability:** today **all inbound is outbound-initiated** (long-poll / WS / cursor-poll). There is no inbound HTTP server for channels -- webhooks are outbound-only. A webhook-receiving transport (e.g. Slack Events API) requires new server-side code, not just a backend.
- **Interactive components** (`types.rs:185-223`) are generic but only Telegram buttons are wired -- a ready extension point.
- **Voice:** Weixin already demonstrates voice-to-text inbound (`weixin.rs:608-625`); extending elsewhere is per-backend work.
- **Trait default-impl pattern** makes half-implemented backends (send-only, no threads) first-class citizens, lowering the bar for MCP-style/personal-assistant integrations.

---

## 14. Relationship to Phases 1/2/3

- **Phase 1 (Conversations & Sessions):** tight coupling. Channels reuse `conversation_service`, sync `external_id` (`session_event_subscriber.rs:122-127`), sync titles back to conversation rows (`conversations.rs:1284-1311, 1826-1851`); the daily report reads the conversation table.
- **Phase 2 (Scheduler & Automations):** no direct references from `automation/` to `chat_channel/`. Automation-run sessions emit ACP events and reach channels only through the **global push** filter (if not bridged). The only scheduler inside channels is the daily-report scheduler (`scheduler.rs`) -- a channel feature, not an automation.
- **Phase 3 (Task Board):** no direct interaction with `work_task/`. **Important:** the channel `/task` slash command (`session_commands.rs:428-668`) spawns an ACP *session* with a task description -- it is **not** the Task Board engine. Task-board events reach channels only transitively (board -> conversations -> ACP bus -> global push filter).

---

## Known Gaps (unchanged from scope)

- No inbound HTTP/webhook transport for IM (all inbound is pull-based).
- No channel answer path for `QuestionRequest` (LLM questions).
- No per-sender idle timeout / session reclamation policy.
- No automated recovery of bridged sessions after restart.
- `weixin.rs` single-reply-context concurrency limitation is undocumented in code.

## Next Steps

1. If an extension is planned (new channel or inbound webhook transport), the entry point is `backends/mod.rs:11-66` + `traits.rs` -- no core changes needed for pull-based transports.
2. If session durability is a goal, `SessionBridge` + sender-context reattachment is the work area (restart recovery).
3. If Telegram-only thread semantics should generalize, `ChannelMessageTarget.thread_kind` + backend trait `create_thread` need per-backend support.
