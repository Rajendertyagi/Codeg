import {
  Archive,
  ArchiveRestore,
  Ban,
  CalendarClock,
  Check,
  CircleCheck,
  GitMerge,
  MessageSquareText,
  Pencil,
  Play,
  RotateCw,
  type LucideIcon,
} from "lucide-react"
import { hasNothingToMerge } from "./task-acceptance"
import type { WorkTask } from "@/lib/types"

export interface TaskActionItem {
  icon: LucideIcon
  label: string
  onClick: () => void
}

/** The per-task callbacks a card or list row wires its actions to. */
export interface TaskActionHandlers {
  onStart: () => void
  onCancel: () => void
  onRetry: () => void
  onRequeue: () => void
  /** Opens the read-only live session viewer (TaskTranscriptDialog). */
  onViewSession: () => void
  onMerge: () => void
  /** Takes the merge slot when the task changed nothing (see
   *  `hasNothingToMerge`) — accepts it outright instead. */
  onComplete: () => void
  /** Our custom feature: accepts the task outright when it has no worktree to merge. */
  onAccept: () => void
  /** Toggles by `task.archived_at` (archive ⇄ unarchive). */
  onArchive: () => void
  /** Opens the editor dialog — offered while editable (todo / failed). */
  onEdit: () => void
  /** Opens the schedule dialog — to-do tasks only (plan / re-plan / clear). */
  onSchedule: () => void
}

type ActionLabelKey =
  | "actionAccept"
  | "actionStart"
  | "actionCancel"
  | "actionRetry"
  | "actionRequeue"
  | "actionViewSession"
  | "actionMerge"
  | "actionComplete"
  | "actionArchive"
  | "actionUnarchive"
  | "actionEdit"
  | "actionSchedule"

/**
 * The action set a task offers, shared by the board card and the list row so
 * the two can never drift: exactly one filled primary per status on the left,
 * and the secondaries (edit / archive) on the right, always ending in "查看会话"
 * when a session exists. The full set — with labels — lives in the detail
 * sheet. `merging` has no primary: it cannot be canceled.
 */
export function buildTaskActions(
  task: WorkTask,
  t: (key: ActionLabelKey) => string,
  handlers: TaskActionHandlers
): { primary: TaskActionItem | null; secondaries: TaskActionItem[] } {
  const secondaries: TaskActionItem[] = []
  let primary: TaskActionItem | null = null
  // An archived task offers exactly one way back — and still the session
  // viewer appended below, which is what archiving is usually for.
  if (task.archived_at != null) {
    primary = {
      icon: ArchiveRestore,
      label: t("actionUnarchive"),
      onClick: handlers.onArchive,
    }
  } else {
    switch (task.status) {
      case "todo":
        primary = {
          icon: Play,
          label: t("actionStart"),
          onClick: handlers.onStart,
        }
        secondaries.push({
          icon: Pencil,
          label: t("actionEdit"),
          onClick: handlers.onEdit,
        })
        // "Start" and "start later" are the same decision — the plan lives
        // next to the button that skips it.
        secondaries.push({
          icon: CalendarClock,
          label: t("actionSchedule"),
          onClick: handlers.onSchedule,
        })
        break
      case "queued":
      case "preparing":
      case "running":
      case "awaiting_input":
        primary = {
          icon: Ban,
          label: t("actionCancel"),
          onClick: handlers.onCancel,
        }
        break
      case "review":
        // Our custom feature: a task with no worktree has nothing to merge — accept
        // it outright. Otherwise defer to the upstream diff-based split (nothing
        // changed ⟹ complete, else merge).
        primary =
          task.worktree_folder_id == null
            ? {
                icon: Check,
                label: t("actionAccept"),
                onClick: handlers.onAccept,
              }
            : hasNothingToMerge(task)
              ? {
                  icon: CircleCheck,
                  label: t("actionComplete"),
                  onClick: handlers.onComplete,
                }
              : {
                  icon: GitMerge,
                  label: t("actionMerge"),
                  onClick: handlers.onMerge,
                }
        break
      case "merging":
        break
      case "failed":
        primary = {
          icon: RotateCw,
          label: t("actionRetry"),
          onClick: handlers.onRetry,
        }
        secondaries.push({
          icon: Pencil,
          label: t("actionEdit"),
          onClick: handlers.onEdit,
        })
        secondaries.push({
          icon: Archive,
          label: t("actionArchive"),
          onClick: handlers.onArchive,
        })
        break
      case "done":
        primary = {
          icon: Archive,
          label: t("actionArchive"),
          onClick: handlers.onArchive,
        }
        break
      case "canceled":
        primary = {
          icon: RotateCw,
          label: t("actionRequeue"),
          onClick: handlers.onRequeue,
        }
        secondaries.push({
          icon: Archive,
          label: t("actionArchive"),
          onClick: handlers.onArchive,
        })
        break
    }
  }
  // The session viewer is offered in every status once a session exists (live
  // ones stream it in real time) and always sorts last, anchoring the corner.
  if (task.conversation_id != null) {
    secondaries.push({
      icon: MessageSquareText,
      label: t("actionViewSession"),
      onClick: handlers.onViewSession,
    })
  }
  return { primary, secondaries }
}
