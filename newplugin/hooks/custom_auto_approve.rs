use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use crate::custom_hooks::AutoApproveConversationResult;
use crate::db::service::app_metadata_service;
use crate::db::AppDatabase;

/// `app_metadata` key backing the GLOBAL auto-accept toggle. Values are the
/// strings `"true"` / `"false"`; absent (or unparseable) means OFF.
///
/// This is intentionally app-scoped and persisted: it rides the same global
/// key-value store as `web_service_token`, channel language/prefix and
/// `chat_event_webhooks`, so it survives restarts without introducing a new
/// table, entity, or migration — and it is deliberately NOT keyed by
/// conversation, folder, or sender, so no surface (desktop chat, folder
/// sessions, Telegram/Lark/Weixin relays) can bypass it.
const AUTO_APPROVE_KEY: &str = "auto_approve_global";

/// Process-lifetime cache of the persisted flag. `None` = not loaded yet
/// (fail-closed: the gate treats it as OFF until the first load/toggle).
/// A cache is used instead of a DB read on the hot gate path so
/// `handle_permission_request` never performs I/O per permission request.
static AUTO_APPROVE_GLOBAL: OnceLock<Mutex<Option<bool>>> = OnceLock::new();

fn state() -> &'static Mutex<Option<bool>> {
    AUTO_APPROVE_GLOBAL.get_or_init(|| Mutex::new(None))
}

/// Small error type for the vendor shim. Keep it simple so callers can map to UI.
#[derive(thiserror::Error, Debug)]
pub enum AutoApproveError {
    #[error("not_found")]
    NotFound,
    #[error("permission_denied")]
    PermissionDenied,
    #[error("internal: {0}")]
    Internal(String),
}

fn map_db_error(e: impl std::fmt::Display) -> AutoApproveError {
    AutoApproveError::Internal(e.to_string())
}

/// Synchronous read of the cached global flag. `None` (not yet loaded from
/// `app_metadata`) is treated as OFF — the safe default.
pub fn is_auto_approved_sync() -> bool {
    state()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .unwrap_or(false)
}

/// Async wrapper for `is_auto_approved_sync`. Lock is brief; computed directly
/// without blocking threads. This is the single decision the permission-request
/// gate consults — no conversation/folder/sender context.
pub async fn is_auto_approved() -> Result<bool, AutoApproveError> {
    Ok(is_auto_approved_sync())
}

/// Load the persisted global flag from `app_metadata` into the in-process cache.
/// Idempotent and safe to call from multiple startup points (Tauri `setup` and
/// the web handlers); a cache already set by an earlier toggle is never
/// clobbered. Errors are logged and degrade to OFF (fail-closed).
pub async fn init_global_auto_approve(db: &AppDatabase) -> Result<(), AutoApproveError> {
    {
        let cached = state()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if cached.is_some() {
            return Ok(());
        }
    }

    let value = app_metadata_service::get_value(&db.conn, AUTO_APPROVE_KEY)
        .await
        .map_err(map_db_error)?;

    let enabled = value.as_deref() == Some("true");
    tracing::info!("[auto_approve] loaded global flag from app_metadata: {enabled}");
    *state()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(enabled);
    Ok(())
}

/// Read the current GLOBAL auto-accept state, loading from `app_metadata` first
/// if this process has not loaded it yet (covers `codeg-server` headless mode,
/// which has no Tauri `setup` block).
pub async fn get_global_auto_approve(db: &AppDatabase) -> Result<bool, AutoApproveError> {
    init_global_auto_approve(db).await?;
    Ok(is_auto_approved_sync())
}

/// Persist the flag to `app_metadata` and refresh the in-process cache. The
/// ONLY writer of the global flag — the custom-workflow scheduler no longer
/// touches approval state at all (see `custom_cron.rs`).
async fn set_global_auto_approve(
    db: &AppDatabase,
    enabled: bool,
) -> Result<bool, AutoApproveError> {
    app_metadata_service::upsert_value(&db.conn, AUTO_APPROVE_KEY, if enabled { "true" } else { "false" })
        .await
        .map_err(map_db_error)?;
    *state()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(enabled);
    tracing::info!("[auto_approve] global toggle persisted: {enabled}");
    Ok(enabled)
}

