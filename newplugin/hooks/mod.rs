//! Custom Codeg backend hooks, kept outside the upstream crate tree so they
//! survive upstream merges. Mounted from `src-tauri/src/lib.rs` via:
//! `#[path = "../../newplugin/hooks/mod.rs"] pub mod custom_hooks;`
//!
//! The Tauri command shims are feature-gated: `codeg-server` builds without
//! `tauri-runtime` (see `src-tauri/Cargo.toml`), so nothing in here may depend
//! on the `tauri` crate unconditionally.

pub mod custom_auto_approve;
pub mod custom_cron;
// Non-git accept (review → done without a merge, for tasks without a
// worktree). See `task_accept` for the guard rules and the upstream-engine
// rationale.
pub mod task_accept;
// Axum web-handler shims (needed in both desktop and server modes, unlike the
// feature-gated Tauri command shims below).
pub mod web_workflows;

/// Toggle GLOBAL auto-accept of tool-permission requests. App-wide: when on,
/// the permission-request gate in `handle_permission_request` answers every
/// request with the agent's first `allow_*` option, across every surface.
/// Returns the new enabled state.
#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn toggle_auto_approve_global(
    db: tauri::State<'_, crate::db::AppDatabase>,
    manager: tauri::State<'_, crate::acp::manager::ConnectionManager>,
) -> Result<AutoApproveToggleResult, String> {
    // Delegate to the shared orchestration (persists to `app_metadata`, then
    // reconciles every parked card when flipping ON).
    match custom_auto_approve::toggle_global_auto_approve_core(&db, &manager).await {
        Ok(enabled) => {
            tracing::info!("auto_approve toggled globally enabled={enabled}");
            Ok(AutoApproveToggleResult { enabled })
        }
        Err(e) => {
            tracing::warn!("toggle_global_auto_approve failed error={e}");
            Err(e.to_string())
        }
    }
}

/// Read whether GLOBAL auto-accept is on.
#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn get_auto_approve_global(
    db: tauri::State<'_, crate::db::AppDatabase>,
) -> Result<AutoApproveGetResult, String> {
    tracing::debug!("get_auto_approve_global requested");
    match custom_auto_approve::get_global_auto_approve(&db).await {
        Ok(enabled) => Ok(AutoApproveGetResult { enabled }),
        Err(e) => {
            tracing::warn!("get_global_auto_approve failed error={e}");
            Err(e.to_string())
        }
    }
}

// Minimal response shapes used by the shim.
#[derive(serde::Serialize)]
pub struct AutoApproveToggleResult {
    pub enabled: bool,
}

#[derive(serde::Serialize)]
pub struct AutoApproveGetResult {
    pub enabled: bool,
}

/// Per-conversation auto-accept result: the EFFECTIVE state plus the RAW
/// override, so callers (and future Auto/On/Off tri-state UI) can distinguish
/// an explicit per-chat ON (`overrideState = true`) from an inherited global
/// state (`overrideState = null`).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoApproveConversationResult {
    pub enabled: bool,
    pub override_state: Option<bool>,
}

/// Toggle PER-CONVERSATION auto-accept (runtime only, in-memory). Flips the
/// raw override — absent -> explicit ON, present -> remove (inherit global).
/// An effective OFF -> ON transition reconciles already-parked permission
/// cards for that conversation.
#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn toggle_auto_approve_conversation(
    conversation_id: i32,
    manager: tauri::State<'_, crate::acp::manager::ConnectionManager>,
) -> Result<AutoApproveConversationResult, String> {
    match custom_auto_approve::toggle_per_chat_auto_approve_core(&manager, conversation_id).await {
        Ok(result) => {
            tracing::info!(
                "auto_approve toggled per-chat conversation_id={conversation_id} enabled={} override={:?}",
                result.enabled,
                result.override_state
            );
            Ok(result)
        }
        Err(e) => {
            tracing::warn!("toggle_per_chat_auto_approve failed error={e}");
            Err(e.to_string())
        }
    }
}

/// Read the EFFECTIVE auto-accept state + raw override for a conversation
/// (explicit override wins, else the global flag).
#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn get_auto_approve_conversation(
    conversation_id: i32,
) -> Result<AutoApproveConversationResult, String> {
    Ok(custom_auto_approve::get_per_chat_auto_approve_result(conversation_id).await)
}

/// Save (insert or replace) a custom workflow.
#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn save_custom_workflow(workflow: CustomWorkflow) -> Result<(), String> {
    custom_cron::save_workflow(workflow)
}

/// Delete a custom workflow by id.
#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn delete_custom_workflow(id: String) -> Result<(), String> {
    custom_cron::delete_workflow(&id)
}

/// List all custom workflows.
#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn list_custom_workflows() -> Result<Vec<CustomWorkflow>, String> {
    Ok(custom_cron::list_workflows())
}

/// Enable or disable a workflow (the pause switch in the UI). Errors if the id
/// does not exist, so the UI can treat a missing row as already deleted.
#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn set_custom_workflow_enabled(id: String, enabled: bool) -> Result<(), String> {
    custom_cron::set_enabled(&id, enabled)
}

/// Fire a workflow immediately, bypassing its schedule. Resolves the target
/// connection from the managed app state — same path the web handler uses.
#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn run_custom_workflow_now(
    db: tauri::State<'_, crate::db::AppDatabase>,
    manager: tauri::State<'_, crate::acp::manager::ConnectionManager>,
    id: String,
) -> Result<i32, String> {
    custom_cron::run_now(&db, &manager, &id).await
}

pub use custom_cron::CustomWorkflow;

/// Accept a reviewed task that has no worktree (`review → done`, no git
/// merge). The engine cannot express this transition (its only `done` writer
/// is the git merge path); `task_accept` refuses tasks that still own a
/// worktree. Desktop front of the same logic the `/work_task_accept` web route
/// uses.
#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn work_task_accept(
    app: tauri::AppHandle,
    db: tauri::State<'_, crate::db::AppDatabase>,
    id: i32,
) -> Result<(), String> {
    task_accept::accept_task(&db, &crate::web::event_bridge::EventEmitter::Tauri(app), id).await
}
