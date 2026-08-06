//! Axum web-handler shims for the Custom Workflows hooks.
//!
//! These are the HTTP (server-mode) front for the scheduler storage and
//! engine in `custom_cron`. The desktop-mode front lives in the parent
//! `mod.rs` as feature-gated Tauri command shims. Both are thin: every
//! function here only parses the request and delegates to `custom_cron`,
//! carrying no business logic of their own.

use std::sync::Arc;

use axum::{Extension, Json};

use crate::app_error::{AppCommandError, AppErrorCode};
use crate::app_state::AppState;
use crate::web::handlers::work_task::IdParams;

use super::custom_cron::{self, CustomWorkflow};
use super::task_accept;

/// POST body for `save_custom_workflow`: the full workflow row to insert or
/// replace (merge semantics live in `custom_cron::save_workflow`).
#[derive(serde::Deserialize)]
pub struct SaveWorkflowRequest {
    pub workflow: CustomWorkflow,
}

/// POST body for `delete_custom_workflow` / `run_custom_workflow_now`.
#[derive(serde::Deserialize)]
pub struct WorkflowIdRequest {
    pub id: String,
}

/// POST body for `set_custom_workflow_enabled`.
#[derive(serde::Deserialize)]
pub struct SetWorkflowEnabledRequest {
    pub id: String,
    pub enabled: bool,
}

/// Map a storage-layer error onto the wire error type (the JSON file store
/// surfaces as an I/O error).
fn storage_error(operation: &str, e: String) -> AppCommandError {
    tracing::warn!("custom workflow {operation} failed: {e}");
    AppCommandError::new(
        AppErrorCode::IoError,
        format!("custom workflow {operation} failed: {e}"),
    )
}

/// List all custom workflows, oldest first as persisted.
pub async fn custom_workflow_list() -> Result<Json<Vec<CustomWorkflow>>, AppCommandError> {
    Ok(Json(custom_cron::list_workflows()))
}

/// Insert or replace a custom workflow.
pub async fn custom_workflow_save(
    Json(req): Json<SaveWorkflowRequest>,
) -> Result<Json<()>, AppCommandError> {
    custom_cron::save_workflow(req.workflow).map_err(|e| storage_error("save", e))?;
    Ok(Json(()))
}

/// Delete a custom workflow by id.
pub async fn custom_workflow_delete(
    Json(req): Json<WorkflowIdRequest>,
) -> Result<Json<()>, AppCommandError> {
    custom_cron::delete_workflow(&req.id).map_err(|e| storage_error("delete", e))?;
    Ok(Json(()))
}

/// Enable or disable a workflow (the pause switch in the UI).
pub async fn custom_workflow_set_enabled(
    Json(req): Json<SetWorkflowEnabledRequest>,
) -> Result<Json<()>, AppCommandError> {
    custom_cron::set_enabled(&req.id, req.enabled)
        .map_err(|e| storage_error("set_enabled", e))?;
    Ok(Json(()))
}

/// Fire a workflow immediately, bypassing its schedule. Resolves the target
/// conversation so the UI can surface where the prompt landed.
pub async fn custom_workflow_run_now(
    Extension(state): Extension<Arc<AppState>>,
    Json(req): Json<WorkflowIdRequest>,
) -> Result<Json<i32>, AppCommandError> {
    match custom_cron::run_now(&state.db, &state.connection_manager, &req.id).await {
        Ok(conversation_id) => Ok(Json(conversation_id)),
        Err(e) => {
            tracing::warn!("custom workflow run_now failed: {e}");
            Err(AppCommandError::new(
                AppErrorCode::TaskExecutionFailed,
                format!("custom workflow run failed: {e}"),
            ))
        }
    }
}

/// Accept a reviewed task that has no worktree (`review → done`, no git
/// merge). Server-mode front of `task_accept::accept_task` (the desktop front
/// is the `work_task_accept` Tauri shim in `mod.rs`). Refuses tasks that still
/// own a worktree.
pub async fn work_task_accept(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<IdParams>,
) -> Result<Json<()>, AppCommandError> {
    task_accept::accept_task(&state.db, &state.emitter, params.id)
        .await
        .map_err(|e| {
            tracing::warn!("work_task_accept failed: {e}");
            AppCommandError::new(AppErrorCode::TaskExecutionFailed, e)
        })?;
    Ok(Json(()))
}
