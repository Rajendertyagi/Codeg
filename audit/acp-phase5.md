# Phase 5 Audit: ACP / ConnectionManager / Agent Runtime

**Date:** 2026-08-04 (branch `plugin-dev`)
**Scope:** `src-tauri/src/acp/` (66 files, ~60k lines) + integration surface (lib.rs, app_state.rs, both binaries, commands, web handlers). Out of scope: Conversations/Scheduler/Task/Channels internals, except direct ACP interaction points.
**Method:** read-only; every claim carries a `file:line` citation against the current `plugin-dev` working tree. Line counts verified: `connection.rs` 11,840; `manager.rs` 6,624; `broker.rs` 8,056; `session_state.rs` 3,441; `lifecycle.rs` 2,914.

---

## 0. Anatomy

```
 User Prompt (5 surfaces)
   desktop Tauri acp_prompt (commands/acp.rs:8495-8507)
   web /acp_prompt (web/handlers/acp.rs:165-188)
   automation engine (automation/engine.rs:551-562)
   work_task engine (work_task/engine.rs:782-793)
   chat channel (chat_channel/session_commands.rs:1563-1593)
        |
        v
 ConnectionManager  (acp/manager.rs:190-234)      <- ARCHITECTURAL CENTER (see 16)
   connections: Arc<Mutex<HashMap<id, AgentConnection>>>  :191
   spawn_locks (dedup per agent+cwd+session)              :198
   pending_questions / pending_plan_approvals oneshots    :225, :233
   delegation_injection (codeg-mcp)                      :210
        | spawn_agent (:400-509) | send_prompt_inner (:688-742, TurnInProgress gate)
        | send_prompt_linked_with_message_id (:816-1173, conversation row binding)
        v
 AgentConnection  (acp/connection.rs:330)
   cmd_tx: mpsc::Sender<ConnectionCommand>        :335   (Prompt/SetMode/Cancel/
   state: Arc<RwLock<SessionState>>               :338     RespondPermission/Fork/
   prompt_lock: Arc<tokio::Mutex<()>>             :348     Steer/Disconnect :248-292)
   config_fingerprint (spawn-time snapshot)       :355
   child_pid (kill-tree backstop)                 :378
        | std::thread "acp-conn-*" 8MiB stack (:1256-1259)
        v
 run_connection loop (:2994-3012) -- ACP over stdio (vendored sacp-tokio, JSON-RPC)
        | send_request_to(Agent, initialize 60s :3302-3308 / session/new | session/load
        |   :3642 / prompt :6238 / permission / question / plan_approval / cancel)
        | session/update notifications parsed -> AcpEvent (types.rs:63-409)
        v
 emit_with_state_gated (web/event_bridge.rs:402-425)   <- SOLE event emit path
   ONE write-lock critical section: gate -> apply_event -> event_seq+=1
     -> EventEnvelope{seq, connection_id, payload} Arc -> push_recent_event
   then 3 delivery paths (:430-460):
     +-- per-connection ConnectionEventStream (WS attach, snapshot/replay)
     +-- InternalEventBus (broadcast 4096, internal_bus.rs:32) ->
     |      lifecycle_subscriber (lifecycle.rs:1503-1508)  [conversation rows]
     |      pet state mapper  [list_active_sessions, commands/pet.rs:204]
     |      chat_channel subscribers (event_subscriber.rs:200 / session_event_subscriber.rs:33)
     +-- Tauri app.emit("acp://event") (desktop webview only)
        |
        v
 RecentEventsBuffer (event_stream.rs:91-194)  caps 128 evts / 128 KiB / 64 KiB per-event
        | snapshot/replay attach (ws_attach.rs:152-187)
        v
 Consumers: UI streams, lifecycle (DB status writes), delegation broker, channels

 Side systems owned per-connection (connection.rs:3021-3026):
   TerminalRuntime (:3022)   -- terminal tool process wrapper
   FileSystemRuntime (:3026) -- FS policy for the codeg-mcp companion
   BackgroundWatch (:3073)   -- Claude Code transcript watcher
   codeg-mcp injection (:2770) -- injected MCP server -> UDS -> DelegationBroker
```

**File map (~66 files, ~60k lines):**

| Tier | Files | Lines | Role |
|---|---|---|---|
| Core | `connection.rs` | 11,840 | AgentConnection runtime, ACP protocol, run loop, per-agent normalization |
| Core | `manager.rs` | 6,624 | ConnectionManager: registry, spawn/prompt/cancel/respond, fork, probes |
| Core | `session_state.rs` | 3,441 | Live session state, `apply()`, snapshot |
| Core | `lifecycle.rs` | 2,914 | Bus subscriber -> conversation-row persistence |
| Core | `types.rs` | 1,292 | EventEnvelope + AcpEvent (the wire model) |
| Core | `event_stream.rs` | 1,110 | RecentEventsBuffer, replay |
| Core | `internal_bus.rs` | 207 | In-process typed bus + metrics |
| Interaction | `question.rs` 2,170 · `plan_approval.rs` 307 · `feedback.rs` 256 · `preflight.rs` 716 · `prompt_hydration.rs` 544 · `stderr_tail.rs` 938 | interactive cards, env checks, upload hydration, stderr evidence |
| Delegation | `delegation/broker.rs` 7,626 · `companion.rs` 2,342 · `listener.rs` 1,919 · `transport.rs` 582 · `spawner.rs` 294 · `types.rs` 219 · `meta_writer.rs` 391 · `depth.rs` 93 · `live_reply.rs` 82 · `parent_watcher.rs` 132 · `event_emitter.rs` 278 · `mod.rs` 55 | agent-to-agent delegation via codeg-mcp |
| Registries | `registry.rs` 944 · `custom_registry.rs` 1,269 · `remote_registry.rs` 503 · `binary_cache.rs` 807 · `opencode_catalog.rs` 308 · `opencode_plugins.rs` 615 · `codex_model_catalog.rs` 744 · `codex_catalog_source.rs` 182 · `codex_goal.rs` 337 | agent launch metadata, custom/remote agents, binary cache |
| Runtime helpers | `terminal_runtime.rs` 1,589 · `file_system_runtime.rs` 1,807 · `background_watch.rs` 2,176 · `idle_sweep.rs` 88 · `fork.rs` 33 · `session_info.rs` 190 · `work_task_tools.rs` 46 | terminal/FS/transcript runtimes, idle sweep |
| Base | `error.rs` 127 · `mod.rs` 46 | error model, module surface |

**Ownership wiring (verified):** `ConnectionManager` is Tauri state (`lib.rs:211` `.manage(ConnectionManager::new())`) and a server AppState field (`bin/codeg_server.rs:259` via `app_state::default_connection_manager()`, field at `app_state.rs:18`). The delegation stack is built once in `app_state::build_delegation_stack` (`app_state.rs:101-186`) and installed on the manager via `install_delegation` (`manager.rs:288-290`, `Arc<OnceLock>` at `manager.rs:210`).

