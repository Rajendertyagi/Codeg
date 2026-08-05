# Final Product Decision: Existing Conversation vs Folder Ownership

**Date:** 2026-08-05
**Scope:** Determine ownership model when Existing Conversation belongs to a different folder than Task target
**Method:** Qartez MCP (`qartez_calls`, `qartez_find`, `qartez_grep`) + codebase-memory (`search_graph`) + targeted reads

---

## 1. Current Codeg Behavior

### Task Engine (current — Fresh tasks only)

```
Task.folder_id → get_folder_core() → root: FolderDetail
  ↓
ensure_worktree(root.path) → WorktreeRef { folder_id, path }
  ↓
spawn_agent(working_dir: wt.path, session_id: None)
  ↓
create_conversation_core(wt.folder_id, ...) → conversation tied to task's folder
```

**Key fact:** Conversation is ALWAYS created in the task's folder. No cross-folder scenario exists today.

### Automation Engine (with Existing Conversation)

```
Automation.root_folder_id → resolve_cwd() → working directory
Automation.existing_conversation_id → pinned_target → external_id → resume_session_id
  ↓
spawn_agent(working_dir: cwd.path, session_id: resume_session_id)
  ↓
If resumed: reuse conversation (stays in original folder)
If fresh: create_conversation_core(cwd.folder_id, ...)
```

**Critical finding:** Automation resolves `working_dir` and `resume_session_id` **independently**:
- `working_dir` comes from `resolve_cwd()` → automation's target folder
- `resume_session_id` comes from `pinned_target.external_id` → existing conversation

**There is NO validation that the pinned target's folder matches the automation's target folder.**

---

## 2. Current Automation Behavior — Evidence

```rust
// automation.rs:449-474 — launch()
let pinned_target = match cfg.existing_conversation_id {
    Some(conv_id) => Some(
        conversation_service::get_by_id(&self.db.conn, conv_id).await?
    ),
    None => None,
};
let launch_target = newplugin_backend::launch_target::decide(
    cfg.existing_conversation_id,
    pinned_target.as_ref().map(|conv| TargetConversationView {
        id: conv.id,
        folder_id: conv.folder_id,      // ← conversation's folder (NOT used for cwd)
        external_id: conv.external_id.clone(),  // ← used for resume_session_id
    }),
)?;
let resume_session_id = match &launch_target {
    LaunchTarget::Fresh => None,
    LaunchTarget::Resume { resume_session_id, .. } => resume_session_id.clone(),
};

let cwd = self.resolve_cwd(auto, &cfg, run_id).await?;  // ← separate resolution
```

**What this means:**
- `pinned_target.folder_id` is passed to `launch_target::decide()` but only used for the `TargetConversationView` struct
- `resolve_cwd()` determines working directory from `auto.root_folder_id` or `cfg.local_folder_path`
- The conversation's folder does NOT affect the working directory

**Automation's model: Option A (Target Folder wins).** The conversation is resumed, but the agent runs in the automation's target folder.

---

## 3. Comparison of Options

### Option A: Task Folder wins

| Dimension | Assessment |
|-----------|------------|
| **Behavior** | Agent runs in task's folder. Conversation stays in original folder. |
| **Consistency with automation** | ✅ YES — matches automation exactly |
| **Conversation history** | ⚠️ Inconsistent — conversation shows work done in folder X, but task ran in folder Y |
| **Sidebar grouping** | Conversation appears under original folder, not task's folder |
| **Implementation** | ~26 lines (same as base Existing Conversation audit) |
| **Validation needed** | None |
| **User expectation** | "Task runs in the folder I selected" — ✅ met |

### Option B: Existing Conversation wins

| Dimension | Assessment |
|-----------|------------|
| **Behavior** | Agent runs in conversation's folder. Task's folder ignored for execution. |
| **Consistency with automation** | ❌ NO — opposite of automation |
| **Conversation history** | ✅ Consistent — conversation and execution in same folder |
| **Sidebar grouping** | Conversation appears under its own folder — ✅ consistent |
| **Implementation** | ~30 lines (need to override working directory) |
| **Validation needed** | None |
| **User expectation** | "Task runs in the folder I selected" — ❌ violated |

### Option C: Conversation and Folder must match

