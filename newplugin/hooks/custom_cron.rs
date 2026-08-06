//! Custom Workflows scheduler (custom hooks).
//!
//! Stores user-defined scheduled prompts in `custom_workflows.json` inside the
//! app data dir (next to the SQLite DB), and runs a background loop that fires
//! each due workflow by injecting the prompt via
//! `ConnectionManager::send_prompt_linked_with_message_id`.
//!
//! The scheduler owns NO approval state: it never enables or disables
//! auto-accept for the target conversation. Tool-permission requests raised
//! while a scheduled prompt runs are governed solely by the GLOBAL auto-accept
//! toggle (`custom_auto_approve`, persisted in `app_metadata`) and, for
//! channel-driven sessions, the existing per-sender `auto_approve` flag —
//! exactly the same rules as any other prompt.
//!
//! The engine is spawned from the Tauri `setup` block (see the `lib.rs` patch);
//! the Tauri command shims that front this storage live in the parent
//! `mod.rs` and are feature-gated so `codeg-server` (no `tauri-runtime`) still
//! compiles.

use std::collections::HashMap;
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::{Mutex, OnceLock};

use chrono::{DateTime, Duration, Utc};
use cron::Schedule;
use sea_orm::EntityTrait;

use crate::acp::manager::ConnectionManager;
use crate::acp::types::PromptInputBlock;
use crate::db::entities::conversation;
use crate::db::AppDatabase;

/// Effective data dir (where the SQLite DB lives), set once at boot. The JSON
/// file is written next to the DB so it survives installs and is writable in
/// production (never the repo "project root").
static DATA_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Serializes read-modify-write cycles on `custom_workflows.json` so the
/// scheduler task, Tauri command shims, and web handlers never interleave file
/// writes. Held only across the synchronous fs section — never across an await.
static STORE_LOCK: Mutex<()> = Mutex::new(());

/// Set the data dir from the Tauri `setup` block before any command runs.
pub fn set_data_dir(dir: &PathBuf) {
    let _ = DATA_DIR.set(dir.clone());
}

fn workflows_path() -> PathBuf {
    DATA_DIR
        .get()
        .map(|d| d.join("custom_workflows.json"))
        .unwrap_or_else(|| PathBuf::from("custom_workflows.json"))
}

/// Outcome of the most recent fire, surfaced in the UI as a status chip and
/// persisted as a lowercase string in `custom_workflows.json`.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum WorkflowStatus {
    /// Created, never fired.
    #[default]
    Idle,
    /// A fire is in progress right now.
    Running,
    /// The last fire injected its prompt successfully.
    Success,
    /// The last fire failed; see `CustomWorkflow::last_error`.
    Failed,
}

/// A single scheduled prompt: fire `prompt` into `conversation_id` on `cron`.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct CustomWorkflow {
    pub id: String,
    /// Display name; empty string renders as "Untitled".
    #[serde(default)]
    pub name: String,
    pub conversation_id: i32,
    pub cron: String,
    pub prompt: String,
    /// Pause flag; disabled workflows are skipped by the scheduler. Only the
    /// dedicated `set_enabled` path flips this, so edits never clobber it.
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    /// RFC 3339 instant of the last successful fire, if any.
    #[serde(default)]
    pub last_run: Option<String>,
    /// Outcome of the most recent fire. Only `fire_workflow` transitions this,
    /// so edits never clobber it.
    #[serde(default)]
    pub last_status: WorkflowStatus,
    /// Human-readable reason for a failed fire; empty unless the last fire
    /// failed. Cleared when a new fire starts and on success.
    #[serde(default)]
    pub last_error: String,
    /// Total fire attempts (scheduler ticks + manual "run now") since the
    /// workflow was created. Bumped when a fire starts, before its outcome is
    /// known, so failed attempts still count as runs.
    #[serde(default)]
    pub run_count: u64,
    /// RFC 3339 instant the workflow was first saved.
    #[serde(default)]
    pub created_at: String,
}

fn default_enabled() -> bool {
    true
}

// ---------------------------------------------------------------------------
// JSON storage layer
// ---------------------------------------------------------------------------

/// Read all workflows from disk. Missing/corrupt file yields an empty list.
pub fn list_workflows() -> Vec<CustomWorkflow> {
    let _guard = STORE_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let path = workflows_path();
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    serde_json::from_str(&text).unwrap_or_default()
}

fn write_workflows(workflows: &[CustomWorkflow]) -> Result<(), String> {
    let _guard = STORE_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let path = workflows_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(workflows).map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| e.to_string())
}

/// Insert or replace a workflow by id. New rows get a `created_at` stamp; edits
/// preserve the pause flag, run clock, and run metadata — only `set_enabled`
/// flips `enabled`, and only the fire path touches `last_run`/`last_status`/
/// `last_error`/`run_count`, so editing a workflow never wipes its history.
pub fn save_workflow(mut workflow: CustomWorkflow) -> Result<(), String> {
    if workflow.created_at.is_empty() {
        workflow.created_at = Utc::now().to_rfc3339();
    }
    let mut all = list_workflows();
    if let Some(existing) = all.iter_mut().find(|w| w.id == workflow.id) {
        workflow.enabled = existing.enabled;
        workflow.last_run = existing.last_run.clone();
        workflow.last_status = existing.last_status.clone();
        workflow.last_error = existing.last_error.clone();
        workflow.run_count = existing.run_count;
        *existing = workflow;
    } else {
        all.push(workflow);
    }
    write_workflows(&all)
}