---

## 1. Overall Architecture

**Why ACP exists.** Codeg controls a dozen heterogeneous agent CLIs (Claude Code, Codex, OpenCode, Gemini, OpenClaw, Cline, Hermes, CodeBuddy, KimiCode, Pi, Grok, Cursor — `models/agent.rs:22-39`). ACP (Agent Client Protocol) is the uniform JSON-RPC-over-stdio contract that lets codeg launch and steer any of them through one protocol: `ProtocolVersion::LATEST`, initialize handshake, session/new, session/update prompt, session/update permission, notifications, etc. The protocol client is vendored (`sacp`/`sacp-tokio` imported at `connection.rs:5-29`; the spawn wrapper is in `vendor/sacp-tokio/src/acp_agent.rs:263-331`). What ACP solves: one protocol, one event model, one control plane across twelve differently-shaped vendors — including *adapter* agents that wrap a native CLI (`registry::acp_adapter_relation`, `registry.rs:240`).

**The normalization layer.** The `AcpEvent` enum (`types.rs:63-409`) is the single wire model every agent's output is reduced to: content deltas, thinking, tool calls, permissions, turns, delegations, questions, plan approvals, background activity. Every consumer (UI streams, lifecycle, pet, chat channels) sees only `EventEnvelope { seq, connection_id, payload }` (`types.rs:52-58`). Agent-specific quirks are absorbed in `connection.rs` (Grok `use_tool` unwrap `:10556-10588`; CodeBuddy deferred outputs `:11237-11315`; Codex elicitation `:4117, 4301-4324`; Claude subagent metadata `:11574-11607`; Codex transient retries `:7537-7555`).

**Why ConnectionManager exists.** It is the registry + control facade for live `AgentConnection`s (`manager.rs:190-234`): spawn dedup locks keyed by (agent, cwd, session_id) (`:198, :124-129`), a bounded spawn handshake (`:203, :136, :142-148`), the `TurnInProgress` prompt gate (`:726-741`), cancellation with conversation-row CAS (`:1232-1288`), the disconnect-all kill-tree backstop (`:1899-1958`), and the parked question/plan-approval oneshot registries (`:225, :233`). It is the **only** gateway: no code anywhere spawns an `AgentConnection` or sends a prompt without going through manager methods (verified call-site table, §10).

**Which subsystem owns execution.** The `acp` module. `ConnectionManager` owns the connection map; each `AgentConnection`'s `run_connection` task owns its process + runtime state; `lifecycle.rs` owns the conversation-row side effects; `SessionState` (inside the connection) owns live runtime state. Callers own only *their usage* via `owner_window_label` (`connection.rs:334`; values: main-window label, `"web"`, `"automation"`, `"work_task"`, `chat_channel:{id}:{sender}` — see §10 call sites) — used for scoped disconnects (`disconnect_by_owner_window`, `manager.rs:1825-1857`, wired to main-window close `lib.rs:927-935`) and idle sweeping.

**Boundaries of ACP.** ACP does **not** persist conversation messages (the lifecycle subscriber writes only status + external_id — `lifecycle.rs:180-199`); message/transcript persistence is the parsers' + conversation service's job (out of scope). ACP does not render UI, does not know channels/tasks/automation exist, and never mutates the DB except through its own services (conversation status, fork sibling rows, external_id).

---

## 2. Complete Execution Flow

Trace of a UI prompt on a fresh connection (desktop and web paths identical below the command layer):

1. **Admission.** `send_prompt_linked_with_message_id` (`manager.rs:816-1173`) — empty-blocks guard (`:832-836`); `conversation_id` without `folder_id` rejected (`:840-844`); delegation + caller-supplied conversation rejected (`:849-853`). `prompt_lock` held across link + DB write + emit + send (`:861-862`).
2. **State snapshot.** Under the short map lock: clone connection state, emitter, linked row, in-flight flag (`:867-883`); reject `TurnInProgress` while still holding the prompt lock (`:893-895`).
3. **Image hydration.** `prompt_hydration::hydrate_prompt_blocks` (`:908-912`) — server mode only; reads uploaded `file://` markers back into image blocks (64 MiB aggregate cap, 2-permit semaphore, prompt-lock-before-semaphore ordering — `prompt_hydration.rs:45-77, 88-201`).
4. **Conversation binding.** Not yet linked → adopt caller row or `conversation_service::create_with_delegation` (`:917-966`), emit `ConversationLinked` (`:967-977`), sidebar upserts (`:986-1002`), persist `external_id` if the session started (`:1019-1041`).
5. **Status flip.** Every send writes `InProgress` to the row + emits `ConversationStatusChanged` (`:1053-1067`).
6. **Viewer projection.** `UserPromptSent` (notification-only, 500-char preview `:43, :1074-1078`) and `UserMessage` (cross-client viewer, idempotent message id, reserved `turn-<digits>` namespace avoided — `:58-61, :1091-1112`).
7. **Enqueue.** `send_prompt_inner` (`manager.rs:688-742`): `cmd_tx.reserve().await` first (the only cancellable point), then set `turn_in_flight` under the state write lock, then infallible `permit.send(ConnectionCommand::Prompt)` (`:726-741`). `TurnInProgress` rejected before the send (`:732-734`); no await between flag-set and send, so a cancelled future can never strand the flag.
8. **Wire.** `run_connection` loop receives the command and calls `send_request_to(Agent, prompt_request)` (`connection.rs:6238`). Prompt/session messages are built from `PromptInputBlock` (text/image/resource — `types.rs:4-33`).
9. **Streaming.** Agent emits `session/update` notifications; `emit_conversation_update` (`connection.rs:8056`) normalizes them into `AcpEvent`s; each event passes through `emit_with_state_gated` (`web/event_bridge.rs:402-425`): one write-lock critical section = gate → `apply_event` (`session_state.rs:563-1057`) → `event_seq += 1` → `EventEnvelope` Arc → `push_recent_event`, then the three delivery paths (per-connection stream / InternalEventBus / Tauri emit — `:430-460`).
10. **Tools.** `ToolCall` / `ToolCallUpdate` events (`types.rs:86-122`) update the `ToolCallState` map; `ToolCallOutputCache` (`connection.rs:4887`, `CachedOutput` `:4871`) captures raw input/output with replace/append-delta/noop semantics and a per-emit byte cap with `TRUNCATION_MARKER` (`:11007-11045`).
11. **Permission.** Agent requests permission → `PermissionRequest` event (`types.rs:123-128`) → user answers via `RespondPermission` command (`connection.rs:271-274`) → resolution → `PermissionResolved` (`types.rs:137`, emitted `connection.rs:4634`). (§6.)
12. **Completion.** `session/update` `end_turn` → `TurnComplete{session_id, stop_reason, agent_type}` (`types.rs:138-143`); non-`end_turn` stop reasons auto-cancel the connection's delegations (`connection.rs:6472-6484`). Empty-turn detection: `TurnOutputProbe` (`:5790`) + `EmptyTurnReport` (`:5881`) with redacted stderr evidence (`stderr_tail.rs`, `:5911-5959`, `MAX_DETAILS_BYTES=1200`).
13. **Persistence.** The lifecycle subscriber (via InternalEventBus) maps stop reasons to row status: `end_turn` → `PendingReview`; `refusal/max_tokens/max_turn_requests/unknown/empty` → `Cancelled` (`lifecycle.rs:222-229`); retries with 100-500ms backoff (`:119-120`); InProgress → Cancelled CAS on disconnect (`:398-427`).

