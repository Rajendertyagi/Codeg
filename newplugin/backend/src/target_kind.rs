//! Target-root decision for automations: run against a codeg Git workspace
//! (the original behavior) or against a plain local folder on disk (no git).
//!
//! This is the Layer-2 home of the feature's business rule. The core engine is
//! the adapter: it hands in the two optional selectors (workspace id, local
//! path) and executes whatever working-root decision this module returns.

/// Where a run's working directory comes from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TargetKind {
    /// A codeg folder record (`root_folder_id`): the worktree/checkout machinery
    /// resolves the working directory from repo state. The legacy behavior.
    GitWorkspace,
    /// A plain absolute folder path on disk, used as-is with no git involvement.
    LocalFolder {
        working_dir: String,
    },
}

/// Why a target-root decision failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TargetError {
    /// Neither a workspace folder nor a local path was configured.
    NoTarget,
    /// Both were configured — the launch would be ambiguous.
    Ambiguous,
    /// The configured local path is empty or whitespace.
    EmptyLocalFolder,
}

/// Decide how a run resolves its working root.
///
/// * `root_folder_id` — the automation's workspace folder (NULL for a
///   local-folder automation).
/// * `local_folder_path` — the automation config's plain path, or `None` when
///   targeting a workspace.
///
/// Fails fast (`Err`) instead of guessing whenever the stored selectors are
/// missing or contradictory: a run must never silently fall back to the other
/// mode, because that would execute in the wrong directory.
pub fn decide(
    root_folder_id: Option<i32>,
    local_folder_path: Option<&str>,
) -> Result<TargetKind, TargetError> {
    match (root_folder_id, local_folder_path) {
        (Some(_), None) => Ok(TargetKind::GitWorkspace),
        (Some(_), Some(_)) => Err(TargetError::Ambiguous),
        (None, Some(path)) if !path.trim().is_empty() => Ok(TargetKind::LocalFolder {
            working_dir: path.to_owned(),
        }),
        (None, Some(_)) => Err(TargetError::EmptyLocalFolder),
        (None, None) => Err(TargetError::NoTarget),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_only_is_git_workspace() {
        assert_eq!(decide(Some(4), None), Ok(TargetKind::GitWorkspace));
    }

    #[test]
    fn local_path_only_is_local_folder() {
        assert_eq!(
            decide(None, Some("D:/code/project")),
            Ok(TargetKind::LocalFolder {
                working_dir: "D:/code/project".to_string(),
            })
        );
    }

    #[test]
    fn both_selectors_reject_ambiguous() {
        assert_eq!(
            decide(Some(4), Some("D:/code/project")),
            Err(TargetError::Ambiguous)
        );
    }

    #[test]
    fn empty_local_path_rejected() {
        assert_eq!(decide(None, Some("")), Err(TargetError::EmptyLocalFolder));
        assert_eq!(
            decide(None, Some("   ")),
            Err(TargetError::EmptyLocalFolder)
        );
    }

    #[test]
    fn no_selector_rejected() {
        assert_eq!(decide(None, None), Err(TargetError::NoTarget));
    }
}
