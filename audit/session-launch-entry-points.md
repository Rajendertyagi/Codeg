# Architecture Audit — Session Launch Entry Points

**Date:** 2026-08-04 · **Branch:** plugin-dev (1fa889e2) · **Method:** read-only; grep + git + qartez `qartez_refs` cross-check + codebase-memory `search_graph` cross-check. Every claim cites `file:line`. **No code was modified.**

**Headline answer:** Codeg has **7 distinct session-launch mechanisms** (UI, scheduler, task board, chat channels, delegation/MCP, probe, fork) converging on **1 process-spawn pipeline** (`ConnectionManager::spawn_agent`), **1 prompt-enqueue pipeline** (`send_prompt_inner`), and **1 conversation decision function** (`send_prompt_linked_with_message_id`, `manager.rs:914`). Existing-conversation targeting exists in the UI, task board (retry/return/merge), and chat channels — but **not** in the Scheduler's "Launch Session" action.

---

## 1. Discover Every Entry Point — Complete Inventory

### 1.1 The definitive process-launch inventory: every `spawn_agent` call site

`ConnectionManager::spawn_agent` (`src-tauri/src/acp/manager.rs:400`) is the **only** function in the repository that starts an agent CLI process (it is what `spawn_agent_connection` in `acp/connection.rs:1098` drives). There are exactly **9 production call sites** (qartez `qartez_refs spawn_agent` resolves the 2 in-file sites; cross-module sites verified by grep):

| # | Call site | Owner | Entry point it serves |
|---|---|---|---|
| 1 | `commands/acp.rs:8471` | Tauri command `acp_connect` | **Chat UI** (desktop) |
| 2 | `web/handlers/acp.rs:102` | REST `POST /api/acp/connect` | **Chat UI** (web/remote) — same frontend |
| 3 | `automation/engine.rs:483` | `AutomationEngine::launch` | **Scheduler "Launch Session"** |
| 4 | `work_task/engine.rs:676` (+ `:704` resume-fallback) | `TaskEngine::launch` | **Task board** (fresh / retry / return / merge) |
| 5 | `chat_channel/session_commands.rs:552` | `/task` command handler | **Chat channels** (new) |
| 6 | `chat_channel/session_commands.rs:892` | `/resume <id>` command handler | **Chat channels** (resume) |
| 7 | `chat_channel/session_commands.rs:1542` | `spawn_chat_connection_for_conversation` | **Chat channels** (follow-up auto-resume) |
| 8 | `acp/manager.rs:1706` | `probe_agent_options` | **Hidden** — agent-options probe (Noop emitter, no prompt, no conversation) |
| 9 | `acp/manager.rs:2815` | `ConnectionManagerSpawner::spawn` | **Delegation / MCP** `delegate_to_agent` |

### 1.2 The prompt-send inventory (3 sinks, 1 funnel)

| Function | File | Role |
|---|---|---|
| `send_prompt_inner` | `manager.rs:688` | **The only enqueue point** — gate + `ConnectionCommand::Prompt` |
| `send_prompt` (non-linked) | `manager.rs:758` | Channels follow-up + kickoff; **no** conversation-row side effects |
| `send_prompt_linked_with_message_id` | `manager.rs:816` | **The conversation decision function** (Branch A adopt / Branch B create) |
| `send_prompt_linked` (wrapper) | `manager.rs:786` | Back-compat wrapper of the above |
| `send_prompt_linked_for_delegation` | `manager.rs:2829` | Delegation child (always Branch B + `DelegationLink`) |
| `fork_session` | `acp/fork.rs:19`, `manager.rs:1319` | `session/fork` over a **live** connection — new session, no new process |

### 1.3 Entry-point families discovered (the "examples not exhaustive" list, answered)