**Cancellation path.** `manager::cancel` (`manager.rs:1232-1288`) sends `ConnectionCommand::Cancel` and eagerly CASes the row `InProgress → Cancelled` (`:1258-1264`) — without it the row would strand, because the agent's `TurnComplete{cancelled}` is ignored by the lifecycle subscriber (`:1249-1255`). The connection's cancel arm (`connection.rs:6604-6694`) sends `CancelNotification`, drains pending permissions with `respond_cancelled` (`:6618-6622`), emits `TurnComplete{stop_reason:"cancelled"}`, cascades `cancel_by_parent_turn` to the delegation broker, background-drains the in-flight prompt response, and breaks the loop.

---

## 3. Connection Lifecycle

- **Creation.** `spawn_agent` (`manager.rs:400-509`): dedup lock per (agent, cwd, session_id) (`:429-445`); reuse check `find_connection_for_reuse` (`:447-457`, impl `:652-681` — requires matching external_id + agent_type + working_dir + live status); fresh id = `uuid::Uuid::new_v4()` (`:459`); `spawn_agent_connection` inserts into the map and returns a `SessionStarted` oneshot (`:469-482`); `wait_for_session_started` blocks up to the handshake timeout (`:491`, `:177-188`, default 60s via `CODEG_ACP_SPAWN_HANDSHAKE_TIMEOUT_SECS`, `:136, :142-148`).
- **Process spawn.** `build_agent` (`connection.rs:1163`) pins `with_current_dir(launch_cwd)` only if the dir exists (`:1066-1070`); spawn runs on a dedicated `std::thread` named `acp-conn-*` with an 8 MiB stack (`:1256-1259`, rationale `:1073-1088`); the vendored spawner (stdio only, empty env → `env_remove`, `CREATE_NO_WINDOW` on Windows — `vendor/sacp-tokio/src/acp_agent.rs:287-299`) installs `ChildGuard` whose drop runs `kill_tree` then hands the child to a reaper task (`:365-412`). `on_spawn` publishes the OS pid into `child_pid` (`:1165-1168`); `on_exit` zeroes it on a real reap (`:1175-1178`).
- **Registration.** The connection is inserted into the manager map inside `spawn_agent_connection` before the handshake (`manager.rs:469-482`); removal is guaranteed by `ConnectionCleanupGuard` (`connection.rs:310-327`) — RAII removal on both normal exit and panic, with a `try_lock` fast path else a spawned cleanup task.
- **Runtime state.** `SessionState` behind `Arc<RwLock<SessionState>>` (`connection.rs:338`); `ConnectionStatus` enum Connecting/Connected/Prompting/Disconnected/Error (`types.rs:659-667`); per-connection monotonic `event_seq` (`session_state.rs:362`).
- **Streaming** — see §2/§7. **Cancellation** — see §2 (cancel arm `connection.rs:6604-6694`).
- **Reconnect.** There is no wire reconnect: a vanished connection is replaced by a *new* spawn (dedup reuse keyed on external_id, §above) or by `session/load` resume when a session_id is known (`connection.rs:3642`; fallback when `loadSession` is unadvertised via `classify_session_load_failure`). Web clients re-attach through the event stream: cold snapshot, or cursor replay within the ring buffer, or snapshot fallback (`ws_attach.rs:152-187`).
- **Shutdown.** `disconnect_all` (`manager.rs:1899-1958`): drain map, `try_send` (not `send`) `Disconnect` to every connection (`:1917-1919`), wait `DISCONNECT_ALL_GRACE` 500ms (`:51`), then a `spawn_blocking` backstop `kill_tree`s every still-live pid captured *after* the grace window (`:1932-1955`), skipping pid 0. Wired to Tauri `ExitRequested` (`lib.rs:1381-1383`).
- **Cleanup.** The `run_connection` post-loop path revokes the delegation token, `cancel_by_parent`, `cancel_questions_by_parent`, `cancel_plan_approvals_by_parent`, emits a terminal `Error`, then `StatusChanged::Error`, then tears down (`connection.rs:1281-1335`).
- **Ownership.** Two structural owners: the manager map (identity/registry) and the `run_connection` task (lifecycle/state). The cleanup guard guarantees removal; `disconnect_by_owner_window` + idle sweep are external reclaimers; `clone_ref` clones share the Arc map and registries (`manager.rs:273-283`). Lifetime owner = the connection task; identity owner = the manager.

---

## 4. Agent Runtime