/// Delete a workflow by id.
pub fn delete_workflow(id: &str) -> Result<(), String> {
    let all = list_workflows();
    let filtered: Vec<_> = all.into_iter().filter(|w| w.id != id).collect();
    write_workflows(&filtered)
}

/// Enable or disable a workflow without touching its schedule or prompt.
pub fn set_enabled(id: &str, enabled: bool) -> Result<(), String> {
    let mut all = list_workflows();
    let Some(wf) = all.iter_mut().find(|w| w.id == id) else {
        return Err(format!("workflow {id} not found"));
    };
    wf.enabled = enabled;
    write_workflows(&all)
}

/// Transition a workflow to `running` and bump its run counter before a fire
/// starts, so a crash mid-fire leaves a visible `running` row (not silence)
/// and the attempt is still counted. Also clears any stale error string.
fn mark_running(id: &str) -> Result<(), String> {
    let mut all = list_workflows();
    if let Some(wf) = all.iter_mut().find(|w| w.id == id) {
        wf.last_status = WorkflowStatus::Running;
        wf.last_error.clear();
        wf.run_count = wf.run_count.saturating_add(1);
    }
    write_workflows(&all)
}

/// Stamp the last successful fire instant and flip the status to `success`.
fn record_success(id: &str, at: DateTime<Utc>) -> Result<(), String> {
    let mut all = list_workflows();
    if let Some(wf) = all.iter_mut().find(|w| w.id == id) {
        wf.last_run = Some(at.to_rfc3339());
        wf.last_status = WorkflowStatus::Success;
        wf.last_error.clear();
    }
    write_workflows(&all)
}

/// Persist the failure reason for a workflow whose fire did not complete.
fn record_failure(id: &str, error: &str) -> Result<(), String> {
    let mut all = list_workflows();
    if let Some(wf) = all.iter_mut().find(|w| w.id == id) {
        wf.last_status = WorkflowStatus::Failed;
        wf.last_error = error.to_string();
    }
    write_workflows(&all)
}

/// Fire a workflow immediately, bypassing its schedule. Returns the target
/// conversation id so callers can surface where the prompt landed.
pub async fn run_now(
    db: &AppDatabase,
    manager: &ConnectionManager,
    id: &str,
) -> Result<i32, String> {
    let wf = list_workflows()
        .into_iter()
        .find(|w| w.id == id)
        .ok_or_else(|| format!("workflow {id} not found"))?;
    // Manual run: no client message id. The manager's connection-scoped
    // fallback (`user-<conn>-<event_seq>`) is unique per event, so a scripted
    // same-millisecond double-fire can never collide (see manager.rs).
    fire_workflow(db, manager, &wf, None).await?;
    Ok(wf.conversation_id)
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/// Long-running scheduler. Holds the DB + connection manager so it can resolve
/// the target connection and inject prompts when a job is due.
pub struct CustomCronEngine {
    db: AppDatabase,
    manager: ConnectionManager,
    /// Last fire instant per workflow id, so each job fires at most once per
    /// occurrence even if the loop is delayed or the process restarts.
    last_fired: Mutex<HashMap<String, DateTime<Utc>>>,
}

impl CustomCronEngine {
    pub fn new(db: AppDatabase, manager: ConnectionManager) -> Self {
        Self {
            db,
            manager,
            last_fired: Mutex::new(HashMap::new()),
        }
    }

    /// Drive the loop forever. Spawn once per process from the Tauri `setup`.
    pub async fn run(self) {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(30));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            interval.tick().await;
            self.tick().await;
        }
    }

    async fn tick(&self) {
        let workflows = list_workflows();
        if workflows.is_empty() {
            return;
        }
        let now = Utc::now();
        let mut due: Vec<(CustomWorkflow, DateTime<Utc>)> = Vec::new();
        {
            let mut last_fired = self.last_fired.lock().unwrap();
            for wf in workflows {
                // Paused workflows stay parked until re-enabled.
                if !wf.enabled {
                    continue;
                }
                // Anchor: the later of the last fire and one interval ago, so a
                // job that came due while the app was closed still fires once on
                // boot.
                let anchor = last_fired
                    .get(&wf.id)
                    .copied()
                    .unwrap_or_else(|| now - Duration::seconds(30));
                let Some(next) = next_run(&wf.cron, anchor) else {
                    continue;
                };
                if next <= now {
                    last_fired.insert(wf.id.clone(), now);
                    due.push((wf, now));
                }
            }
        }
        // Fire after the lock is dropped so the future stays Send.
        for (wf, occurrence) in due {
            self.fire(&wf, occurrence).await;
        }
    }

    /// Fire a workflow (schedule path). Each scheduler fire carries a stable
    /// per-occurrence client message id for traceability; outcome logging and
    /// metadata recording happen inside `fire_workflow`, so the error is
    /// deliberately dropped here.
    async fn fire(&self, wf: &CustomWorkflow, occurrence: DateTime<Utc>) {
        let message_id = Some(fire_message_id(&wf.id, occurrence));
        let _ = fire_workflow(&self.db, &self.manager, wf, message_id).await;
    }
}

