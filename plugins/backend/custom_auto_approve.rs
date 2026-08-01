use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

/// Conversation ids that currently have auto-accept (the shield) toggled on.
/// Kept in-memory for the process lifetime — deliberately not persisted: the
/// toggle is a per-app-run convenience, so a restart always starts with every
/// conversation requiring explicit approval again.
static AUTO_APPROVED: OnceLock<Mutex<HashSet<i32>>> = OnceLock::new();

fn state() -> &'static Mutex<HashSet<i32>> {
    AUTO_APPROVED.get_or_init(|| Mutex::new(HashSet::new()))
}

/// True when `conversation_id` currently has auto-accept enabled. `None`
/// (no conversation attached yet) is never auto-approved.
pub fn is_auto_approved(conversation_id: Option<i32>) -> bool {
    match conversation_id {
        Some(id) => state().lock().map(|set| set.contains(&id)).unwrap_or(false),
        None => false,
    }
}

/// Toggle auto-accept for `conversation_id`; returns the new enabled state.
pub fn toggle_conversation_auto_approve(conversation_id: i32) -> bool {
    let mut set = state().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if set.contains(&conversation_id) {
        set.remove(&conversation_id);
        false
    } else {
        set.insert(conversation_id);
        true
    }
}

/// Read the current auto-accept state for `conversation_id`.
pub fn get_conversation_auto_approve(conversation_id: i32) -> bool {
    state().lock().map(|set| set.contains(&conversation_id)).unwrap_or(false)
}