- **Launch.** `spawn_agent_connection` (`connection.rs:1098-1110`, 11 params incl. `delegation_injection`) — `SessionState::new` first (`:1114-1120`), `SessionStarted` signal installed before the Arc wrap (`:1122-1126`), first event `StatusChanged{Connecting}` (`:1130`). Probe connections use a `Noop` emitter and owner label `"delegation-probe"` (`manager.rs:1684-1716`).
- **Environment preparation.** Per-agent env overrides from the registry distribution metadata (`registry.rs` `env` maps; merged at launch by `append_agent_env`, `registry.rs:635-650`, Npx cwd override `:735-746`, custom-agent env via `get_agent_env`); the caller's `runtime_env` param is merged in (`manager.rs:2805` for delegation children); empty env values remove the variable (`vendor/sacp-tokio/src/acp_agent.rs:287-291`). Companion injection adds `codeg-mcp` with `--parent-connection-id/--socket-path/--token/--parent-pid/--features` (`connection.rs:2815-2832`).
- **Working directory.** Caller-supplied `working_dir`; pinned only if the directory exists (`connection.rs:1066-1070`); the terminal runtime defaults to the same cwd (`:3021-3023`).
- **Configuration.** Spawn-time settings are snapshotted into `config_fingerprint` (`connection.rs:355`); after a settings save, `refresh_connection_staleness` (`manager.rs:606-633`) diffs the fresh fingerprint and emits `SessionConfigStale{stale, kind}` (`types.rs:405-408`, `ConfigStaleKind` `:461-468`) — a banner, not a hot reload. Modes/config options are agent-advertised (`SessionModes`, `SessionConfigOptions`, `types.rs:172-179`) and probed via `probe_agent_options` (`manager.rs:1674-1758`, per-agent probe lock `:216`, 60s `ProbeTimedOut`).
- **Resume.** `session/load` on a known session_id (`connection.rs:3642`); resume requests inject `claudeCode.emitRawSDKMessages` for Claude (`:9881-9912`); `SessionLoadFailed` surfaces non-recoverable loads (`types.rs:247-257`); spawn dedup + reuse make concurrent resume idempotent (`manager.rs:124-129, 652-681`).
- **Recovery.** Initialize timeout 60s → `AcpError::InitializeTimeout` (`connection.rs:3302-3334`, `error.rs:45-46`); empty-turn diagnosis via stderr tail (`stderr_tail.rs`; `connection.rs:5790-5994`); process death → `ProcessExited` + terminal `Error{terminal:true}` → `Disconnected` (`connection.rs:1305-1335`). **No session-state recovery across a codeg process restart** — runtime state is in-memory (same invariant surfaced in Phase 4 for channels).
- **Isolation.** One connection = one OS process (own stdio, own env); Windows `CREATE_NO_WINDOW`; the terminal runtime uses `CREATE_NEW_PROCESS_GROUP` + `taskkill /F` on Windows, process groups + SIGKILL on Unix (`terminal_runtime.rs` module doc 1-16); the companion's file access runs behind `FileSystemRuntime` policy (read/write roots; strict/unrestricted constructors — `file_system_runtime.rs:47-84`); Codex sandbox/approval keys parsed for the settings panel (`CodexSandboxSettings`, `types.rs:775-808`).
- **Multiple simultaneous agents.** Fully supported: the map holds many connections (`manager.rs:191`); per-agent-type probe locks bound concurrent probes to one (`:216`); spawn dedup serializes only identical logical sessions (`:198`). No global concurrency cap on live connections.

## 5. Internal Event Bus

- **Why it exists.** Decouple event producers (connection run loops) from consumers (lifecycle, pet, chat channels) with a typed `Arc<EventEnvelope>` — no JSON parse on the consumer side and no frontend dedup (rationale documented `internal_bus.rs:1-20`). ACP events were **removed from the global `WebEventBroadcaster` firehose**: consumers are (a) the per-connection event stream for WS clients, (b) the `InternalEventBus` for in-process subscribers, (c) Tauri `app.emit("acp://event")` for the desktop webview (`event_bridge.rs:379-383`). This was an explicit Phase 5 architecture cleanup (`event_bridge.rs:382-383`).
- **Publishers.** Solely `emit_with_state_gated` (`web/event_bridge.rs:402-425`) — every ACP event in the process funnels through the same one-write-lock critical section (gate → `apply_event` → `event_seq += 1` → envelope Arc → `push_recent_event`), then fans out to the per-connection stream (`:430`), the bus, and (desktop) the webview (`:435-449`). A gate veto aborts with no mutation/seq/broadcast (`:413-415`).
- **Subscribers.** `lifecycle_subscriber_task` (`lifecycle.rs:1503-1508`, spawned `lib.rs:619-629` / `bin/codeg_server.rs:418-423`); the pet state mapper (`list_active_sessions`, `commands/pet.rs:204`); the two chat-channel subscribers (Phase 4: `event_subscriber.rs:200`, `session_event_subscriber.rs:33`); plus the delegation listener which resolves tokens → parents. Any in-process task can subscribe via `bus.subscribe()` (`internal_bus.rs:71-73`).
- **Event ordering.** Strict per-connection ordering: seq is assigned under the state write lock in emit order (`event_bridge.rs:417`); the ring buffer tail matches `event_seq` (`session_state.rs:537-538`). Cross-connection ordering is explicitly not guaranteed (`lifecycle.rs:1487-1490`).
- **Delivery guarantees.** `tokio::sync::broadcast` capacity 4096 (`internal_bus.rs:32`). A slow subscriber lags: `RecvError::Lagged(n)` bumps `lagged_count` (`internal_bus.rs:88-91`); broadcast clones the Arc handle, not the payload (test `internal_bus.rs:191-192`). Send with zero receivers is a no-op (`:54-65`).
- **Buffering.** Per-connection `RecentEventsBuffer` (`event_stream.rs:91-194`): caps `RECENT_BUFFER_MAX_COUNT=128` (`:24`), `RECENT_BUFFER_MAX_BYTES=128 KiB` (`:18`), `RECENT_EVENT_MAX_BYTES=64 KiB` (`:30`); FIFO eviction by count+bytes; an oversize event clears the whole buffer (gap → snapshot fallback, `:126-159`); `range_after(since_seq)` returns `None` on cursor gap (`:164-178`); allocation-free size estimation on the hot path (`:246-339`).
- **Backpressure.** Lifecycle worker mailbox capacity 64 (`lifecycle.rs:41`): when full, the dispatcher **blocks on `send().await`** — no event is dropped, `worker_queue_full_count` counts the stalls (`lifecycle.rs:1559-1577`, `internal_bus.rs:114-120`). WS forwarders: lag → `Detached{Lagged}` → client re-attach (`ws_attach.rs:246-261`). Metrics are surfaced on `/debug/event_metrics` (`EventBusMetrics`, `internal_bus.rs:84-121`).
- **Failure behavior.** Terminal errors emit `Error{terminal:true}` then `Disconnected` (`connection.rs:1305-1335`); the lifecycle worker tears down on `Disconnected`/terminal error (`lifecycle.rs:91-98, 1586-1591`); broker cancel propagation rides the same events.

---

## 6. Permission System

