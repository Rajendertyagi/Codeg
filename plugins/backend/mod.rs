//! Custom Codeg backend plugins, kept outside the upstream crate tree so they
//! survive upstream merges. Mounted from `src-tauri/src/lib.rs` via:
//! `#[path = "../../plugins/backend/mod.rs"] pub mod custom_plugins;`
//!
//! The Tauri command shims are feature-gated: `codeg-server` builds without
//! `tauri-runtime` (see `src-tauri/Cargo.toml`), so nothing in here may depend
//! on the `tauri` crate unconditionally.

pub mod custom_auto_approve;

/// Toggle auto-accept of tool-permission requests for a conversation.
/// Returns the new enabled state.
#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub fn toggle_conversation_auto_approve(conversation_id: i32) -> bool {
    custom_auto_approve::toggle_conversation_auto_approve(conversation_id)
}

/// Read whether a conversation has auto-accept toggled on.
#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub fn get_conversation_auto_approve(conversation_id: i32) -> bool {
    custom_auto_approve::get_conversation_auto_approve(conversation_id)
}