| Dimension | Assessment |
|-----------|------------|
| **Behavior** | Validation error if conversation's folder ≠ task's folder |
| **Consistency with automation** | ❌ NO — automation allows mismatch |
| **Conversation history** | ✅ Consistent — always same folder |
| **Sidebar grouping | ✅ Consistent — conversation in task's folder |
| **Implementation** | ~30 lines (+ validation logic) |
| **Validation needed** | Yes — check `conversation.folder_id == task.folder_id` |
| **User expectation** | Clear error message — ✅ prevents confusion |

---

## 4. Advantages and Disadvantages

### Option A: Task Folder wins

**Advantages:**
- Matches automation engine behavior (single source of truth)
- Smallest implementation (~26 lines)
- No validation logic needed
- Task folder is the explicit user choice

**Disadvantages:**
- Conversation history may show work in a different folder than where it appears
- Sidebar grouping doesn't match execution location
- Potential user confusion: "Why does my conversation show work in folder B when it's grouped under folder A?"

### Option B: Existing Conversation wins

**Advantages:**
- Conversation history is self-consistent
- Sidebar grouping matches execution location

**Disadvantages:**
- Violates automation precedent
- Task's folder selection becomes meaningless for execution
- User might not understand why their folder selection was ignored
- Larger implementation (need to override working directory)

### Option C: Must match

**Advantages:**
- Prevents all confusion
- Clear validation error
- Conversation history always consistent
- Sidebar grouping always matches

**Disadvantages:**
- Most restrictive
- Violates automation precedent (automation allows mismatch)
- Users must move conversation or change task folder
- Extra validation code

---

## 5. Which Option Best Follows Codeg's Architecture?

**Option A.**

The automation engine — the only existing system with Existing Conversation support — uses Option A. The target folder determines execution location. The existing conversation only provides the session to resume.

This is consistent with Codeg's architecture because:
1. `resolve_cwd()` is the single source of truth for working directory
2. `existing_conversation_id` is an optional session override, not a folder override
3. The conversation's `folder_id` is historical metadata, not an execution directive

---

## 6. Which Option Requires the Smallest Implementation?

**Option A (~26 lines).**

No validation logic. No folder override. Just:
1. Add `existing_conversation_id` to `WorkTaskConfig`
2. Modify `launch()` Fresh arm to use existing conversation's `external_id` as `resume_session_id`
3. Reuse `AutomationConversationPicker` in the task editor

Option C adds ~4 lines of validation. Option B adds ~8 lines of folder override logic.

---

## 7. Final Recommendation

### Recommend: **Option A (Task Folder wins)**

**Reasoning:**

1. **Single source of truth:** Codeg already has a canonical pattern — `resolve_cwd()` / `ensure_worktree()` determines execution location. The existing conversation is a session override, not a location override.

2. **Automation precedent:** The automation engine proves this pattern works in production. Users already experience Option A when using Existing Conversation in automations.

3. **Minimum change:** ~26 lines. No validation. No folder override. No new abstractions.

4. **User expectation met:** The task runs in the folder the user selected. The conversation's resume is a session-level operation, not a folder-level operation.

**The potential confusion (conversation history showing work in a different folder) is acceptable because:**
- It's already the automation engine's behavior
- The conversation's `folder_id` is historical, not prescriptive
- Users who care about folder consistency will naturally pick conversations from the same folder
- It can be addressed later with a UI hint ("This conversation is from folder X") without changing the architecture

### Implementation Note

The task editor UI should display a subtle indicator when the selected conversation belongs to a different folder:
```
Target: Folder A
Conversation: "My Chat" (from Folder B)
```

This addresses the confusion without adding validation or changing the ownership model.

---

## 8. Completion Verification

### MCP tools used:
1. `codebase-memory:search_graph` — found `existing_conversation_id`, `resolve_cwd`, `launch_target::decide`
2. `qartez:qartez_calls` — traced automation `launch()` callees
3. `qartez:qartez_find` — located `WorkTaskDraft`, `AutomationConversationPicker`

### MCP tools available but NOT used (with reason):
- `qartez_read` — parameter binding issue; fell back to Read
- `qartez_refs` — not needed; `qartez_calls` covered the same ground
- `qartez_impact` — not relevant to product decision
- `qartez_context` — not relevant to product decision
- All others — not relevant to product decision

### Skipped tools with reason:
- `qartez_deps` — already verified in prior audits
- `qartez_test_gaps` — already verified in prior audits
- `qartez_understand` — `qartez_calls` provided sufficient detail

**Status: COMPLETE.**