- **Lifecycle.** Agent issues `session/request_permission` → connection stores `PendingPermissionState` (`session_state.rs:259`) and emits `PermissionRequest{request_id, tool_call, options}` (`types.rs:123-128`). Each option is a `PermissionOptionInfo` (`types.rs:545-563`) whose `meta` carries the agent's ready-made grant descriptions + lifetime (`_meta.permission`, codex/claude-agent-acp) — the card renders those instead of guessing what "Allow for Session"/"Always Allow" covers (`:551-557`).
- **Resolution.** User (UI or channel) calls `respond_permission` → `ConnectionCommand::RespondPermission{request_id, option_id}` (`manager.rs:1290-1317`, `connection.rs:271-274`) → request_id resolution → `PermissionResolved` emitted (`types.rs:137`, `connection.rs:4634`) so downstream state (pet snapshot, session recovery) unblocks without waiting for TurnComplete.
- **Pending permissions.** Tracked in the connection's perms map; drained on Cancel/Disconnect with `respond_cancelled` (`connection.rs:6618-6622, 6708-6711`). At most one in-flight permission per connection is the agent-enforced model.
- **ConnectionManager interaction.** `respond_permission` is the single entry (`manager.rs:1290-1317`); auto-approve and approve/deny mapping are consumer-side policies (channels: `chat_channel/session_event_subscriber.rs:397-399` auto-approve short-circuit; `session_commands.rs:1067-1089` option mapping).
- **Relationship with Channels.** Channels render permissions as `/approve | /deny | /approve always` cards (Phase 4 §7) and call `respond_permission` directly (`session_commands.rs:1087-1089`); `auto_approve` persists per sender in channel DB tables, not in ACP.
- **Relationship with Desktop UI.** `acp_respond_permission` Tauri command (`commands/acp.rs:8613-8622`) and web `/acp_respond_permission` (`web/handlers/acp.rs:460-470`).
- **Relationship with Tasks.** Work-task prompts flow through the same `send_prompt_linked` (`work_task/engine.rs:782-793`); there is no task-specific permission bypass.
- **Adjacent systems (same pattern, different protocol features).** `ask_user_question` (blocking, MCP-tool based, `question.rs`) and Grok `exit_plan_mode` plan approval (`plan_approval.rs`) — both park a oneshot on the manager (`pending_questions` `manager.rs:225`, `pending_plan_approvals` `:233`), emit request/resolved events (`types.rs:370-394`), and are swept on teardown. Codex `elicitation/create` routes between permission-card and question-card depending on `_meta.codex_approval_kind` (`question.rs:724-882`).

---

## 7. Streaming

- **Token streaming.** `session/update` content deltas normalize into `ContentDelta` (`types.rs:64-73`) via `emit_conversation_update` (`connection.rs:8056`); each delta is applied + sequenced atomically (no per-connection source truncation; the 500-char/2s buffering seen in Phase 4 is a *channel-side* reply policy, not ACP). Thinking streams as `Thinking` (`types.rs:74-80`). Claude subagent chunks carry `parent_tool_use_id` (`types.rs:66-72`).
- **Partial responses.** Content blocks are appended incrementally into `SessionState` live content (`apply_event`, `session_state.rs:563-1057`); a mid-turn snapshot attach reproduces the partial state (`LiveSessionSnapshot`, `session_state.rs:1390-1476`).
- **Tool streaming.** `ToolCall` → `ToolCallUpdate` (`types.rs:86-122`): status-only updates merge into the existing card (`session_state.rs:2427, 3223, 3283`); `raw_input`/`raw_output` captured via `ToolCallOutputCache` with replace/append-delta/noop semantics (`connection.rs:4871-4887`) and a per-emit byte cap with `TRUNCATION_MARKER` (`:11007-11045`); tool images supported (`ToolCallImageInfo`, `types.rs:46, 96-102`).
- **Interruptions.** Cancel is a command, not a stream break: `CancelNotification` to the agent, perms drained, `TurnComplete{stop_reason:"cancelled"}` synthesized, in-flight response background-drained (`connection.rs:6604-6694`). Live steering is `Steer` (`connection.rs:287-290, 6595-6602`) + the `check_user_feedback` MCP pull (`feedback.rs`).
- **Completion.** `TurnComplete{session_id, stop_reason, agent_type}` (`types.rs:138-143`); non-`end_turn` reasons auto-cancel delegations (`connection.rs:6472-6484`); empty turns get a synthesized `"empty"` stop reason with diagnostic evidence (`connection.rs:5969-5980`).
- **Errors.** `Error` event with stable `code` + redacted `details` + in-process `terminal` flag (`types.rs:192-231`); Codex transient auto-retries surface as `TurnRetrying` (NOT a failure — `types.rs:232-246`); `turn_failed_empty` family generates toasts from stderr evidence (`connection.rs:5982-5994`).

---

## 8. Tool Execution

- **How tools execute.** Agents call their own tools natively; codeg *observes* via `session/update` `tool_call`/`tool_call_update`/completion events (`emit_conversation_update`, `connection.rs:8056`), renders `ToolCall`/`ToolCallUpdate` cards, and tracks state in the `ToolCallState` map inside `SessionState` (re-exported types `acp/mod.rs:41-44`).
- **How results return.** Completion updates carry `raw_output`; `ToolCallOutputCache` (`connection.rs:4887`, `CachedOutput` `:4871`) implements replace/prefix-append-delta/identical-noop semantics (tests `:10942-11005`) with a `MAX_SINGLE_EMIT_BYTES` cap (`:11007-11045`) and a FIFO entry cap (`:11067-11079`).
- **How tool calls are tracked.** `SessionState` maintains the live tool-call index with status/content/images, merged on update, recoverable via snapshot (`session_state.rs`; `ToolCallState`, `ToolCallStatus`, `ToolKind`, `ToolCallOutput`).
- **Relationship with MCP.** Codeg injects its own MCP server, `codeg-mcp`, into every agent's MCP server list at init (`inject_codeg_mcp`, `connection.rs:2770-2849`; `locate_codeg_mcp_binary` `:2663-2690`; `McpServerStdio` args `:2815-2832`; feature-gated tools `companion.rs:5-17`). It currently exposes: `delegate_to_agent`, `get_delegation_status`, `cancel_delegation` (delegation), `ask_user_question`, `check_user_feedback` (interaction). User-configured MCP servers pass through unchanged (`canonical_spec_to_mcp_server`). Server-mode default `mcpServers: []` and resume-omits-the-key are OpenClaw compatibility gates (`connection.rs:9838-9948`).
- **Delegation.** Parent agent calls `delegate_to_agent` → `codeg-mcp` companion (stdio) → length-prefixed frame protocol over a token-authed UDS/named pipe (`transport.rs`; `default_socket_path` pid-scoped: `codeg-delegation-<pid>.sock` / `\\.\pipe\codeg-delegation-<pid>`, `listener.rs:747-754`) → `DelegationBroker` (`broker.rs`) → `ConnectionSpawner` (`spawner.rs:86`; production impl `ConnectionManagerSpawner`, `manager.rs:2766-2898`) → child `AgentConnection` via `spawn_agent` + `send_prompt_linked_for_delegation` → child TurnComplete → `DelegationOutcome` returned as the MCP `tool_result` to the parent (`delegation/mod.rs:1-31`). v1 is one-shot: the broker resolves and disconnects the child after its first TurnComplete (`mod.rs:28-31`). Depth default 1 (`DelegationConfig.depth_limit`, `broker.rs:145-173`; `compute_depth` saturating walk, `depth.rs:15-36`); `TASK_PREVIEW_CAP = 2 KiB` (`broker.rs:94`); `COMPLETED_TEXT_CAP = 256 KiB` (`:87`), completed-result cache capped at 512 MiB (`:79`); pending-tool-call TTL 60s (`:1099`).
- **Companion processes.** `codeg-mcp` is a per-launch stdio binary (`bin/codeg_mcp.rs:1-31`), JSON-RPC 2.0, token-gated; the broker is the single-mutex state machine (`broker.rs:227-269`) with four cancellation paths (`cancel_by_external_handle` `:2851`, `cancel_by_child_connection` `:2890`, `cancel_by_parent` `:2933`, `cancel_by_parent_turn` `:2958`), buffered early completes (`:382-395`), and a `result_notify` (`:1179`).

