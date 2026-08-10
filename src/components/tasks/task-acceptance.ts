import type { WorkTask } from "@/lib/types"

/**
 * Whether the task's worktree is gone: it ran in one (every generation does),
 * but the worktree was since removed — detached entirely, or its folder /
 * directory no longer exists (`worktree_missing`, stamped by the backend).
 * A merge generation cannot run without the worktree, so a reviewed task in
 * this state completes instead.
 */
export function isWorktreeGone(task: WorkTask): boolean {
  return task.worktree_folder_id == null || task.worktree_missing === true
}

/**
 * Whether the task HAD a worktree that has since been deleted — the card badge
 * predicate, distinct from `isWorktreeGone` in exactly one way: a just-created
 * task that never initialized (no worktree ever minted) is not "removed", it
 * simply hasn't started. `work_branch` is the witness that a worktree once
 * existed: it is recorded together with the worktree and survives the detach
 * that clears the folder pointer.
 */
export function worktreeWasRemoved(task: WorkTask): boolean {
  const hadWorktree =
    task.work_branch != null || task.worktree_folder_id != null
  return hadWorktree && isWorktreeGone(task)
}

/**
 * Whether a reviewed task has no merge to offer, so "complete" takes the
 * primary slot instead:
 * - the run settled with an empty diff against the recorded base — only `0`
 *   counts; `null` means the engine could not read the stats, and merging
 *   stays the safe default there. The engine re-runs the same diff before it
 *   finishes the task, so a stale card cannot drop work;
 * - or the worktree is gone (see `isWorktreeGone`) — a merge could only fail,
 *   and completing is the one acceptance left. The engine preserves a work
 *   branch that still holds unlanded commits.
 */
export function hasNothingToMerge(task: WorkTask): boolean {
  if (task.status !== "review") return false
  return task.files_changed === 0 || isWorktreeGone(task)
}
