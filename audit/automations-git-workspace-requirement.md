# Audit: Can Automations Run Without a Git Workspace?

**Status:** read-only audit (no code modified)
**Date:** 2026-08-05
**Method:** direct file reads/greps with `file:line` citations (qartez/codebase-memory
MCP were not exposed in the session toolset; memory store queried, nothing contradicted).

**Objective:** determine whether Automations fundamentally require a Git
workspace/worktree or whether this is only a UI/design restriction.

---

## 1. Complete execution path: Automation → Launch Session

Both triggers converge on one function:

- **Manual "run now"**: `automation_run_now_core` → `engine.run_automation(automation_id, "manual", None)`
  — `src-tauri/src/commands/automation.rs:198-202`
- **Scheduled**: engine select-loop `schedule.tick()` → `list_due`/`claim_due` →
  `run_automation(id, "schedule", …)` — `src-tauri/src/automation/engine.rs:256-276`

Then (`src-tauri/src/automation/engine.rs`):

| # | Step | Location |
|---|---|---|
| 1 | Fire lock + load `AutomationInfo` | `engine.rs:310-315` |
| 2 | Overlap guard (`has_active_run`) | `engine.rs:318-327` |
| 3 | Insert `automation_run` row (`start_run`) + emit `RunStarted` | `engine.rs:329-341` |
| 4 | **`launch()`** | `engine.rs:418` |
| 5 | Parse `AutomationConfig`; **`EnqueueTask` action short-circuits — no worktree, no spawn** | `engine.rs:419-425` |
| 6 | Parse agent type + prompt blocks | `engine.rs:426-435` |
| 7 | Resolve pinned target row (`conversation_service::get_by_id`) → `newplugin_backend::launch_target::decide()` → `Fresh` \| `Resume{…}` | `engine.rs:443-468` |
| 8 | **`resolve_cwd()` — the worktree/folder step** | `engine.rs:470` |
| 9 | Broadcast folder; `build_session_runtime_env` + `verify_agent_installed` | `engine.rs:477-491` |
| 10 | Cancel re-check | `engine.rs:498-514` |
| 11 | **`manager.spawn_agent(agent, Some(cwd.working_dir), resume_session_id, …)`** | `engine.rs:519-532` |
| 12 | Conversation row: `Resume` → adopt pinned (Branch A); `Fresh` → `create_conversation_core` | `engine.rs:539-557` |
| 13 | Index `connection_id→run`; `attach_run_runtime`; re-emit `RunStarted` w/ link | `engine.rs:564-587` |
| 14 | **`manager.send_prompt_linked_with_message_id(… conversation_id, folder_id …)`** | `engine.rs:608-619` |
| 15 | Completion: `on_event` on `TurnComplete` → `settle_run`; reconcile backstop | `engine.rs:780-820`, `832-908` |

**Only step 8 (and its UI pre-requisite in the editor) involves a worktree/git.**

---

## 2. Where workspace/worktree becomes mandatory (per layer)

