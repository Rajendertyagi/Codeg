//! Custom Codeg backend plugins, kept outside the upstream crate tree so they
//! survive upstream merges. Mounted from `src-tauri/src/lib.rs` via:
//! `#[path = "../../plugins/backend/mod.rs"] pub mod custom_plugins;`
//!
//! The Tauri command shims are feature-gated: `codeg-server` builds without
//! `tauri-runtime` (see `src-tauri/Cargo.toml`), so nothing in here may depend
//! on the `tauri` crate unconditionally.

pub mod custom_auto_approve;
pub mod custom_cron;

/// Toggle GLOBAL auto-accept of tool-permission requests. App-wide: when on,
/// the permission-request gate in `handle_permission_request` answers every
/// request with the agent's first `allow_*` option, across every surface.
/// Returns the new enabled state.
#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn toggle_auto_approve_global(
    db: tauri::State<'_, crate::db::AppDatabase>,
) -> Result<AutoApproveToggleResult, String> {
    // Delegate to the persistence-backed implementation (persists to
    // `app_metadata` before returning, so the gate and every consumer see the
    // new value immediately and it survives restarts).
    match custom_auto_approve::toggle_global_auto_approve(&db).await {
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