/// Flip the GLOBAL auto-accept toggle; returns the new enabled state.
pub async fn toggle_global_auto_approve(db: &AppDatabase) -> Result<bool, AutoApproveError> {
    let current = get_global_auto_approve(db).await?;
    set_global_auto_approve(db, !current).await
}

/// Shared GLOBAL-toggle orchestration used by BOTH the Tauri command and the
/// HTTP handler (thin wrappers): flip + persist (existing
/// `toggle_global_auto_approve`), then reconcile ALL parked cards when the
/// switch transitions to ON.
pub async fn toggle_global_auto_approve_core(
    db: &AppDatabase,
    manager: &crate::acp::manager::ConnectionManager,
) -> Result<bool, AutoApproveError> {
    let enabled = toggle_global_auto_approve(db).await?;
    if enabled {
        manager.reconcile_auto_approve(None).await;
    }
    Ok(enabled)
}

/// Per-chat auto-accept overrides. IN-MEMORY ONLY (process lifetime) — the
/// explicit design decision: unlike the global flag (persisted in
/// `app_metadata`), per-chat state is a runtime convenience and is never
/// written to the database.
///
/// A present entry is ALWAYS `true` (explicit ON). Turning a conversation off
/// REMOVES the entry so it inherits the global flag again — "off" means
/// "auto", and the per-chat switch never fights the global master. This keeps
/// the map to a single stored state and preserves the
/// explicit-override-vs-inherited distinction for future tri-state UI.
static PER_CHAT: OnceLock<Mutex<HashMap<String, bool>>> = OnceLock::new();

fn per_chat_state() -> &'static Mutex<HashMap<String, bool>> {
    PER_CHAT.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Raw storage accessor: the explicit per-chat override, if any. `Some(true)`
/// = explicit ON; `None` = no override for this conversation (inherit global).
/// Storage read only — no fallback, no decision logic; see
/// `is_auto_approved_for`.
pub fn get_per_chat_auto_approve(conversation_id: &str) -> Option<bool> {
    per_chat_state()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(conversation_id)
        .copied()
}

/// Storage writer. Explicit ON inserts `true`; disabled REMOVES the entry so
/// the conversation inherits the global flag (never stores explicit `false`).
pub async fn set_per_chat_auto_approve(conversation_id: &str, enabled: bool) {
    let mut map = per_chat_state().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if enabled {
        map.insert(conversation_id.to_string(), true);
    } else {
        map.remove(conversation_id);
    }
}

/// THE single effective-state resolver: explicit per-chat override wins,
/// otherwise fall back to the GLOBAL flag. Every consumer (gate, per-chat
/// read, per-chat toggle, reconcile) consults this — no parallel decision
/// paths.
pub async fn is_auto_approved_for(conversation_id: &str) -> bool {
    get_per_chat_auto_approve(conversation_id).unwrap_or_else(is_auto_approved_sync)
}

/// Effective state + raw override for a conversation (the response both the
/// Tauri command and the HTTP handler return). `override_state` lets the UI
/// distinguish an explicit per-chat ON from an inherited global state.
pub async fn get_per_chat_auto_approve_result(
    conversation_id: i32,
) -> AutoApproveConversationResult {
    let key = conversation_id.to_string();
    AutoApproveConversationResult {
        enabled: is_auto_approved_for(&key).await,
        override_state: get_per_chat_auto_approve(&key),
    }
}

/// Shared PER-CHAT toggle orchestration used by BOTH the Tauri command and the
/// HTTP handler (thin wrappers). Flips the RAW override — present -> remove
/// (inherit), absent -> explicit ON — never the effective state, so the toggle
/// can't fight the global master. Reconciles parked cards only on an
/// effective OFF -> ON transition. In-memory only.
pub async fn toggle_per_chat_auto_approve_core(
    manager: &crate::acp::manager::ConnectionManager,
    conversation_id: i32,
) -> Result<AutoApproveConversationResult, AutoApproveError> {
    let key = conversation_id.to_string();
    let was_enabled = is_auto_approved_for(&key).await;
    let has_override = get_per_chat_auto_approve(&key).is_some();
    set_per_chat_auto_approve(&key, !has_override).await;
    let enabled = is_auto_approved_for(&key).await;
    if enabled && !was_enabled {
        manager.reconcile_auto_approve(Some(conversation_id)).await;
    }
    Ok(AutoApproveConversationResult {
        enabled,
        override_state: get_per_chat_auto_approve(&key),
    })
}