| Question | Answer | Evidence |
|---|---|---|
| **Required by UI?** | **YES** — folder is a hard gate | `src/components/automations/automation-editor.tsx:258` `if (folderId == null) return setError(t("errorFolder"))`; save always writes `root_folder_id: folderId` (`:325`); folder dropdown excludes chat folders (`src/stores/app-workspace-store.ts:89,316`; `src/lib/folder-display.ts:50-60`) |
| **Required by API?** | **NO** — `root_folder_id` is `Option<i32>` | `src-tauri/src/models/automation.rs:63` (`AutomationDraft`), `:19` (`AutomationInfo`) |
| **Required by AutomationConfig?** | **NO** — config has no folder field | `src-tauri/src/models/automation.rs:88-107` (only `action`, `prompt_blocks`, `mode_id`, `config_values`, `label_snapshot`, `existing_conversation_id`) |
| **Required by Automation Engine?** | **YES** — but only by the current `resolve_cwd` implementation | `engine.rs:646-648` `let Some(root_folder_id) = auto.root_folder_id else { return Err("automation has no target folder") }`. WorktreePerRun → `git_worktree_add` (`src-tauri/src/commands/folders.rs:1843`) + `open_worktree_folder_core`; SharedInRoot+branch → `resolve_worktree_folder_core` → `ensure_git_repo` (`src-tauri/src/git_repo.rs:32`) + `git_checkout`/`git_is_clean`. **SharedInRoot with no branch runs with zero git operations** (`engine.rs:691-695`) |
| **Required by ConnectionManager?** | **NO** | `src-tauri/src/acp/manager.rs:400-410`: `working_dir: Option<String>`; `src-tauri/src/acp/connection.rs:2308-2321` `resolve_working_dir(None)` falls back to process cwd/home |
| **Required by ACP?** | **NO** | `send_prompt_linked_with_message_id` (`manager.rs:816-940`) only validates `conversation_id`+`folder_id` pairing; zero git calls. `build_agent` (`connection.rs:701`) launches Npx/Binary/Uvx — no git |
| **Required by Agent startup?** | **NO** | `build_session_runtime_env` (`src-tauri/src/commands/acp.rs:8236`) + `verify_agent_installed` (`:499`) — settings/binary checks only. Process cwd pinning is conditional on dir existence (`connection.rs:1066-1070`) |
| **Required by provider?** | **NO (codeg-side)** | Registry launch metadata for all providers is git-free: ClaudeCode Npx `claude-agent-acp` (`registry.rs:367`), Codex Npx `codex-acp` (`:444`), Gemini Npx `gemini --acp --skip-trust` (`:458`), OpenCode Binary `opencode acp` (`:502`), OpenClaw Npx (`:474`), Cline Npx (`:488`). Codeg does not enforce a git repo at spawn for any of them |

---

## 3. Can an agent session start with no repo / no git / no worktree / only a conversation?

**Technically yes — for every layer below the automation engine, and proven in
production by Chat mode.** The exact blocking function for *automations* is:

> **`AutomationEngine::resolve_cwd`** — `src-tauri/src/automation/engine.rs:645-648`:
> `let Some(root_folder_id) = auto.root_folder_id else { return Err("automation has no target folder".to_string()) };`

plus the editor gate (`src/components/automations/automation-editor.tsx:258`).
Neither ACP, ConnectionManager, the send path, nor any provider requires a git
repo — a working directory is just a path string, and even `None` degrades to
the process cwd (`connection.rs:2308-2321`).

The `LaunchTarget::Resume` path added for the existing-conversation feature
**already decouples the conversation from the run's worktree**: the prompt groups
under the pinned conversation's own `folder_id`, not the run's cwd
(`engine.rs:539-544`). The remaining mandatory git/worktree step is
`resolve_cwd` alone.

---

## 4. Comparison with Chat mode

**Chat trace (New Chat → Launch Session):**

1. UI picks "no-folder mode" → `createChatDir()` (`src/components/conversations/conversation-detail-panel.tsx:401`)
2. Backend: `create_chat_dir_core` mints a plain scratch dir
   `<data_dir>/chat-sessions/<YYYY-MM-DD>/<uuid>/` — **pure `fs::create_dir_all`, no git**
   (`src-tauri/src/commands/conversations.rs:1542-1548`)
3. ACP connects with `working_dir = <scratch dir>`, `session_id = None`
4. First send: `createChatConversation` → `create_chat_conversation_core`
   (`conversations.rs:1703-1748`): creates a **hidden chat folder**
   (`folder.kind = 'chat'`, `folder_service::add_chat_folder` at
   `src-tauri/src/db/service/folder_service.rs:164`) + conversation row; comment at
   `conversations.rs:1722-1723`: *"A fresh empty scratch dir has no git repo, so
   skip branch detection"*
5. Then the **exact same send path automations use**:
   `send_prompt_linked_with_message_id`
   (`conversation-detail-panel.tsx:1057-1069` → backend `src-tauri/src/acp/manager.rs:816`)

