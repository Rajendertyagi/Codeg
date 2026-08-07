# Post-CI Regression Audit

**Branch:** `plugin-dev` @ `8f3d2c8b` · **CI run:** 31152663037 (job `92785400133`) · **Date:** 2026-08-07

## 1. CI Status Summary

| CI Step | Result | Evidence |
|---|---|---|
| Apply 66 custom-feature patches | ✅ Passed | All 4 groups (17 auto / 16 accept / 20 launch / 13 customtab) applied cleanly in dependency order |
| Step 9 — Build frontend (`pnpm build` = `next build`) | ✅ **PASSED** | `next build` runs full TS type-check (no `ignoreBuildErrors` in next.config.ts). This means **every TS prop/destructure/i18n-usage site across all 5 feature chains type-checks green** |
| Step 10 — Pre-build codeg-mcp sidecar | ❌ **FAILED** | Exactly **2 errors, both in `newplugin/hooks/task_accept.rs`** — the ONLY compile blockers in the whole build |

**Critical insight:** `codeg-mcp` links the full `codeg_lib` crate, so step 10 type-checked the **entire non-gated library** with all 66 patches applied. The automation-engine / work-task-engine / folder_service / models / web-router / web-handler / acp-gate / auto-approve / cron patches all compiled clean — the launch-target and auto-approve Rust chains are **compile-proven green**, not just statically verified.

---

## 2. Confirmed Compile Blockers (CI) — Severity: HIGH

### Issue 1 · E0432 `unresolved import sea_orm::Expr` — `newplugin/hooks/task_accept.rs:28`
- **File:** `newplugin/hooks/task_accept.rs`, line 28
- **Cause:** `use sea_orm::{ColumnTrait, EntityTrait, Expr, QueryFilter};` — `Expr` lives at `sea_orm::sea_query::Expr` in sea-orm 1.1.19, not the crate root.
- **Fix (2 lines, verified against upstream):** add `use sea_orm::sea_query::Expr;` and drop `Expr` from the brace-import. Upstream precedent: `work_task_service.rs:18`.
- **Classification:** Missing-path trait import (wrong module path). **Confidence: 100%** (upstream uses identical pattern at 60+ call sites).

