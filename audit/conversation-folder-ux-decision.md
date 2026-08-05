# Product UX Audit: Existing Conversation + Folder Selection

**Date:** 2026-08-05
**Scope:** Determine the least surprising UX when Existing Conversation belongs to a different folder than Task target
**Method:** Qartez MCP (`qartez_calls`, `qartez_find`, `qartez_grep`) + codebase-memory (`search_graph`) + targeted reads of UX patterns

---

## 1. Existing Codeg UX Patterns

### Pattern 1: Automation Editor — Independent Selection

The automation editor shows conversation picker and folder target as **independent sections**:

```
Launch Target:
  ○ New Conversation
  ● Existing Conversation    → [Conversation Picker]

Target:
  ● Git Workspace            → [Folder Dropdown]
  ○ Local Folder
```

**Behavior:** No validation between conversation folder and target folder. User can pick any conversation with any target folder. The automation engine uses the target folder for execution and the conversation only for session resume.

**Evidence:** `automation-editor.tsx:593-624` — conversation picker and folder target are separate `RadioGroup` components with no cross-validation.

### Pattern 2: Conflict Dialog — Interactive Resolution

Codeg has a `ConflictDialog` (`conflict-dialog.tsx:34`) for merge conflicts. It:
- Shows the user exactly which files conflict
- Lets the user resolve each file
- Blocks completion until all conflicts are resolved

**Philosophy:** When there's a conflict that could cause data loss or confusion, Codeg blocks and explains.

### Pattern 3: Automation Validation — Prevent Invalid Combos

`automation_service::validate_draft` prevents saving invalid combinations:
```rust
// automation_service.rs:201-206
if draft.isolation == IsolationMode::SharedInRoot && draft.is_remote_branch {
    return Err(DbError::Validation(
        "a remote branch requires a per-run worktree; it can't be used with shared-in-root"
    ));
}
```

**Philosophy:** Prevent doomed configurations at save time with a clear error message.

### Pattern 4: Task Editor — Disable Invalid Options

The task editor disables the folder dropdown when a task already has a worktree:
```tsx
// task-editor-dialog.tsx:482
disabled={task != null && task.worktree_folder_id != null}
```

**Philosophy:** Prevent invalid state transitions by disabling options.

### Pattern 5: Automation Editor — Auto-Correct Invalid Selection

When switching to `enqueue_task` action, the automation editor auto-corrects an invalid folder selection:
```tsx
// automation-editor.tsx:564-571
if (opt.value === "enqueue_task" && folderId != null && !projectFolders.some((f) => f.id === folderId)) {
    setFolderId(projectFolders[0]?.id ?? null)
    setBranch("")
}
```

**Philosophy:** When a selection becomes invalid due to another choice, auto-correct to the nearest valid option.

---

## 2. Comparison of Options

### Option A: Task Folder wins (silently)

| Dimension | Assessment |
|-----------|------------|
| **Execution location** | Obvious — runs in selected folder |
| **Conversation history** | Confusing — shows work in folder A, grouped under folder B |
| **Surprise factor** | High — user might not realize conversation is from different folder |
| **Accidental wrong project** | Possible — user might run agent in wrong folder |
| **Consistency with automation** | ✅ Yes |
| **Implementation** | ~26 lines |

### Option B: Conversation wins (silently)

| Dimension | Assessment |
|-----------|------------|
| **Execution location** | Surprising — ignores user's folder selection |
| **Conversation history** | Consistent — conversation and execution in same folder |
| **Surprise factor** | Very high — user picks folder B but runs in folder A |
| **Accidental wrong project** | Very likely — folder selection is meaningless |
| **Consistency with automation** | ❌ No — opposite of automation |
| **Implementation** | ~30 lines |

### Option C: Must match (validation)

| Dimension | Assessment |
|-----------|------------|
| **Execution location** | Obvious — runs in selected folder |
| **Conversation history** | Consistent — conversation and execution in same folder |
| **Surprise factor** | None — clear error message |
| **Accidental wrong project** | Impossible — blocked by validation |
| **Consistency with automation** | ❌ No — but task context is different |
| **Implementation** | ~30 lines (+ validation message) |

---

## 3. Which Option Users Most Likely Expect

**Option C (Must match).**

