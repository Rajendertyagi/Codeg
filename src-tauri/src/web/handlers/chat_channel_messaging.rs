//! HTTP handlers for channel-messaging settings — the web-mode mirror of the
//! Tauri commands in `commands::chat_channel_messaging`.
//!
//! Both endpoints share the same core helpers (`load_channel_messaging_settings`,
//! `set_chat_channel_messaging_settings_core`) so the persist + runtime-config
//! re-apply behavior stays identical across transports.

use std::sync::Arc;

use axum::{extract::Extension, Json};
use serde::Deserialize;

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::commands::chat_channel_messaging::{
    load_channel_messaging_settings, set_chat_channel_messaging_settings_core,
    ChannelMessagingSettings,
};

pub async fn get_chat_channel_messaging_settings(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<ChannelMessagingSettings>, AppCommandError> {
    Ok(Json(load_channel_messaging_settings(&state.db.conn).await))
}

#[derive(Deserialize)]
pub struct SetChannelMessagingSettingsParams {
    pub settings: ChannelMessagingSettings,
}

pub async fn set_chat_channel_messaging_settings(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<SetChannelMessagingSettingsParams>,
) -> Result<Json<ChannelMessagingSettings>, AppCommandError> {
    let saved = set_chat_channel_messaging_settings_core(
        &state.db.conn,
        &state.chat_channel_messaging_config,
        &state.emitter,
        params.settings,
    )
    .await?;
    Ok(Json(saved))
}