---

## 9. Runtime State

| Structure | Owner | Lifetime | Synchronization | Persisted? |
|---|---|---|---|---|
| `ConnectionManager.connections` map (`manager.rs:191`) | manager | process | `tokio::sync::Mutex` | No |
| `spawn_locks` (per agent+cwd+session) (`manager.rs:198`) | manager | process (entries persist per distinct session) | `Mutex<HashMap<…, Mutex<()>>>` | No |
| `probe_locks` (per agent_type) (`manager.rs:216`) | manager | process | mutex map | No |
| `pending_questions` oneshot registry (`manager.rs:225`, entry `:239-243`) | manager | per in-flight ask | mutex map | No |
| `pending_plan_approvals` oneshot registry (`manager.rs:233`, entry `:248-251`) | manager | per in-flight approval | mutex map | No |
| `AgentConnection.cmd_tx` mpsc (`connection.rs:335`) | connection task | per connection | mpsc (commands) | No |
| `AgentConnection.state: Arc<RwLock<SessionState>>` (`connection.rs:338`) | connection task | per connection | `tokio::sync::RwLock` | No |
| `SessionState` (`session_state.rs:238-466`): live messages/content blocks, `ToolCallState` map (index), `pending_permission` (`:259`), `pending_question` single slot (`:261-268`), `pending_plan_approval` (`:270-278`), feedback, `UsageInfo` (replace-only, `:637-642`), `pending_user_message`, `status`, `event_seq` (`:362`), `selectors_ready` (`:336`), `grok_effort_specs` cache (`:327`), `background_outstanding`/`background_activity_at` idle exemption (`:309-314`), `active_delegations` (explicitly uncapped, `:186-189, 2625-2640`) | connection task | under the same RwLock as the seq | No (snapshot per attach) |
| `RecentEventsBuffer` (`event_stream.rs:91-194`) | per connection (field of SessionState, `session_state.rs:377`) | per connection | under the state write lock (`:537-538`) | No (replay window) |
| `config_fingerprint` / `last_observed_fingerprint` (`connection.rs:355, 361`) | connection | per connection | immutable after spawn | No |
| `child_pid` (`connection.rs:378`) | connection | per connection | `Arc<AtomicU32>` | No |
| `StderrTail` (`stderr_tail.rs:82-91`) | connection | per connection | `std::sync::Mutex` | No |
| `ToolCallOutputCache` (`connection.rs:4887`) | connection | per turn | under state write lock | No |
| `DelegationBroker` RunningTask/CompletedTask (`broker.rs:182-225`), `PendingInner`/`PendingCalls` single mutex (`:227-269`), completed cache (512 MiB) | AppState (`app_state.rs:39`) | process | single mutex + `Arc<Notify>` (`:1179`) | No (task DB rows via work_task engine) |
| `TokenRegistry` (`listener.rs:60-83`) | AppState | process | mutex | No |
| `NPM_ENV_CACHE` (`preflight.rs:11`) | process-global | process (cache of passed checks) | `Mutex<Option<…>>` | No |
| Binary cache (`~/.codeg/cache/agents/`) | filesystem | persistent | disk | Yes (binaries only) |

**Invariants.** Every event is applied under one write lock together with its seq; the ring buffer tail always equals `event_seq`; `turn_in_flight` is set and the command sent with no await in between (no stranded flag); the cleanup guard runs on panic as well as normal exit; manager registries are shared across `clone_ref` clones so listener-facing and command-facing paths touch the same maps.

## 10. Dependencies

| Dependency | Tightness | Evidence |
|---|---|---|
| **Conversations** | **Tight** | `send_prompt_linked_with_message_id` creates/links conversation rows via `conversation_service::create_with_delegation` (`manager.rs:917-966`), persists `external_id` (`:1019-1041`), flips status InProgress (`:1053-1067`); lifecycle writes status + external_id (`lifecycle.rs:180-199, 222-229`); fork creates sibling rows (`manager.rs:1495+`). |
| **Channels** | **Tight (one-directional)** | Channels call the manager directly — no command/web indirection: `spawn_agent` (`session_commands.rs:552, 892, 1542`), `send_prompt` (`:1563`), `send_prompt_linked` (`:1581`), `cancel` (`:592, 707, 942, 996, 1342, 1367`), `respond_permission` (`:1087-1089`); subscriber auto-approve (`session_event_subscriber.rs:397-399`) and `send_prompt` (`:135`). The manager has no knowledge of channels. |
| **Task Engine (work_task)** | **Tight (one-directional)** | `work_task/engine.rs:674-686` spawn (resume-or-fresh fallback `:703-715`), `:782-793` prompt, `:433-435` cancel; listener resolves work-task tools (`EngineWorkTaskTools`). |
| **Automation** | **Tight (one-directional)** | `automation/engine.rs:481-494` spawn (owner `"automation"`, one turn then disconnect `:747`), `:551-562` prompt, `:951-953` cancel+disconnect. |
| **Database (SQLite)** | **Medium–tight** | Only the lifecycle subscriber + fork path write rows; the runtime core is DB-free by design (`lifecycle.rs:180-199`). |
| **Filesystem** | **Medium** | Binary cache (`~/.codeg/cache/agents/`, `binary_cache.rs`), agent config files, prompt-hydration reads (`prompt_hydration.rs`), `FileSystemRuntime` for the companion (`file_system_runtime.rs`). |
| **MCP** | **Tight** | `codeg-mcp` injection at every spawn (`connection.rs:2770-2849`); delegation broker is the main consumer; user MCP servers pass through. |
| **WebSocket** | **Medium** | WS attach protocol + snapshot/replay (`ws_attach.rs`); ACP events are NOT on the global broadcaster (`event_bridge.rs:379-383`). |
| **Agent CLIs** | **Tight** | The entire point: 12+ vendors speaking ACP over stdio (`models/agent.rs:22-39`, `registry.rs`), adapter relation for wrappers (`registry.rs:240`). |
| **WebEventBroadcaster** | **None (for ACP)** | Explicitly removed; only the `conversation://changed` side-channel remains (`event_bridge.rs:462-464`). |

---

## 11. Extension Points

