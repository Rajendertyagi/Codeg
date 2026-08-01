use axum::Json;
use serde::Deserialize;

use crate::app_error::AppCommandError;
use crate::custom_plugins::custom_auto_approve;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationAutoApproveParams {
    pub conversation_id: i32,
}

pub async fn conversation_auto_approve_get(
    Json(params): Json<ConversationAutoApproveParams>,
) -> Result<Json<bool>, AppCommandError> {
    Ok(Json(custom_auto_approve::get_conversation_auto_approve(
        params.conversation_id,
    )))
}

pub async fn conversation_auto_approve_toggle(
    Json(params): Json<ConversationAutoApproveParams>,
) -> Result<Json<bool>, AppCommandError> {
    Ok(Json(custom_auto_approve::toggle_conversation_auto_approve(
        params.conversation_id,
    )))
}
