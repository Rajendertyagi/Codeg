# Audit: Scheduled Automation → Telegram Report (read-only)

**Date:** 2026-08-07 (branch `plugin-dev`)
**Scope:** can a scheduled automation ("create a script, run daily 7am, send report via Telegram") actually deliver the *report text* to Telegram today?
**Method:** read-only; every claim carries a `file:line` citation against the current `plugin-dev` working tree. No code changes.

---

## Verdict

**Today: NO — not the report text.** A scheduled run completes and Telegram receives a **generic "turn complete" notification only** (`message_formatter.rs:6–15` + `event_subscriber.rs:406–418`). The agent's actual report is never forwarded, because the global-push path formats a summary *without* the assistant text, and the content-forwarding path (`session_event_subscriber`) is reserved for IM-started (bridged) sessions — which an automation session is not.

**Auto-approve (feature #1) already covers the permission-stall risk.** The remaining blocker is a *content-delivery gap*, not a config gap.

---

## 1. What already works (no code needed)

- **Auto-approve global toggle is wired (feature #1).** The gate consults `is_auto_approved_for(conversation_id)` (`custom_auto_approve.rs:175–177`), which falls back to the persisted global flag (`custom_auto_approve.rs:46–58`). It applies to **every surface**, including automation sessions — so a `PermissionRequest` from "run the script" is auto-answered; the unattended 7am run will not hang on approval. (`custom_cron.rs:8–13` confirms the scheduler owns no approval state and relies on this same toggle.)
- **Channels are bidirectional** (audit `channels-phase4.md` §2). The global-push sender half exists (`event_subscriber.rs:200–398`).
- **Native automation engine is wired (feature #4).** `AutomationEngine::run_automation` → `launch` spawns a **fresh agent per run** with owner label `"automation"` (`engine.rs:481–494`), creates a conversation, sends the prompt, and settles on `TurnComplete` (`engine.rs:716–756`). Because the owner label is `"automation"` (not `chat_channel:…`), the session is **non-bridged** → eligible for the global push (fail-closed filter does not suppress it).
- **Default global filter already allows `turn_complete`.** `DEFAULT_OFF_EVENTS = ["user_prompt_sent"]` only (`event_subscriber.rs:31`). So `turn_complete` pushes by default provided `filter_known` is true and no per-channel filter excludes it (`event_subscriber.rs:287–306, 351–359`).

## 2. What the USER must configure (no code)

- **Enable + connect the Telegram channel** (token in OS keyring; `commands/chat_channel.rs:116`).
- **Set the configured chat** (`chat_id`). Global push targets the channel's **single** configured chat (`hardcoded assumption #7`, `channels-phase4.md:227`). The report goes there and only there.
- **Per-channel event filter must include `turn_complete`** (or be left `null` = no block) (`event_subscriber.rs:351–359`). Do not set a filter that excludes it.
- Automation target folder + agent must be set (the engine needs `root_folder_id`, `engine.rs:582–584`).

## 3. The blocking gap (code change required)

- **`TurnComplete` global push carries no report text.** The handler matches `AcpEvent::TurnComplete { stop_reason, agent_type, .. }` and calls `format_turn_complete(agent_type, stop_reason, lang)` (`event_subscriber.rs:406–418`). That formatter builds only `title` + `body` (generic, agent-type only) + a `stop_reason` field (`message_formatter.rs:6–15`). The agent's final answer is **not** an input.
- **The content path is bridged-only.** `session_event_subscriber` forwards real output by buffering `ContentDelta` events and flushing at `TurnComplete` (`channels-phase4.md:121–122`). But it only handles sessions present in `SessionBridge` (`session_event_subscriber.rs` match on `connection_id`). An automation session is spawned by the automation engine with owner `"automation"` and is **never registered in `SessionBridge`** (registration sites are `/task`, `/resume`, topic auto-resume — `session_commands.rs:626/927/1311`). So its `TurnComplete` reaches only `event_subscriber`, which strips the content.
- **Net:** a scheduled automation's report text is undeliverable to Telegram as the code stands.

## 4. Recommended fix (minimal, native-pristine)

**Option A — preferred (newplugin-only extension).** Add an *automation → channel bridge hook*. The automation engine **already captures the report**: `capture_summary` reads `last_assistant_text` and `settle_run` stores it as the run `summary` (`engine.rs:760–764`, `:734–742`). On `AutomationChange::RunSettled(succeeded)`, a new `newplugin/hooks/*` subscriber reads the run's `summary` + the enabled channels (the same `enabled_channels` list the subscriber builds, `event_subscriber.rs:74,177–182`) and calls `ChatChannelManager::send_to_channel` with the text. Pure extension — **no native `src/` change**.

**Option B — patch native `event_subscriber`.** Enrich the `TurnComplete` arm to fetch `last_assistant_text` from `manager.get_state_and_emitter(conn_id)` (same call the automation engine uses, `engine.rs:761`) and pass it into the formatter. Smaller surface but touches native `src/` → needs a `.patch` (against the project's minimal-native-change discipline).

Either option is the **only missing piece** for "send report through Telegram daily."

## 5. Secondary gotchas (still apply after the fix)

- **`QuestionRequest` is delivered but unanswerable** for non-bridged sessions (`event_subscriber.rs:436–439` delivers it; there is no reply path for non-bridged — `channels-phase4.md` §7). If the agent asks a mid-run question, the unattended run stalls. Keep the prompt fully self-contained.
- **`PermissionRequest` still emits a global notification** even with auto-approve (visual only; no action required). Minor.
- **Single configured chat** — the report lands in the one pre-set Telegram chat (assumption #7).
- **Do NOT use the dormant `custom_cron` scheduler (feature #5).** It does **not** spawn a session — it injects a prompt into an *existing live connection* and fails with `"no live connection for conversation X"` if none exists (`custom_cron.rs:391–399`). Use the native automation engine (feature #4) for the 7am job.

---

## Next step

Approve an implementation approach (Option A recommended) to bridge automation run summaries → Telegram. Until then, Telegram receives only a "done" ping, not the report.