/// Stable per-occurrence client message id for scheduler fires. Embeds the
/// workflow id and the fire's occurrence instant so transcripts / events are
/// grep-able per (workflow, occurrence) — the same occurrence instant always
/// maps to the same id, but the scheduler detects each occurrence at most once,
/// so a re-fire after a restart carries a fresh instant and thus a fresh id.
/// The `custom-workflow-` prefix keeps it clear
/// of the parsers' reserved `turn-<digits>` namespace, which the manager
/// rejects for client-supplied message ids (see `manager::is_reserved_turn_id`).
fn fire_message_id(wf_id: &str, occurrence: DateTime<Utc>) -> String {
    format!("custom-workflow-{wf_id}-{}", occurrence.timestamp_millis())
}

/// Shared fire path for the scheduler and manual run-now: marks the workflow
/// `running` (and counts the attempt), runs the injection, then persists the
/// outcome — success stamps `last_run`, failure records `last_error`. Logs one
/// line per fire so the scheduler loop does not double-log. Returns a
/// human-readable error when nothing fired.
async fn fire_workflow(
    db: &AppDatabase,
    manager: &ConnectionManager,
    wf: &CustomWorkflow,
    client_message_id: Option<String>,
) -> Result<(), String> {
    // 0. Transition to `running` and count the attempt *before* awaiting, so a
    //    crash mid-fire leaves a visible `running` row (not silence) and the
    //    attempt is still counted.
    if let Err(e) = mark_running(&wf.id) {
        return Err(format!("failed to mark workflow {} running: {e}", wf.id));
    }

    // 1-4. The actual fire.
    let outcome = fire_workflow_inner(db, manager, wf, client_message_id).await;

    // 5. Persist the outcome; a metadata write failure is logged but never
    //    hides the fire's own result.
    match &outcome {
        Ok(()) => {
            if let Err(e) = record_success(&wf.id, Utc::now()) {
                tracing::warn!("[custom_cron] could not record success for {}: {e}", wf.id);
            }
            tracing::info!(
                "[custom_cron] fired workflow {} into conversation {}",
                wf.id,
                wf.conversation_id
            );
        }
        Err(e) => {
            if let Err(we) = record_failure(&wf.id, e) {
                tracing::warn!("[custom_cron] could not record failure for {}: {we}", wf.id);
            }
            tracing::warn!("[custom_cron] workflow {} failed: {e}", wf.id);
        }
    }
    outcome
}

/// The actual fire: resolve the target conversation + live connection, and
/// inject the prompt (with the caller's client message id, if any). Split from
/// `fire_workflow` so the outcome recording above wraps every exit path.
///
/// Approval during the run is deliberately NOT touched here: the scheduler must
/// not own approval state. Permission requests raised by the injected prompt
/// follow the global auto-accept toggle (and the per-sender channel flag for
/// channel-driven sessions) like any other prompt.
async fn fire_workflow_inner(
    db: &AppDatabase,
    manager: &ConnectionManager,
    wf: &CustomWorkflow,
    client_message_id: Option<String>,
) -> Result<(), String> {
    // 1. Resolve the conversation's folder (required for a linked prompt).
    let folder_id = match conversation::Entity::find_by_id(wf.conversation_id)
        .one(&db.conn)
        .await
    {
        Ok(Some(row)) => row.folder_id,
        Ok(None) => return Err(format!("conversation {} not found", wf.conversation_id)),
        Err(e) => {
            return Err(format!(
                "conversation {} lookup failed: {e}",
                wf.conversation_id
            ))
        }
    };

    // 2. Resolve the live connection bound to that conversation.
    let Some(conn_id) = manager
        .find_connection_by_conversation_id(wf.conversation_id)
        .await
    else {
        return Err(format!(
            "no live connection for conversation {}",
            wf.conversation_id
        ));
    };

    // 3. Inject the prompt into the conversation.
    let blocks = vec![PromptInputBlock::Text {
        text: wf.prompt.clone(),
    }];
    manager
        .send_prompt_linked_with_message_id(
            db,
            &conn_id,
            blocks,
            Some(folder_id),
            Some(wf.conversation_id),
            None,
            client_message_id,
        )
        .await
        .map_err(|e| format!("prompt injection failed: {e}"))?;

    Ok(())
}

/// Next fire instant (UTC) of a cron expression strictly after `after`.
fn next_run(cron_expr: &str, after: DateTime<Utc>) -> Option<DateTime<Utc>> {
    let schedule = Schedule::from_str(cron_expr).ok()?;
    schedule.after(&after).next()
}