| Hypothesized entry | Exists? | Evidence |
|---|---|---|
| Chat UI | ✅ | `acp-connections-context.tsx:4493` (connect), `:4767` (prompt) |
| Scheduler / Automations | ✅ | `automation/engine.rs:418` `launch`; fired by `run_automation` `:301` (manual `commands/automation.rs:202`, schedule `engine.rs:267`) |
| Task Board | ✅ | `work_task/engine.rs:565` `launch`; auto-start pump `spawn_launch` `:531` |
| Telegram | ✅ | `chat_channel/backends/telegram.rs`; `ChannelType::Telegram` (`chat_channel/types.rs:7`) |
| WhatsApp | ❌ | No backend file, no enum variant (`types.rs:5-9` = Lark/Telegram/Weixin only) |
| Discord | ❌ | No backend file, no enum variant |
| Lark | ✅ | `chat_channel/backends/lark.rs`; `ChannelType::Lark` |
| Weixin | ✅ | `chat_channel/backends/weixin.rs`; `ChannelType::Weixin` |
| HTTP / Webhooks | ⚠️ | **Outbound only** — `chat_channel/webhook.rs:1-8` is a channel-agnostic *event sink* POSTing agent events to URLs. **No inbound webhook can start a session.** |
| REST APIs | ✅ | `web/handlers/acp.rs:77` (connect), `:161` (prompt); automation run-now `web/handlers/automation.rs:162` |
| CLI | ⚠️ | No interactive CLI; `bin/codeg_server.rs` (server) and `bin/codeg_mcp.rs` (MCP companion) are the only binaries. |
| MCP | ✅ | `delegate_to_agent` → delegation broker (`acp/delegation/broker.rs:2222` spawn, `:2297` send) via `codeg-mcp` |
| Internal services / background workers | ✅ | Automation scheduler loop (`engine.rs:218`), task pump (`engine.rs:531`), chat-channel subscribers (`manager.rs:340` `start_background`), delegation listener (`codeg_server.rs:332`) |
| Other discovered | ✅ | `probe_agent_options` (`manager.rs:1674`); fork (`manager.rs:1319`); companion in-session tools (feedback/question/session_info) |

---

## 2. Comparison Table

| Entry Point | File (launch fn) | New Conversation | Existing Conversation | Notes |
|---|---|---|---|---|
| Chat UI — new session | `acp-connections-context.tsx:4493` → `commands/acp.rs:8471` `acp_connect` (`spawn_agent`) | ✅ (session_id=None) | — | Desktop: Tauri invoke; web: same via transport (`lib/tauri.ts:108`, `lib/api.ts:173`) |
| Chat UI — reopen/resume | `acp-connections-context.tsx:4493` (sessionId passed) → `acp_connect` | — | ✅ (session_id = `external_id`) | Discovery: `acp_find_connection_for_conversation` (`web/handlers/acp.rs:570`) |
| Chat UI — send prompt | `acp-connections-context.tsx:4767` → `commands/acp.rs:8486` / `web/handlers/acp.rs:161` `acp_prompt` → `send_prompt_linked_with_message_id` | ✅ if conv_id=None+folder_id=Some (Branch B) | ✅ if conv_id=Some (Branch A) | `lib/api.ts:235` passes folderId/conversationId/clientMessageId |
| REST — connect | `web/handlers/acp.rs:77` `acp_connect` | ✅ | ✅ (session_id param) | Same code path as UI |
| REST — prompt | `web/handlers/acp.rs:161` `acp_prompt` | both (same contract) | both | 409 `TurnInProgress` mapping `:183` |
| **Scheduler — Launch Session** | `automation/engine.rs:418` `launch` → `spawn_agent` `:483` + `create_conversation_core` `:498` + Branch A `:551` | ✅ **always** | ❌ never | `AutomationConfig` has **no** conversation field (`models/automation.rs:88-101`) |
| Scheduler — EnqueueTask | `automation/engine.rs:423` → task engine | ✅ always | — | Task owns execution |
| Task board — Fresh | `work_task/engine.rs:565` `launch` (`spawn_agent` `:676`) | ✅ | — | New worktree + new row |
| Task board — Retry/Return/Merge | same `launch`, `resume_session_id` `:645-658`, `spawn_agent` `:676` | — | ✅ | Reuses `task.conversation_id` + `conversation.external_id`; row reused `:722-723` |
| Task board — auto-start pump | `work_task/engine.rs:531` `spawn_launch` → `:535` `launch` | same as mode | same as mode | Background drain of queued tasks |
| Channel — `/task` | `session_commands.rs:470+` (`spawn_agent` `:552`) | ✅ | — | Creates row `:528`, fresh spawn, thread binding `:581` |
| Channel — `/resume <id>` | `session_commands.rs:828` (`spawn_agent` `:892`) | — | ✅ | Resumes `conv.external_id`, reuses row |
| Channel — follow-up (topic) | `session_commands.rs:1193` → `resume_topic_binding_and_send_followup` `:1287` → `spawn_chat_connection_for_conversation` `:1522` | — | ✅ | Auto-resume + `send_chat_prompt_linked` `:1355` |
| Channel — follow-up (legacy/general) | `session_commands.rs:1117` `handle_followup` → `send_chat_prompt` `:1168` | — | ✅ | Non-linked `send_prompt` on live connection |
| Delegation `delegate_to_agent` | `acp/delegation/broker.rs:2222` (`spawn_agent` `manager.rs:2815`) + `:2297` (`send_prompt_linked_for_delegation` `manager.rs:2829`) | ✅ always | — | New child conversation + `DelegationLink`; `delegation.is_some() && conversation_id.is_some()` rejected (`manager.rs:849`) |
| codeg-mcp companion | `bin/codeg_mcp.rs` (drives broker over UDS) | ✅ (via broker) | — | Child-side only; parent spawns it per launch |
| Fork | `manager.rs:1319` `fork_session` | ✅ new session | parent preserved | `session/fork` on live connection; sibling row; no new process |
| Agent-options probe | `manager.rs:1674` (`spawn_agent` `:1706`) | ❌ (no conversation) | ❌ | Noop emitter, immediate disconnect; delegation-settings UI only |