- **New agent.** `AgentType` enum (`models/agent.rs:22-39`) + launch metadata in `registry.rs` (distribution: Npx/Uvx/Binary, per-agent env, platform binary URLs/SHA-256) + a transcript parser (`parsers/`). Adapter agents declare their native CLI via `acp_adapter_relation` (`registry.rs:240`). **Custom agents** are first-class: DB-persisted definitions (`custom_registry.rs`, `db::service/custom_agent_service.rs:160-162`), Npx/Uvx/Binary install kinds, pinned binary dirs; deleted-mid-conversation custom agents are rejected at spawn (`connection.rs:701-718`).
- **New transport.** ACP-over-stdio is the only process transport; variance is the *agent binary*, not the transport. Remote installs/catalogs: `remote_registry.rs` (HTTP `registry.json`, 2-minute refresh).
- **New event subscriber.** `InternalEventBus.subscribe()` (`internal_bus.rs:71-73`) — add a task at startup, as lifecycle/pet/channels do. Per-connection event stream consumption is the WS attach protocol (`ws_attach.rs`).
- **New interactive capability.** The `ask_user_question` / `exit_plan_mode` / `check_user_feedback` systems are complete, reusable patterns: manager oneshot registry + event pair + UI card. Codex `elicitation/create` already routes into them (`question.rs:724-882`).
- **New runtime capability.** `TerminalRuntime` (`terminal_runtime.rs`) and `FileSystemRuntime` (`file_system_runtime.rs`) are per-connection services wired at `connection.rs:3021-3026` — additional per-connection runtimes slot in there. `BackgroundWatch` (`background_watch.rs`) is the same pattern, Claude-only (`connection.rs:3073`).
- **Custom tool provider.** The `codeg-mcp` companion (`bin/codeg_mcp.rs`) is the vehicle — feature-gated tools (`companion.rs:5-17`); the delegation listener's `WorkTaskToolAccess`/`SessionInfoAccess` traits are swappable (`work_task_tools.rs:37-49`).
- **Delegation.** `ConnectionSpawner` trait (`spawner.rs:86`) is the injection point for alternative child-launch strategies; `MetaWriter`/`LiveReplyLookup`/`EventEmitter`/`ParentLookup` traits are wired in `build_delegation_stack` (`app_state.rs:132-156`).
- **Custom execution mode.** Agent-advertised session modes (`SessionModes`/`ModeChanged`, `types.rs:172-173, 186-187`); fork (`fork_session`, `manager.rs:1319-1493`).

---

## 12. Hardcoded Assumptions

1. **One OS process per connection**; the connection task owns the child's lifetime via `ChildGuard` (`vendor/sacp-tokio/src/acp_agent.rs:365-412`).
2. **One prompt in flight per connection** — `TurnInProgress` rejection is protocol-level (`error.rs:20-21`, gate `manager.rs:726-741`); concurrent co-controlling clients are serialized, not queued.
3. **ACP over stdio JSON-RPC** with a 60s initialize timeout (`connection.rs:3302-3334`, `error.rs:45-46`); 60s spawn handshake (`manager.rs:136`); 60s probe (`error.rs:47-48`).
4. **Working directory comes from the caller** and is silently dropped if the directory does not exist (`connection.rs:1066-1070`).
5. **Configuration frozen at spawn** — `config_fingerprint` + `SessionConfigStale` banner, no hot reload (`manager.rs:606-633`).
6. **No in-process runtime state survives a codeg restart** — sessions die with the process (kill-tree shutdown); recovery is a fresh spawn + optional `session/load`.
7. **Owner-label convention** (`connection.rs:334`) is a plain string contract between spawners and the manager (`disconnect_by_owner_window`, idle sweep).
8. **Ring-buffer caps are the replay contract**: beyond 128 events / 128 KiB a client falls back to a full snapshot (`event_stream.rs:18-30`, `ws_attach.rs:152-187`).
9. **`SessionState.apply` is per-operation idempotent, not seq-deduped** — dedup happens at attach-cursor level; event replay assumes identical payloads.
10. **Delegation depth default 1** (`broker.rs:145-173`) and one-shot children (`mod.rs:28-31`).
11. **Agent-specific behaviors are pinned to specific vendor versions** in several places (e.g. codex-cli 0.145.0 sandbox vocabulary `types.rs:772-774`; Grok `_x.ai` payloads verified against 0.2.111 `plan_approval.rs:28-43`; claude-agent-acp ≥0.63/0.64 metadata fields `types.rs:68, 552`).
12. **Permission options are agent-driven**; codeg renders what the agent advertises (`PermissionOptionInfo`, `types.rs:545-563`) — there is no codeg-side policy layer, only consumer-side auto-approve.

---

## 13. Failure Recovery

