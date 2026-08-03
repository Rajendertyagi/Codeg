use std::sync::Arc;

use axum::{Extension, Json};

use crate::app_error::{AppCommandError, AppErrorCode};
use crate::app_state::AppState;
use crate::custom_plugins::custom_auto_approve;
use crate::custom_plugins::{AutoApproveGetResult, AutoApproveToggleResult};

/// Read the GLOBAL auto-accept state (persisted in `app_metadata`). No
/// conversation/sender scoping: the toggle is app-wide and applies to every
/// permission-request surface.
pub async fn auto_approve_global_get(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<AutoApproveGetResult>, AppCommandError> {
    match custom_auto_approve::get_global_auto_approve(&state.db).await {
        Ok(enabled) => Ok(Json(AutoApproveGetResult { enabled })),
        Err(e) => {
            tracing::warn!("auto_approve_global_get failed: error={e}");
            Err(AppCommandError::new(
                AppErrorCode::DatabaseError,
                format!("auto-approve read failed: {e}"),
            ))
        }
    }
}

/// Flip the GLOBAL auto-accept toggle; resolves with the new state. Persists to
/// `app_metadata` before returning, so the permission-request gate sees the new
/// value immediately and it survives restarts.
pub async fn auto_approve_global_toggle(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<AutoApproveToggleResult>, AppCommandError> {
    match custom_auto_approve::toggle_global_auto_approve(&state.db).await {
        Ok(enabled) => Ok(Json(AutoApproveToggleResult { enabled })),
        Err(e) => {
            tracing::warn!("auto_approve_global_toggle failed: error={e}");
            Err(AppCommandError::new(
                AppErrorCode::DatabaseError,
                format!("auto-approve toggle failed: {e}"),
            ))
        }
    }
}