**What chat passes instead of a worktree:** a plain non-git scratch directory
under `data_dir` plus a `kind='chat'` folder row — nothing else.

**Could the automation engine use the same path?** Yes. The ACP/send machinery
is byte-identical and git-free. The only automation-specific blockers are the
two items in §3 (editor gate + `resolve_cwd`). Note the pinning already exists:
an automation resuming a chat-mode conversation passes that conversation's
`folder_id` (chat folder) as `prompt_folder_id` (`engine.rs:540-544`) — the
engine already *handles* a folderless conversation as its prompt target; it just
insists on a regular root folder for the cwd regardless.

---

## 5. Workspace Dependency Table

| Component | Git Required | Worktree Required | Folder Required | Reason |
|---|---|---|---|---|
| UI (automation editor) | Yes (de facto) | No | **Yes** | `errorFolder` gate (`automation-editor.tsx:258`); dropdown only lists non-chat folders (`app-workspace-store.ts:89,316`); folders are git roots by construction (`git_repo.rs:25-27`) |
| AutomationConfig | No | No | No | No folder field (`models/automation.rs:88-107`) |
| Automation Engine (`resolve_cwd`) | Depends on isolation | Yes for `WorktreePerRun`; for `SharedInRoot` only with a pinned branch | **Yes** (`root_folder_id`) | `engine.rs:645-648`; `git_worktree_add` (`folders.rs:1843`); `ensure_git_repo` (`git_repo.rs:32`); SharedInRoot-no-branch = no git (`engine.rs:691-695`) |
| ConnectionManager | No | No | No | `working_dir: Option<String>` (`manager.rs:403`); `None`→process cwd (`connection.rs:2308-2321`) |
| Agent Launcher (`build_agent`) | No | No | No | Distribution launch only (`connection.rs:701-1071`); cwd pinned only if dir exists (`:1066-1070`) |
| OpenCode | No (not enforced) | No | No | Binary `opencode acp` (`registry.rs:502`); preflight = plugin checks only (`preflight.rs:598-641`) |
| Claude Code | No (not enforced) | No | No | Npx `claude-agent-acp` (`registry.rs:367`) |
| Gemini | No (not enforced) | No | No | Npx `gemini --acp --skip-trust` (`registry.rs:458`) |
| Codex | No (not enforced) | No | No | Npx `codex-acp` (`registry.rs:444`) |
| ACP | No | No | No | `send_prompt_linked_with_message_id` validates ids only (`manager.rs:816-844`) |

---

## 6. Final Conclusion

**B. Only the current implementation requires a worktree.**

Repository evidence:

- The ACP/ConnectionManager/agent-launch/send chain has **zero** git or worktree
  requirements (`src-tauri/src/acp/manager.rs:400-410, 816-844`;
  `src-tauri/src/acp/connection.rs:701-1071, 2308-2321`; `git_repo.rs` is only
  invoked from folder/worktree commands, never from the ACP layer).
- Chat mode already runs the same providers in a **plain non-git scratch
  directory** with only a conversation (`src-tauri/src/commands/conversations.rs:1542-1548, 1703-1748`;
  `src/components/conversations/conversation-detail-panel.tsx:401, 1057-1069`) —
  an existence proof that "no repo, no git, no worktree, only a conversation"
  is technically viable for every provider codeg launches.
- The worktree requirement lives entirely in the automation layer's current
  design: the editor's `errorFolder` gate (`automation-editor.tsx:258`) and
  `resolve_cwd`'s mandatory `root_folder_id` (`engine.rs:645-648`) plus git
  shell-outs for `WorktreePerRun`/branch-pinned `SharedInRoot`
  (`folders.rs:1843, 2687`; `git_repo.rs:32`).
- The existing-conversation launch target already routes its prompt group
  through the pinned conversation's (possibly chat) folder (`engine.rs:539-544`),
  demonstrating the engine is one `resolve_cwd` decoupling away from a
  folderless launch.

No implementations were proposed and no code was written, per the audit scope.
