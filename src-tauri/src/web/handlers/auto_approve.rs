use std::sync::Arc;

use axum::{Extension, Json};

use crate::app_error::{AppCommandError, AppErrorCode};
use crate::app_state::AppState;
use crate::custom_hooks::custom_auto_approve;
use crate::custom_hooks::{
    AutoApproveConversationResult, AutoApproveGetResult, AutoApproveToggleResult,
};

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
    match custom_auto_approve::toggle_global_auto_approve_core(
        &state.db,
        &state.connection_manager,
    )
    .await
    {
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

/// Read the EFFECTIVE auto-accept state for a conversation (explicit per-chat
/// override wins, else global) plus the raw override.
pub async fn auto_approve_conversation_get(
    Extension(_state): Extension<Arc<AppState>>,
    Json(payload): Json<ConversationAutoApprovePayload>,
) -> Result<Json<AutoApproveConversationResult>, AppCommandError> {
    let result =
        custom_auto_approve::get_per_chat_auto_approve_result(payload.conversation_id).await;
    Ok(Json(result))
}

/// Flip the PER-CONVERSATION auto-accept toggle (runtime only, in-memory).
/// Flipping ON reconciles already-parked permission cards for that
/// conversation. Thin wrapper over the shared `toggle_per_chat_auto_approve_core`.
pub async fn auto_approve_conversation_toggle(
    Extension(state): Extension<Arc<AppState>>,
    Json(payload): Json<ConversationAutoApprovePayload>,
) -> Result<Json<AutoApproveConversationResult>, AppCommandError> {
    match custom_auto_approve::toggle_per_chat_auto_approve_core(
        &state.connection_manager,
        payload.conversation_id,
    )
    .await
    {
        Ok(result) => Ok(Json(result)),
        Err(e) => {
            tracing::warn!("auto_approve_conversation_toggle failed: error={e}");
            Err(AppCommandError::new(
                AppErrorCode::DatabaseError,
                format!("auto-approve toggle failed: {e}"),
            ))
        }
    }
}

#[derive(serde::Deserialize)]
pub struct ConversationAutoApprovePayload {
    #[serde(rename = "conversationId")]
    pub conversation_id: i32,
}
