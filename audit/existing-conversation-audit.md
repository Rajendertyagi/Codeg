# Architecture Audit: Existing Conversation Support for Task Board

**Date:** 2026-08-05
**Scope:** Determine if Task Engine can support Existing Conversation with minimum change
**Method:** Qartez MCP (`qartez_calls`, `qartez_find`, `qartez_grep`) + codebase-memory (`search_graph`) + targeted reads

---

## 1. Current Launch Flow

```
Task (Fresh)
  ↓
launch() [engine.rs:654]
  ↓
resume_session_id = None  ← line 782-783: LaunchMode::Fresh => None
  ↓
spawn_agent(working_dir, resume_session_id=None)  ← line 811-822
  ↓
resumed = false  ← line 810
  ↓
create_conversation_core()  ← line 863: ALWAYS called for Fresh
  ↓
send_prompt()
```

**Key insight:** For Fresh tasks, `resume_session_id` is **forced to `None`** at line 782-783. This guarantees a new conversation is always created.

For Retry/Return/Merge (line 784-794), `resume_session_id` comes from `task.conversation_id.external_id`. The resume path (lines 859-860) reuses the existing conversation.

---

## 2. Existing Conversation Flow (Automation Precedent)

The automation engine already supports this via `AutomationConfig.existing_conversation_id`:

```rust
// automation.rs:106
pub existing_conversation_id: Option<i32>,
```

When set, `LaunchSession` fires into this existing conversation instead of creating a fresh one. The automation engine resolves it via `conversation_service::get_by_id()` and uses the conversation's `external_id` as the resume session.

---

## 3. Exact Architectural Seam

The seam is **one line** in `launch()`:

```rust
// engine.rs:782-783 — CURRENT:
let resume_session_id = match mode {
    LaunchMode::Fresh => None,  // ← THIS forces new conversation
    Retry | Return(_) | Merge { .. } => { /* reuse task.conversation_id */ }
};
```

**Minimum change:** When mode is Fresh AND `task.config.existing_conversation_id` is set:
- Look up the conversation's `external_id`
- Use it as `resume_session_id`
- The existing resume path (lines 810-870) handles the rest automatically

---

## 4. Files That Would Change

| File | Change | LOC |
|------|--------|-----|
| `src-tauri/src/models/work_task.rs` | Add `existing_conversation_id: Option<i32>` to `WorkTaskConfig` | +3 |
| `src-tauri/src/work_task/engine.rs` | Modify `launch()` to check `existing_conversation_id` for Fresh mode | +8 |
| `src/components/tasks/task-editor-dialog.tsx` | Add conversation picker UI (reuse `AutomationConversationPicker`) | +15 |

**Total: ~26 lines across 3 files.**

---

## 5. Smallest Implementation

### Data Model (NO schema migration)

`WorkTaskConfig` is a JSON blob stored in `work_task.config` (Text column). Adding a field requires NO migration:

```rust
// work_task.rs:98-113 — WorkTaskConfig
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct WorkTaskConfig {
    // ... existing fields ...
    
    /// When set, this task fires into an existing conversation (resuming its
    /// external session) instead of creating a fresh one.
    /// `None` (the legacy default) keeps the always-fresh behavior.
    #[serde(default)]
    pub existing_conversation_id: Option<i32>,
}
```

This mirrors `AutomationConfig.existing_conversation_id` exactly.

### Engine (one match arm change)

```rust
// engine.rs:782-795 — MODIFIED:
let resume_session_id = match mode {
    LaunchMode:: Fresh => {
        // Check for existing conversation target
        let existing_id = serde_json::from_str::<serde_json::Value>(&task.config)
            .ok()
            .and_then(|v| v.get("existing_conversation_id").and_then(|id| id.as_i64()));
        
        if let Some(conv_id) = existing_id {
            conversation::Entity::find_by_id(conv_id as i32)
                .one(&self.db.conn)
                .await
                .ok()
                .flatten()
                .and_then(|c| c.external_id)
        } else {
            None
        }
    }
    LaunchMode::Retry | LaunchMode::Return(_) | LaunchMode::Merge { .. } => {
        // UNCHANGED: reuse task.conversation_id
        match task.conversation_id {
            Some(conv_id) => conversation::Entity::find_by_id(conv_id)
                .one(&self.db.conn)
                .await
                .ok()
                .flatten()
                .and_then(|c| c.external_id),
            None => None,
        }
    }
};
```

**What happens next (UNCHANGED):**
- `resume_session_id = Some(external_id)` → `resumed = true`
- `spawn_agent()` called with `resume_session_id` → agent resumes the session
- `create_conversation_core()` SKIPPED (line 859-860: `if resumed { task.conversation_id }`)
- Existing conversation reused

### UI (reuse existing component)

`AutomationConversationPicker` already exists at `newplugin/frontend/automation-conversation-picker.tsx`. The task editor can embed it:

```tsx
// task-editor-dialog.tsx — Target section:
// Radio: New Conversation (default) | Existing Conversation
// When Existing: show <AutomationConversationPicker onSelect={setExistingConvId} />
```

---

## 6. Estimated LOC Impact

| Category | Count |
|----------|-------|
| New code | ~20 lines |
| Modified code | ~6 lines |
| Removed code | 0 lines |
| New structs | 0 |
| New functions | 0 |
| Renames | 0 |
| Schema migrations | 0 (JSON blob) |

---

## 7. Regression Risks

| Risk | Severity | Likelihood | Mitigation |
|------|----------|------------|------------|
| Fresh task without `existing_conversation_id` | **NONE** | N/A | `#[serde(default)]` → `None` → `resume_session_id = None` → exact current behavior |
| Resume fails for existing conversation | Low | Low | Existing fallback at line 826-853 handles resume failure → fresh session |
| Conversation in different folder | Medium | Medium | Should validate conversation's folder matches task's folder (or allow cross-folder) |
| UI picker breaks task creation | Low | Low | `AutomationConversationPicker` is already tested in automation context |

---

## 8. Does This Follow the Minimum-Change Philosophy?

**YES.** Comparison with the Local Folder implementation:

| Dimension | Local Folder | Existing Conversation |
|-----------|-------------|----------------------|
| Files changed | 1 | 3 |
| New structs | 0 | 0 |
| New functions | 0 | 0 |
| Renames | 0 | 0 |
| Schema migrations | 0 | 0 |
| LOC | ~12 | ~26 |
| Reused existing code | `is_git_repo`, `WorktreeRef` | `AutomationConversationPicker`, resume path |

Both implementations:
- Reuse existing structs (no new abstractions)
- Add behavior via `else` branches, not new execution paths
- Require zero schema migrations
- Preserve existing behavior exactly when new fields are `None`

---

## 9. Final Recommendation

**Implement Existing Conversation support.**

The seam is exactly one `match` arm in `launch()`. The automation engine proves the pattern works. The `AutomationConversationPicker` provides the UI. The resume path in `launch()` (lines 810-870) already handles everything — we just need to feed it a different `resume_session_id` source.

**Implementation order:**
1. Add `existing_conversation_id` to `WorkTaskConfig` (+3 lines)
2. Modify `launch()` Fresh arm to check for existing conversation (+8 lines)
3. Add `AutomationConversationPicker` to task editor (+15 lines)

**Total: ~26 lines. Zero new abstractions. Zero schema migrations. Zero renames.**