---

## 3. Scheduler — "Launch Session" Deep Dive

**Action model:** `AutomationAction` enum (`src-tauri/src/models/automation.rs:75-82`) has exactly two variants: `LaunchSession` (default) and `EnqueueTask`. The scheduler's session-launch behavior is entirely the `LaunchSession` path.

**Execution path (verified):**
1. **Triggers** — the automation engine runs in two ways:
   - Manual "Run now": `commands/automation.rs:202` → `eng.run_automation(id, "manual", None)`
   - Scheduled fire: `automation/engine.rs:267` → `eng.run_automation(id, "schedule", Some(slot))`, inside the long-lived scheduler loop spawned by `run_automation_engine` (`automation/engine.rs:218`)
2. **Dispatch** — `run_automation` (`engine.rs:301`) inspects the `AutomationAction`:
   - `LaunchSession` → `engine.launch(automation_id, cwd)` at `engine.rs:418`-ish (spawn + prompt path)
   - `EnqueueTask` → `engine.rs:423`-ish defers entirely to the work-task engine (see Part 7), no session machinery
3. **LaunchSession mechanics** (all citations `automation/engine.rs`):
   - Resolves working directory from config + storage (near `:483`)
   - Calls `spawn_agent` (fresh, `session_id=None`) at `:483`
   - **Creates a brand-new conversation row** at `:496-510` — the in-source comment is explicit: *"Create the conversation row, then adopt it in send_prompt (Branch A)"*
   - Sends the prompt via `.send_prompt_linked_with_message_id(...)` at `:553` with that fresh row id → **Branch A adopt** (Part 4)

**Verdict:** the scheduler **never** targets an existing conversation. `AutomationConfig` (`models/automation.rs:88-101`) carries no conversation selector — only `action`, `prompt_blocks`, `mode_id`, `config_values`, `label_snapshot`. A "Launch Session" automation is structurally a **disposable, always-fresh run**: new process, new conversation, new row. This is by construction (each run is isolated from prior runs), not an accident.

---

## 4. Conversation Decision Points — Who Decides "New vs Existing"

Every prompt path funnels into `send_prompt_linked_with_message_id` (`acp/manager.rs:816`) — the **single function** that owns the new-vs-existing decision for row creation. It is structured as `if !already_linked { match (conversation_id, folder_id) }`:

