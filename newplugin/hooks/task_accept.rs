//! Non-git accept for reviewed work tasks (custom plugin).
//!
//! The upstream engine can only land a review through a git merge
//! (`merge_coordinates`, engine.rs:1800-1832). Tasks whose worktree is already
//! gone (crash cleanup) — or that never had one (Local Folder tasks) — dead-end
//! in `review`. This plugin offers the missing terminal transition:
//! `review → done` **without** a merge, for tasks without a worktree.
//!
//! Rules (mirror the engine's own guard style, `merge_landed`):
//! - Guard: only tasks in `review` (the status filter on the UPDATE makes the
//!   guard race-free — a concurrent Return/Requeue bumps `run_seq` and flips
//!   `review` first, so the CAS matches zero rows and the accept refuses).
//! - Guard: only tasks **without** a worktree (`worktree_folder_id IS NULL`).
//!   Tasks that still own a worktree must keep the merge pipeline.
//! - No `result_summary` plumbing: `settle_review` already writes it on review
//!   entry (work_task_service.rs:1038-1040).
//! - No Preflight clearing: the engine's only `done` writer (`merge_landed`)
//!   keeps the snapshot; the frontend hides the chip outside `review`
//!   (task-card.tsx:137).
//!
//! All upstream API used here is public: `get_model` / `record_event`
//! (work_task_service.rs:211 / :103) and `emit_event` + `EventEmitter` +
//! `WorkTaskChange` (web/event_bridge.rs:324-352). The engine's private
//! `status_changed_event` (work_task_service.rs:122) is re-created inline via
//! `record_event` with the same kind/payload shape.

use chrono::Utc;
use sea_orm::sea_query::Expr;
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, TransactionTrait};

use crate::db::entities::work_task::{self, WorkTaskStatus};
use crate::db::service::work_task_service::{self, record_event};
use crate::db::AppDatabase;
use crate::web::event_bridge::{
    emit_event, EventEmitter, WorkTaskChange, WORK_TASK_CHANGED_EVENT,
};

/// Apply the `review → done` transition for a work task with no worktree.
///
/// Returns `Err(String)` with a user-readable reason on any guard violation
/// (not found / not in review / has a worktree) or on a database failure. The
/// transition is a single CAS transaction; on success it writes the timeline
/// event atomically and then broadcasts `task://changed` (Upsert) so the board
/// refreshes exactly as it does after an engine settle.
pub async fn accept_task(
    db: &AppDatabase,
    emitter: &EventEmitter,
    id: i32,
) -> Result<(), String> {
    // Pre-read for friendly errors (get_model errors NotFound on missing or
    // soft-deleted rows — same guard style as the engine's `merge_task`).
    let model = work_task_service::get_model(&db.conn, id)
        .await
        .map_err(|e| format!("accept task {id}: read: {e}"))?;
    if model.status != WorkTaskStatus::Review {
        return Err(format!(
            "work task {id} is not in review (status: {:?}); only reviewed tasks can be accepted",
            model.status
        ));
    }
    if model.worktree_folder_id.is_some() {
        return Err(format!(
            "work task {id} still has a worktree; merge it instead of accepting"
        ));
    }

    let now = Utc::now();
    let txn = db
        .conn
        .begin()
        .await
        .map_err(|e| format!("accept task {id}: begin: {e}"))?;

    // CAS on the status: a concurrent Return/Requeue (engine.rs:406-411) or a
    // racing merge flips `review` first — the filter then matches zero rows and
    // the accept refuses to land. Mirrors merge_landed's update_many shape
    // (work_task_service.rs:1191-1210), minus the git-specific writes.
    let res = work_task::Entity::update_many()
        .col_expr(work_task::Column::Status, Expr::value(WorkTaskStatus::Done))
        .col_expr(work_task::Column::FinishedAt, Expr::value(Some(now)))
        .col_expr(work_task::Column::UpdatedAt, Expr::value(now))
        .filter(work_task::Column::Id.eq(id))
        .filter(work_task::Column::Status.eq(WorkTaskStatus::Review))
        .filter(work_task::Column::DeletedAt.is_null())
        .exec(&txn)
        .await
        .map_err(|e| format!("accept task {id}: update: {e}"))?;
    if res.rows_affected != 1 {
        txn.rollback()
            .await
            .map_err(|e| format!("accept task {id}: rollback: {e}"))?;
        return Err(format!(
            "work task {id} is no longer in review (state changed under the accept)"
        ));
    }

    // Timeline parity with the engine's status_changed_event (same kind and
    // payload shape; actor "user" — the accept is a user decision).
    record_event(
        &txn,
        id,
        "status_changed",
        "user",
        Some(serde_json::json!({ "from": "review", "to": "done" })),
    )
    .await
    .map_err(|e| format!("accept task {id}: event: {e}"))?;

    txn.commit()
        .await
        .map_err(|e| format!("accept task {id}: commit: {e}"))?;

    // Same event the engine's emit_upsert sends (engine.rs:2184-2190); the
    // board and detail sheet refresh off it.
    emit_event(emitter, WORK_TASK_CHANGED_EVENT, WorkTaskChange::Upsert { id });
    tracing::info!("work task {id} accepted (no worktree, no merge)");
    Ok(())
}
