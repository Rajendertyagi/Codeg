//! Launch-target decision for "Launch Session" automations: fire into an
//! existing conversation (resuming its external session) or create a fresh one.
//!
//! This is the Layer-2 home of the feature's business rule. The core engine is
//! the adapter: it fetches the pinned row (I/O) and hands the plain view in
//! here, then executes whatever decision this module returns.

/// Plain view of a conversation row, passed in by the core adapter.
#[derive(Debug, Clone)]
pub struct TargetConversationView {
    pub id: i32,
    pub folder_id: i32,
    pub external_id: Option<String>,
}

/// The launch decision for a single run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LaunchTarget {
    /// No pinned conversation: create a fresh disposable conversation.
    Fresh,
    /// Resume the pinned conversation: reuse its row and (when present) its
    /// external session id so per-session env (e.g. OpenClaw's reset flag) and
    /// the spawn dedup behave exactly like the UI / work-task resume paths.
    Resume {
        conversation_id: i32,
        folder_id: i32,
        resume_session_id: Option<String>,
    },
}

/// A pinned target that no longer resolves to a row. The launch must fail fast
/// BEFORE any per-run worktree is minted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VanishedTarget(pub i32);

/// Decide how a launch targets a conversation.
///
/// * `pinned_id` — the automation config's `existing_conversation_id`.
/// * `target` — the row the core adapter resolved for that id, or `None` when
///   nothing was pinned.
///
/// Returns `Err(VanishedTarget)` when a target was pinned but its row is gone:
/// core treats that as a hard, fail-fast launch error.
pub fn decide(
    pinned_id: Option<i32>,
    target: Option<TargetConversationView>,
) -> Result<LaunchTarget, VanishedTarget> {
    match pinned_id {
        Some(id) => match target {
            Some(row) => Ok(LaunchTarget::Resume {
                conversation_id: row.id,
                folder_id: row.folder_id,
                resume_session_id: row.external_id,
            }),
            None => Err(VanishedTarget(id)),
        },
        None => Ok(LaunchTarget::Fresh),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn view(id: i32, folder_id: i32, external_id: Option<&str>) -> TargetConversationView {
        TargetConversationView {
            id,
            folder_id,
            external_id: external_id.map(ToOwned::to_owned),
        }
    }

    #[test]
    fn no_pin_is_fresh() {
        assert_eq!(decide(None, None), Ok(LaunchTarget::Fresh));
        // A stale row without a pin is ignored — nothing was requested.
        assert_eq!(
            decide(None, Some(view(7, 3, Some("ext-7")))),
            Ok(LaunchTarget::Fresh)
        );
    }

    #[test]
    fn pinned_target_resumes_with_row_metadata() {
        let decided = decide(Some(7), Some(view(7, 3, Some("ext-7")))).unwrap();
        assert_eq!(
            decided,
            LaunchTarget::Resume {
                conversation_id: 7,
                folder_id: 3,
                resume_session_id: Some("ext-7".to_string()),
            }
        );
    }

    #[test]
    fn pinned_target_without_external_id_resumes_row_only() {
        let decided = decide(Some(7), Some(view(7, 3, None))).unwrap();
        assert_eq!(
            decided,
            LaunchTarget::Resume {
                conversation_id: 7,
                folder_id: 3,
                resume_session_id: None,
            }
        );
    }

    #[test]
    fn pinned_target_missing_row_fails_fast() {
        assert_eq!(decide(Some(7), None), Err(VanishedTarget(7)));
    }
}