### Issue 2 · E0599 `no method named begin` — `newplugin/hooks/task_accept.rs:69`
- **File:** `newplugin/hooks/task_accept.rs`, line 69 (`conn.begin().await`)
- **Cause:** `TransactionTrait` not imported, so `begin()`/`commit()`/`rollback()` are not in scope.
- **Fix:** add `TransactionTrait` to the `sea_orm::{...}` import. Upstream precedent: `work_task_service.rs` line 22.
- **Classification:** Missing trait import. **Confidence: 100%** (compiler's own note + upstream import).

The rest of `task_accept.rs` (CAS update via `update_many().col_expr(...)`, `record_event`, `emit_event`) matches the upstream `merge_landed` shape exactly and is expected to compile once the imports are fixed. **No other compile errors exist in the build.**

---

## 3. Residual Risk (never compiled) — Severity: MEDIUM (monitor)

The `tauri-runtime`-gated code was **never compiled** (step 10 ran `--no-default-features`; the tauri build in step 12 never ran because step 10 failed):

1. **`mod tauri_app` additions in `lib.rs.patch`:** setup-block spawn of `init_global_auto_approve` + `invoke_handler` additions of `toggle_auto_approve_global`, `get_auto_approve_global` (lib.rs.patch), `work_task_accept` (accept.patch).
2. **8 `#[cfg(feature = "tauri-runtime")] #[tauri::command]` shims** in `newplugin/hooks/mod.rs`: `work_task_accept`, `toggle/get_auto_approve_global`, and 5 Custom Workflows commands.

**Static verification of this tail — all pass:**
- `AppDatabase { conn: app.state::<AppDatabase>().conn.clone() }` — `conn` is `pub`, `DatabaseConnection: Clone` is proven by 2 existing identical lines in lib.rs setup; `app.manage(database)` exists.
- `work_task_accept` shim calls `task_accept::accept_task(&db, &EventEmitter::Tauri(app), id)` — signature matches (`&AppDatabase`, `&EventEmitter`, `i32`).
- `custom_cron::run_now(&db, &manager, &id)` — signature matches `(&AppDatabase, &ConnectionManager, &str)`.
- `newplugin-backend` is added as a path dependency in Cargo.toml + Cargo.lock patches; it compiled clean in CI (separate crate).
- Frontend API names (`work_task_accept`, `get_auto_approve_global`, `toggle_auto_approve_global`) match the registered Tauri commands AND the web-router paths (`/api/{command}`) exactly.

**Verdict:** expected to compile, but step 12 must run to prove it. This is the one gap CI can't confirm yet.

---

## 4. i18n Gap — Severity: MEDIUM (real defect, CI-invisible)

**`src/i18n/messages.test.ts` parity test WILL FAIL on this branch** — but CI never runs `pnpm test` (only `pnpm build`, which type-checks against `en.json` only, and next-intl does not merge en fallback at runtime). Missing keys in non-en locales render as raw keys to users.

| Missing keys | Locales affected |
|---|---|
| 8 `Tasks.*` launch-target keys: `sectionConversation`, `conversationNew`, `conversationExisting`, `conversationSearchPlaceholder`, `errorConversationFolderMismatch`, `conversationMismatchWarning`, `switchTargetFolder`, `clearConversation` | **All 9 non-en locales** (ar, de, es, fr, ja, ko, pt, zh-CN, zh-TW) |
| 5 `Folder.chat.*` auto-approve keys: `messageInput.autoApproveOn/Off`, `permissionDialog.allowOnce/allowAlways/deny` | **7 locales** (ar, de, es, fr, ja, ko, pt) — present in en, zh-CN, zh-TW |

**Cause:** the launch i18n patches added `Automations.*` keys to all 10 locales but the `Tasks.*` keys only to `en.json`; the auto-approve group only touched en/zh-CN/zh-TW.

---

## 5. Non-Issues / Verified-Green Chains

- **TS layer (all 5 features):** frontend build green → props/destructuring/API wiring all type-check. Spot-verified: `onAccept` → `workTaskAccept` (tasks-page + detail-sheet), auto-approve shield → `get/toggleGlobalAutoApprove` (message-input), launch-target fields `existingConversationId`/`localFolderPath` (automation-editor, task-editor-dialog) → wire formats match serde snake_case.
- **Launch-target Rust:** `resolve_cwd` signature change (`auto, &cfg, run_id`) consistent across both call sites; `is_git_repo` exists (git_repo.rs:25); work-tree engine non-git branch + `existing_conversation_id` resume mirror the exact upstream Retry pattern; all `ResolvedCwd` construction sites set `folder_kind`.
- **folder_service:** `get_or_create_automation_folder` uses only existing helpers (`to_detail`, `add_folder`, `get_folder_by_id`); `ColumnTrait`/`QueryFilter`/`ConnectionTrait`/`EntityTrait` all already imported.
- **Automation engine:** `create_conversation_core`/`send_prompt_linked_with_message_id`/`conversation_status` all exist; `FolderKind::{Chat,Regular}` variants exist; `conversation_service::get_by_id` returns `Result<DbConversationSummary, DbError>` (NOT Option) — patch's `match` handles it.
- **Patch audit:** all 66 patches apply cleanly in CI order on a fresh worktree (verified, then removed).
- **Custom Workflows (Feature 5):** confirmed **UI-only placeholder** — `CustomCronEngine` is defined but never spawned, and the workflow CRUD web handlers / Tauri commands are never registered in router/invoke_handler. Matches the documented project state; correctly excluded from the audit.

---

## 6. Readiness Verdict

**Green CI on the current branch requires exactly one change: the 2-line import fix in `newplugin/hooks/task_accept.rs`** (split `Expr` → `sea_orm::sea_query::Expr`; add `TransactionTrait`).

- Frontend: **already green** (step 9 passed).
- Crate: **expected green** after the fix — all other code compiled in step 10.
- Residual risk: the `tauri-runtime`-gated tail (section 3) has never been compiled and is **statically verified but unproven** — step 12 will be the true test.

**Remaining CI-correctness caveat (non-blocking for build):** `pnpm test` is not part of CI, so the i18n parity failure (section 4) ships silently.

---

## 7. Suggested Next Steps (no code changed per audit constraints)

1. **Fix** the 2 imports in `task_accept.rs`, commit, push → confirm step 10/12 green.
2. **Add the 13 missing i18n keys** to the affected locales (or accept a known i18n debt ticket).
3. Optionally add `pnpm test` to the CI workflow so the parity test guards regressions.

No code was modified during this audit — report only.