- **Agent crash.** `ProcessExited` (`error.rs:11-12`); `on_exit` zeroes `child_pid` so the kill-tree backstop never aims at a recycled pid (`connection.rs:1175-1178`, doc `:362-377`); `ChildGuard` reaps and kill-trees on drop (`vendor/sacp-tokio/src/acp_agent.rs:365-412`); terminal `Error{terminal:true}` → `Disconnected` → lifecycle CAS InProgress→Cancelled (`connection.rs:1305-1335`, `lifecycle.rs:398-427`); cleanup guard removes the map entry even on panic (`connection.rs:310-327`).
- **Connection loss (web).** Attach protocol heals: snapshot, cursor replay within the ring buffer, or snapshot fallback (`ws_attach.rs:152-187`); forwarder lag → `Detached{Lagged}` → client re-attach (`:246-261`).
- **Timeouts.** Init 60s → `initialize_timeout`; spawn handshake 60s → `HandshakeWaitOutcome::TimedOut` (`manager.rs:152-172, 185-186`); probe 60s → `probe_timed_out`; terminal wait error budget 30s then publishes state anyway (`terminal_runtime.rs:41`); broker pending-tool-call TTL 60s (`broker.rs:1099`); listener status wait 60s (`listener.rs:37`).
- **Cancellation.** Protocol `CancelNotification` + synthesized `TurnComplete{cancelled}` + perms drained + broker cascade (`connection.rs:6604-6694`); conversation row eagerly CASed (not waiting for the agent's reply, `manager.rs:1249-1277`).
- **Restart behaviour.** Connections do not survive; the app drains the map with `try_send` + 500ms grace + `kill_tree` backstop (`manager.rs:1899-1958`). Conversation rows keep their last written status; no reattachment path (invariant shared with Phase 4's in-memory bridge finding).
- **Recovery guarantees.** At-least-once feedback delivery: listener READ → WRITE → COMMIT, commit skipped on failed write (`feedback.rs:146-171`; `listener.rs:223-226`; companion defers commit until after the response is written, `companion.rs:760-861`). Idempotent event apply per operation; compensating `QuestionResolved`/`PlanApprovalResolved` on the insert/emit teardown race (`manager.rs:2366-2409, 2552-2560`); broker buffers early child completion against the registration race (`broker.rs:232-261, 382-395`); stderr evidence for empty turns is redact-before-truncate (`stderr_tail.rs:121-126`) and never ships plaintext (`:17-22`).

---

## 14. Generic vs Agent-Specific

**Generic ACP infrastructure (agent-agnostic):** the protocol client (`sacp`/`sacp-tokio`), `AgentConnection` runtime core, `ConnectionManager`, `SessionState` + `AcpEvent` model, `InternalEventBus` + event stream, `lifecycle.rs`, permission/question/plan-approval/feedback machinery, `preflight.rs`, `prompt_hydration.rs`, `stderr_tail.rs`, `terminal_runtime`/`file_system_runtime`, `binary_cache`, delegation broker, idle sweep. These files contain zero vendor names except in the per-agent quirk sections.

**Agent-specific:** (1) `AgentType` + registry launch metadata — distribution kind, package/version, executable name, platform URLs, per-agent env, adapter relation (`registry.rs`, `models/agent.rs:22-39`); (2) per-agent event *normalization* in `connection.rs` (Grok `use_tool` unwrap `:10556-10588` and effort specs `:10103-10251`; CodeBuddy deferred/background/subagent markers `:11237-11572`; Claude subagent transcript metadata `:11574-11607` and raw SDK messages `:9762-9775`; Codex elicitation `:4117, 4301-4324`, plan gate `:7570-7581`, retry indicator `:7537-7555`, goal markers `codex_goal.rs`; OpenClaw MCP-server gates `:9838-9948`); (3) transcript parsers for history import (`parsers/` — out of scope); (4) per-agent catalogs/panels (codex model catalog, opencode catalog, grok/cursor structured configs in `types.rs:775-1029`); (5) `BackgroundWatch` is Claude-CLI-only (`background_watch.rs`, `connection.rs:3073`).

**The abstraction boundary** is precisely: wire events → normalized `AcpEvent` by per-agent code in `connection.rs`; agent identity/capabilities → `AgentType` + registry metadata + probe results; history → parsers. Everything downstream of `AcpEvent` and `AgentType` (state, bus, lifecycle, permissions, UI, channels) is generic.

---

## 15. Relationship to Previous Audits

- **Phase 1 (Conversations).** ACP is the execution half of the conversation model: `send_prompt_linked_with_message_id` binds and creates rows (`manager.rs:917-1041`), emits `ConversationLinked`/`ConversationStatusChanged` (`types.rs:154-171`), lifecycle writes status transitions (`lifecycle.rs:222-229`); fork preserves pre-fork history in a sibling row (`manager.rs:1495+`); delegation children create parent-linked rows (`parent_conversation_id`/`parent_tool_use_id` on `ConversationLinked`, `types.rs:156-160`).
- **Phase 2 (Scheduler & Automation).** The automation engine is a peer caller, not a subscriber: it spawns its own connections (owner `"automation"`, `automation/engine.rs:481-494`), prompts (`:551-562`), runs one turn then disconnects (`:747`), and reads state via `get_state_and_emitter` (`:761, 796`). ACP events reach channels from automation runs only through the global-push path (Phase 4 §14).
- **Phase 3 (Task Engine).** `work_task/engine.rs` spawns/resumes connections (`:674-686, 703-715`), prompts (`:782-793`), cancels (`:433-435`); the delegation listener exposes work-task progress/completion tools to agents (`work_task_tools.rs`, `EngineWorkTaskTools`). The channel `/task` command remains distinct (Phase 4 §14) — it is a manager spawn, not the task engine.
- **Phase 4 (Channels).** Channels are the manager's heaviest peer caller (direct calls, §10). Their two bus subscribers consume ACP events; their sessions are manager connections with `chat_channel:{id}:{sender}` owner labels; their auto-approve and /approve|/deny flow into `respond_permission`. Delegation (`DelegationStarted`/`DelegationCompleted`, `types.rs:296-326`) is the mechanism that channels render as sub-agent activity.

---

## 16. Architectural Center

**Is ConnectionManager the architectural center of Codeg? Yes — with one qualification.**

**The case for yes (evidence):** every execution path into an agent — desktop prompt (`commands/acp.rs:8495-8507`), web prompt (`web/handlers/acp.rs:165-188`), automation run (`automation/engine.rs:551-562`), task run (`work_task/engine.rs:782-793`), chat-channel session and followup (`session_commands.rs:552-1593`), delegation child (`manager.rs:2766-2898`), and the internal probe path (`manager.rs:1674-1758`) — flows through `ConnectionManager` methods. No subsystem spawns an `AgentConnection` directly; `spawn_agent_connection` (`connection.rs:1098-1110`) is called only from the manager. The manager also owns the process-wide interaction registries (questions, plan approvals) and the shutdown kill-tree backstop. It is the single control gateway: process lifecycle, prompt admission (the `TurnInProgress` gate), cancellation, permission responses, forking, probes, staleness detection.

**The qualification:** ConnectionManager is the *control facade*, not the *execution engine*. The execution model lives in the `AgentConnection.run_connection` loop (`connection.rs:2994-3012`) — the only place the ACP wire is driven — with `SessionState` (`session_state.rs`) as the authoritative runtime state and `emit_with_state_gated` (`event_bridge.rs:402-425`) as the sole event emission path. The manager is deliberately a thin registry + controller over those per-connection engines (its fields are maps and locks, `manager.rs:190-234`).

**Conclusion.** The architectural center of Codeg is the **ACP module as a whole, with ConnectionManager as its public face**: manager = control plane (who runs, when, gates, teardown), `AgentConnection` = execution plane (the wire, the state, the events), `InternalEventBus` + `RecentEventsBuffer` = event plane, `lifecycle` = persistence plane. Every subsystem that needs an agent talks to the manager; everything that happens during a run is visible through `AcpEvent`. The one counterexample is conversation *history* persistence, which is owned by the parsers + conversation service and is reached through the same events the manager emits — so even that is downstream of the ACP event model. Any future subsystem that executes agents must go through ConnectionManager; that is the definition of the architectural center.

---

## Known Gaps

- `SessionState` snapshot has no byte cap — multi-MB images can bloat an attach (`session_state.rs:95-103`).
- `active_delegations` is explicitly uncapped (`session_state.rs:186-189, 2625-2640`).
- Broker/companion `event_emitter.rs`/`meta_writer.rs` full write paths and `transport.rs` frame field shapes not line-verified beyond the cited symbols.
- `registry.rs:75-1265` per-agent table bodies not exhaustively read (shapes verified).
- No in-process runtime state survives a codeg restart (no session recovery).

## Next Steps

1. If durability of in-flight sessions is a goal, the work area is `SessionState` persistence + attach-by-conversation recovery (not the manager).
2. If delegation depth >1 is desired, the boundary is `broker.rs` depth pre-check (`:2165-2198`) + `depth.rs`.
3. If codeg-side permission policy is wanted (beyond agent-advertised options), the extension point is the permission request handling in `connection.rs` (options today are agent-driven, §12.12).