- **Branch A (adopt existing):** caller supplied `conversation_id` (and it's not already linked) → reuse that row. Implemented in the `branch_a` helper (`manager.rs:4427-4471`).
- **Branch B (create new):** caller supplied `folder_id` but no usable `conversation_id` → `conversation_service::create_with_delegation(...)`. Implemented in the `branch_b` helper (`manager.rs:4377-4424`).
- **Already linked:** the live connection already carries a conversation link → prompt straight through.

The decision is therefore distributed across **callers**, not centralized:

| Path | Who decides | Decision mechanism (verified) |
|---|---|---|
| Chat UI | Frontend | `acp-connections-context.tsx:4767` passes `folderId`/`conversationId`/`clientMessageId`; discovery at `:4440-4471` may route to an existing connection or attach as viewer (`connectAsViewer`) |
| REST API | Caller | Same `(folder_id, conversation_id)` contract (`web/handlers/acp.rs:161-167`) |
| Work-task Fresh | Engine (mode) | `LaunchMode::Fresh` → new; `launch_mode_for` at `work_task/engine.rs:1938` |
| Work-task retry/resume/merge | Engine (mode) | resumes previous session `external_id` + reuses `task.conversation_id` row (`work_task/engine.rs:704`, prompt `:784`) |
| Channel `/task` | Handler | Always new row + fresh spawn (`session_commands.rs:552`) |
| Channel `/resume <id>` | Handler | Explicit `conversation_id` → `conv.external_id` as session_id (`session_commands.rs:892`) |
| Channel follow-up | Binding/mapping | `sender_context_service` (`current_connection_id`+`current_conversation_id`) or Telegram topic `thread_binding_service` (`session_commands.rs:1450`) |
| Scheduler `LaunchSession` | Engine | **Always** create-then-adopt (`automation/engine.rs:496-510`) |
| Delegation child | Broker/manager | `spawn_agent` with `session_id=None` (`manager.rs:2815`) + `send_prompt_linked_for_delegation` (`manager.rs:2829`); note guard: `delegation.is_some() && conversation_id.is_some()` is rejected (`manager.rs:849`-area) |

**Key asymmetry (verified):** the UI, REST, work-task, and channel paths all *can* select an existing conversation; the scheduler and delegation-child paths *cannot* (by construction).

---

## 5. Conversation Identifiers — How Each Path Names a Target

| Identifier | Definition | Used by (verified) |
|---|---|---|
| `conversation_id` (i32 row pk) | DB row id | UI prompt opts (`acp-connections-context.tsx:4767`), `/resume` (`session_commands.rs:828`), fork `link_conversation_id` (`manager.rs:1319`), `find_connection_for_conversation` (`web/handlers/acp.rs:558-568`) |
| `external_id` | Agent's session id string | `spawn_agent(session_id=Some)` resume, session snapshots, `/resume` passthrough, work-task resume |
| `folder_id` | Workspace folder row | Branch B creation anchor (`manager.rs:4377-4424`), UI prompt opts |
| `client_message_id` | Idempotency key | UI/REST prompt opts |
| `(channel_id, sender_id)` → `sender_context_service` | Current conn/conversation per channel user | Channel follow-ups (`session_commands.rs:1450`) |
| `thread_binding_service` / `SessionBridge.find_by_target` | Telegram forum topic ↔ conversation | Topic follow-ups (`session_commands.rs:1287`, `session_bridge.rs:49-96`) |
| Frontend `contextKey` + `reverseMapRef` | connectionId ↔ conversationId | `acp-connections-context.tsx` state layer |
| `DelegationLink` (parent conv + tool_use_id) | Parent-child audit trail | `acp/delegation/` broker |

No scheduler-side conversation selector exists (Part 3); the scheduler's only identity is `automation_id` + run slot.

---

## 6. Shared Pipeline — All Paths Converge

Confirmed convergence (single funnel, verified by grep over `.spawn_agent(` / `.send_prompt` / `.send_prompt_linked`):

```
entry point ──► ConnectionManager::spawn_agent (manager.rs:400)
                 └── spawn_agent_connection (connection.rs:1098)
                      └── ACP connect/init + session event loop
prompt ──► send_prompt_linked_with_message_id (manager.rs:816)  [row decision here]
           └── send_prompt_inner (manager.rs:688)               [only enqueue point]
                └── ConnectionCommand::Prompt
events ◄── EventEmitter (Tauri / WebOnly) ──► frontend; webhook sink (OUTBOUND only)
```

- **All 9 process launches** go through `ConnectionManager::spawn_agent`.
- **All linked prompts** go through `send_prompt_linked_with_message_id` (UI `commands/acp.rs:8496`, REST `web/handlers/acp.rs:167`, automation `automation/engine.rs:553`, work-task `work_task/engine.rs:784`, delegation `manager.rs:2829`).
- **Non-linked prompts** (`conn_mgr.send_prompt`) exist only for already-linked live connections (channel event subscriber `session_event_subscriber.rs:135,510`, channel follow-up `session_commands.rs:1564`) — they never create rows.
- Event fan-out is unified (EventEmitter per mode), and chat-channel inbound events are marshalled by `command_dispatcher.rs` (`dispatch_command` `:192`) into the same `session_commands.rs` handlers.

**Implication (verified):** any change to conversation selection semantics touches exactly one decision gate (`send_prompt_linked_with_message_id`) plus the caller-side selector logic of each entry point — there is no second parallel session-start pipeline.

---

## 7. Scheduler Run Mechanism (Mechanics, Not Conversation Behavior)

**Engine lifecycle** (all citations `automation/engine.rs` unless noted):
1. `run_automation_engine` spawns a long-lived tokio task (`:218`) at app startup (server binary `bin/codeg_server.rs`, desktop via the shared engine bootstrap).
2. The loop (near `:267`) pops due slots and calls `run_automation(id, "schedule", Some(slot))`.
3. Manual runs: `commands/automation.rs:202` calls `run_automation(id, "manual", None)` — same downstream path, different trigger label (used for last-run tracking / UI).
4. `run_automation` (`:301`) reads the `AutomationConfig`, resolves `AutomationAction`:
   - `LaunchSession` → the fresh spawn+create+adopt sequence (Part 3).
   - `EnqueueTask` (`:423`-ish) → hands the task to the work-task engine; **no** ACP session is launched by the scheduler itself (session launch is deferred to the task engine, Part 9).
5. Work-task side: queued tasks are drained by the background pump `spawn_launch` (`work_task/engine.rs:531` → `engine.launch(task_id, mode)` at `:535`); `launch_mode_for` (`:1938`) maps each `WorkTaskStatus` to a `LaunchMode`.

**Recovery/repeat semantics:** run id (`run_id`) + run history rows are written per fire; a `LaunchSession` automation creates a fresh conversation on **every** fire — consecutive runs of the same automation are never chained to the prior run's conversation.

---

## 8. Channel Backends (Telegram / Lark / Weixin / "Webhooks")

**Verified backend surface:** `ChannelType` enum (`src-tauri/src/chat_channel/types.rs:5-9`) declares exactly three real-time channel types — **Lark, Telegram, Weixin**. There is **no WhatsApp backend and no Discord backend** in the tree (grep + enum + `backends/` directory listing confirm). Channel factory: `chat_channel/backends/mod.rs:11-33` (`create_backend` dispatch).

**Per-channel routing to sessions** (all in `chat_channel/session_commands.rs`):
- **Telegram**: supports both general-topic and forum-topic modes.
  - `/task` creates a fresh session + conversation and, for Telegram general-topic mode, creates a thread for the task (`:510-517` area, spawn at `:552`).
  - Topic follow-ups resolve via `thread_binding_service::get_by_target` + `SessionBridge.find_by_target` (`:1450`), then `send_chat_prompt_linked` (`:1355`).
  - `/resume <conversation_id>` resumes an existing conversation (`:892`).
- **Lark / Weixin**: follow the same dispatcher path (`command_dispatcher.rs` `dispatch_command` `:192`); conversation mapping via `sender_context_service::get_or_create(channel_id, sender_id)` (`:1450`) → `current_connection_id` + `current_conversation_id`.
- **Webhooks** (`chat_channel/webhook.rs`): **outbound-only event sink** — POSTs agent events to configured URLs (docstring lines 1-11). No inbound webhook can start a session; it is not a launch entry point.
- **chat_channel/scheduler.rs**: periodic output-only messaging; no `spawn_agent`/`send_prompt` machinery (grep-verified) — not a launch path.

**Conclusion for channels:** every real-time channel supports both create (`/task`) and resume (`/resume`, topic/general follow-up reuse). The channel layer is the *only* entry-point family with a per-user persistent mapping service (`sender_context_service`) as its primary targeting mechanism.

---

## 9. Hidden / Non-Obvious / Unintentional Entry Points

| Path | Where (verified) | Conversation behavior | How hidden |
|---|---|---|---|
| Agent-options probe | `acp/manager.rs:1706` `probe_agent_options` (spawn with `EventEmitter::Noop`) | **No conversation, no prompt** — spawn, read options, immediate disconnect | No event reaches the frontend; invisible to users |
| Delegation/MCP child | `acp/delegation/spawner.rs` trait (`spawn` + `send_prompt_linked_for_delegation`); manager impl at `manager.rs:2814-2826`; broker `broker.rs:1149-1224`; listener wired in `bin/codeg_server.rs:334-357` | Always fresh session + new conversation (Branch B) | Launched by the `codeg-mcp` stdio companion (`delegate_to_agent`) or REST/Tauri delegation endpoints |
| Work-task auto-start pump | `work_task/engine.rs:531` `spawn_launch` (background drain of queued tasks) | Fresh or resume per `LaunchMode` | No UI action required — queue + pump triggers launches |
| Automation engine background loop | `automation/engine.rs:218` + boot recovery runs | Always fresh (LaunchSession) | Scheduled automations fire without user presence |
| Fork (session/fork) | `acp/fork.rs:19`, `manager.rs:1319` | New agent session derived from a **live** connection; parent preserved | No new OS process — a "soft" launch on the ACP connection |
| Viewer attach | `acp-connections-context.tsx:4440-4471` (`connectAsViewer`) | **Not a launch** — attaches to an existing connection | Often miscounted as a launch; explicitly excluded here |
| Companion in-session tools | `codeg-mcp` tools (`check_user_feedback`, `ask_user_question`, `get_session_info`) | Steering, not launching | In-session MCP; no session start |
| `send_prompt` non-linked calls | `session_event_subscriber.rs:135,510` | Continue an already-linked live connection | Only valid when a connection exists — no row creation |

---

## 10. Conclusion & Architectural Boundary

**How many distinct session-launch mechanisms?** **7** — UI (desktop+REST, same `spawn_agent` path), Scheduler `LaunchSession`, Work-Task engine (incl. auto-start pump), Chat Channels, Delegation/MCP child, hidden Probe, and Fork. All but Fork (soft session on a live connection) converge on the single `ConnectionManager::spawn_agent` process-launch function; all prompt-bearing paths converge on `send_prompt_linked_with_message_id` → `send_prompt_inner`.

**Which mechanisms support existing conversations (verified):**
- UI / REST — yes (`conversation_id` in prompt opts; `session_id` resume in `acp_connect`).
- Work-Task — yes, for Retry/Return/Merge (`task.conversation_id` + `external_id` resume); Fresh always new.
- Channels — yes (`/resume`, topic/general follow-up via `sender_context_service` / `thread_binding_service`); `/task` always new.
- **Scheduler `LaunchSession` — no** (always fresh process + fresh conversation row; `AutomationConfig` has no conversation selector).
- **Delegation child — no** (always fresh; conversation-link param explicitly rejected with delegation).
- Probe — neither (no conversation).

**Best abstraction boundary (evidence-based):** the single conversation-selection seam is the `(conversation_id, folder_id)` contract of `send_prompt_linked_with_message_id` (`manager.rs:816`) with its Branch A/B gate (`manager.rs:4377-4471`) — **not** a new parallel pipeline. Caller-side selectors already exist per family: frontend `conversationId`/`sessionId`, `LaunchMode`, `sender_context_service`, `thread_binding_service`, explicit `/resume` id. The scheduler is the only family with no selector — which is the observable gap, not a missing pipeline. Any future capability to point a scheduled automation at an existing conversation should live upstream of that one gate (as a selector resolving to `(folder_id, conversation_id)`), keeping the verified single-funnel property intact.