Reasoning:
1. **Task Board is folder-centric.** Tasks are organized per-folder on the board. Users think "this task belongs to folder B." A conversation from folder A feels like it belongs to a different task.
2. **Sidebar grouping.** Conversations are grouped by folder in the sidebar. A conversation that appears under folder A but was created by a task in folder B is confusing.
3. **Working directory matters.** Users care about WHERE the agent works. A mismatch means the agent works in a different context than the conversation history suggests.
4. **Prevention over correction.** Users prefer to know about a conflict BEFORE execution, not discover it in the conversation history afterward.

---

## 4. Which Option Creates The Least Confusion

**Option C (Must match).**

Option A creates post-execution confusion ("Why does my conversation show work in folder B?").
Option B creates immediate confusion ("Why did it run in folder A when I picked folder B?").
Option C creates no confusion — it prevents the conflict before it happens.

---

## 5. Which Option Best Fits Codeg's Product Philosophy

**Option C (Must match).**

Codeg's philosophy (evidenced by existing patterns):
- **Prevent doomed configurations** (automation validation)
- **Block and explain conflicts** (ConflictDialog)
- **Disable invalid options** (task editor folder dropdown)
- **Auto-correct when clear** (automation editor folder reset)

Option C aligns with all of these. It prevents a confusing state before it happens, just like automation prevents invalid branch+isolation combos.

---

## 6. Recommended UX Behavior

### Validation Message

When the selected conversation's folder doesn't match the task's folder, show an inline validation error:

```
┌─────────────────────────────────────────────────────────┐
│ Target: [Project B ▾]                                    │
│                                                         │
│ Conversation: [Select conversation... ▾]                 │
│                                                         │
│ ⚠ This conversation belongs to "Project A".              │
│   To use it, switch the target to Project A or choose    │
│   a conversation from Project B.                         │
│                                                         │
│   [Switch to Project A]  [Choose another conversation]   │
└─────────────────────────────────────────────────────────┘
```

### One-Click Resolution

Two helper buttons:
1. **"Switch to Project A"** — changes the target folder to match the conversation
2. **"Choose another conversation"** — clears the conversation selection

This follows Codeg's pattern of helping the user resolve conflicts (like ConflictDialog).

### When to Validate

Validate on conversation selection change (not on save). This gives immediate feedback, following the pattern of `validate_draft` preventing doomed configurations.

---

## 7. Final Recommendation

### Recommend: **Option C (Must match)** with one-click resolution.

**Reasoning:**

1. **Task context is different from automation.** In automation, the folder is just a target location. In tasks, the folder is the organizational unit (the board is per-folder). Users expect tasks and conversations to be folder-consistent.

2. **Prevents accidental wrong-project work.** The agent working in a different folder than the conversation history suggests is a real source of user confusion. Blocking this is the safer choice.

3. **Consistent with Codeg's conflict philosophy.** Codeg blocks merge conflicts, prevents invalid automation combos, and disables invalid task options. Blocking conversation-folder mismatch follows the same philosophy.

4. **One-click resolution makes it frictionless.** The user isn't stuck — they can switch folders or pick a different conversation with one click. This matches the automation editor's auto-correction pattern.

5. **Future-proof.** As Task Board grows (more automations, more conversation types), folder consistency becomes more important. Starting with validation prevents technical debt.

**The slight inconsistency with automation (which allows mismatch) is acceptable** because:
- Automation and tasks have different organizational models
- Automation's mismatch behavior is arguably a limitation, not a feature
- Tasks can always relax to Option A later if users demand it

---

## 8. Completion Verification

### MCP tools used:
1. `codebase-memory:search_graph` — found ConflictDialog, validation patterns, automation conversation picker
2. `qartez:qartez_find` — located AutomationConversationPicker
3. `qartez:qartez_calls` — traced automation launch flow

### MCP tools available but NOT used (with reason):
- `qartez_read` — parameter binding issue; fell back to Read
- `qartez_refs` — not needed; `qartez_calls` covered the same ground
- `qartez_impact` — not relevant to UX audit
- `qartez_context` — not relevant to UX audit
- All others — not relevant to UX audit

### Skipped tools with reason:
- `qartez_deps` — already verified in prior audits
- `qartez_test_gaps` — already verified in prior audits
- `qartez_understand` — `qartez_calls` provided sufficient detail

**Status: COMPLETE.**
