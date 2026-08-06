"use client"

import {
  Fragment,
  useEffect,
  useMemo,
  useState,
  type ComponentType,
  type ReactNode,
} from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  ListFilter,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  Power,
  PowerOff,
  Trash2,
  Workflow,
} from "lucide-react"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"
import {
  deleteCustomWorkflow,
  listCustomWorkflows,
  runCustomWorkflowNow,
  saveCustomWorkflow,
  setCustomWorkflowEnabled,
  type CustomWorkflow,
  type WorkflowStatus,
} from "@/lib/api"
import { AutomationEditor, type WorkflowDraft } from "./automation-editor"
import { cn } from "@/lib/utils"

/**
 * Custom Workflows (custom hooks). Backed by the `custom_cron` scheduler:
 * workflows are persisted to `custom_workflows.json` and fired on their cron
 * schedule by the Rust engine. Unlike the native Automations feature, each
 * workflow always targets one fixed chat thread (the conversation picked in
 * the editor) — that is the core capability this module adds.
 *
 * The UI deliberately clones the native Automations master–detail layout, and
 * the detail pane hosts a verbatim copy of the native Automations editor
 * (folder target swapped for the target-chat conversation picker), so the two
 * features look and behave identically.
 */

type StatusFilter = "all" | "enabled" | "disabled"

// Compact, i18n-free relative time ("now"/"5m"/"2h"/"3d"/"2mo"/"1y"), matching
// the Automations page's style. Absolute time rides in the title attr.
function formatRelative(iso: string | null, now: number): string {
  if (!iso) return "—"
  const ts = Date.parse(iso)
  if (Number.isNaN(ts)) return "—"
  const sec = Math.max(0, Math.round((now - ts) / 1000))
  if (sec < 45) return "now"
  const min = Math.round(sec / 60)
  if (min < 60) return `${min}m`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}h`
  const day = Math.round(hr / 24)
  if (day < 30) return `${day}d`
  const mo = Math.round(day / 30)
  if (mo < 12) return `${mo}mo`
  return `${Math.round(mo / 12)}y`
}

// Run-status badge tone per `last_status` value the Rust engine writes.
// Unknown values degrade to the neutral "idle" style, mirroring the native
// Automations `STATUS_STYLES` map.
const WORKFLOW_STATUS_BADGE: Record<string, string> = {
  idle: "bg-muted text-muted-foreground",
  running: "bg-primary/10 text-primary",
  success: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  failed: "bg-destructive/10 text-destructive",
}

function WorkflowStatusChip({ status }: { status: WorkflowStatus | null }) {
  const t = useTranslations("CustomWorkflows")
  if (!status) return null
  const label =
    {
      idle: t("statusIdle"),
      running: t("statusRunning"),
      success: t("statusSuccess"),
      failed: t("statusFailed"),
    }[status] ?? t("statusIdle")
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center rounded-full px-2 text-[0.6875rem] font-medium",
        WORKFLOW_STATUS_BADGE[status] ?? "bg-muted text-muted-foreground"
      )}
    >
      {label}
    </span>
  )
}

export function CustomWorkflowsPage() {
  const t = useTranslations("CustomWorkflows")
  const [workflows, setWorkflows] = useState<CustomWorkflow[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all")
  const [busy, setBusy] = useState(false)
  // Frozen at mount — the page remounts on each route entry, so relative
  // labels ("5m") are anchored to when Custom Workflows was opened.
  const [now] = useState(() => Date.now())

  useEffect(() => {
    let cancelled = false
    listCustomWorkflows()
      .then((rows) => {
        if (!cancelled) setWorkflows(rows)
      })
      .catch(() => {
        /* backend unavailable; keep empty list */
      })
    return () => {
      cancelled = true
    }
  }, [])

  const refetch = async () => {
    const rows = await listCustomWorkflows()
    setWorkflows(rows)
  }

  // The shown workflow: the explicit selection, else null so the detail pane
  // hosts the "create" form. Derived (no effect) so a deleted selection cleanly
  // falls back to the create form instead of dangling.
  const current = workflows.find((w) => w.id === selectedId) ?? null

  const visibleWorkflows = useMemo(
    () =>
      workflows.filter(
        (w) =>
          statusFilter === "all" ||
          (statusFilter === "enabled" ? w.enabled : !w.enabled)
      ),
    [workflows, statusFilter]
  )

  // Shared mutation runner for quick actions (run now / toggle / delete),
  // hoisted so the list rows and the detail pane drive the same path.
  const runAction = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await fn()
      await refetch()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const handleSave = async (draft: WorkflowDraft) => {
    if (current) {
      await saveCustomWorkflow({ ...current, ...draft })
      toast.success(t("saved"))
      await refetch()
      return
    }
    const created: CustomWorkflow = {
      id: crypto.randomUUID(),
      name: draft.name,
      conversation_id: draft.conversation_id,
      cron: draft.cron,
      prompt: draft.prompt,
      enabled: true,
      last_run: null,
      last_status: "idle",
      last_error: "",
      run_count: 0,
      created_at: "",
    }
    await saveCustomWorkflow(created)
    toast.success(t("saved"))
    await refetch()
    setSelectedId(created.id)
  }

  const handleDeleteCurrent = () => {
    if (!current) return
    void runAction(async () => {
      await deleteCustomWorkflow(current.id)
      toast.success(t("deleted"))
      setSelectedId(null)
    })
  }

  const handleRunNow = () => {
    if (!current) return
    void runAction(async () => {
      await runCustomWorkflowNow(current.id)
      toast.success(t("ranNow"))
    })
  }

  const handleToggleEnabled = (enabled: boolean) => {
    if (!current) return
    void runAction(() => setCustomWorkflowEnabled(current.id, enabled))
  }

  const deleteRow = (workflow: CustomWorkflow) =>
    runAction(async () => {
      await deleteCustomWorkflow(workflow.id)
      toast.success(t("deleted"))
      if (selectedId === workflow.id) {
        setSelectedId(null)
      }
    })

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <ResizablePanelGroup direction="horizontal" className="min-h-0 flex-1">
        <ResizablePanel
          id="custom-workflows-list"
          order={1}
          defaultSize={32}
          minSize={22}
        >
          <div className="@container flex h-full flex-col">
            <PageHeader onNew={() => setSelectedId(null)} />
            <ListFilters
              statusFilter={statusFilter}
              onStatusFilter={setStatusFilter}
            />
            <ScrollArea className="min-h-0 flex-1">
              {visibleWorkflows.length === 0 ? (
                <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                  {workflows.length === 0 ? t("noWorkflows") : t("noMatches")}
                </p>
              ) : (
                <ul className="flex flex-col gap-0.5 p-1.5">
                  {visibleWorkflows.map((w) => (
                    <WorkflowListItem
                      key={w.id}
                      workflow={w}
                      now={now}
                      selected={current?.id === w.id}
                      onSelect={() => setSelectedId(w.id)}
                      onRunNow={() =>
                        void runAction(() => runCustomWorkflowNow(w.id))
                      }
                      onToggleEnabled={() =>
                        void runAction(() =>
                          setCustomWorkflowEnabled(w.id, !w.enabled)
                        )
                      }
                      onDelete={() => void deleteRow(w)}
                    />
                  ))}
                </ul>
              )}
            </ScrollArea>
          </div>
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel id="custom-workflows-detail" order={2} defaultSize={68}>
          <WorkflowForm
            // Key by the edit target so switching workflows (or clearing the
            // selection) remounts with fresh field state.
            key={current ? `edit-${current.id}` : "create"}
            workflow={current}
            busy={busy}
            onboarding={workflows.length === 0}
            onSave={handleSave}
            onDelete={handleDeleteCurrent}
            onRunNow={handleRunNow}
            onToggleEnabled={handleToggleEnabled}
            onCancel={() => setSelectedId(null)}
          />
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  )
}

function PageHeader({ onNew }: { onNew: () => void }) {
  const t = useTranslations("CustomWorkflows")
  return (
    <header className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-border pl-3.5 pr-2.5">
      <div className="flex min-w-0 items-center gap-2">
        <Workflow
          className="size-4 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <h1 className="truncate text-sm font-semibold">{t("title")}</h1>
      </div>
      <Button size="sm" onClick={onNew} aria-label={t("new")} title={t("new")}>
        <Plus className="h-3.5 w-3.5" aria-hidden="true" />
        {/* Collapses to a "+"-only button when the pane is too narrow for both
            the title and the labeled button (the @container is the list pane). */}
        <span className="hidden @[16rem]:inline">{t("new")}</span>
      </Button>
    </header>
  )
}

// Enabled-state filter above the list, mirroring the Automations page's
// filter bar (workflows have no folder dimension — the target is the
// conversation, which lives in the detail pane).
function ListFilters({
  statusFilter,
  onStatusFilter,
}: {
  statusFilter: StatusFilter
  onStatusFilter: (v: StatusFilter) => void
}) {
  const t = useTranslations("CustomWorkflows")
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border px-2 py-1.5">
      <Select
        value={statusFilter}
        onValueChange={(v) => onStatusFilter(v as StatusFilter)}
      >
        <SelectTrigger size="sm" className="h-7 w-auto gap-1.5 text-xs">
          <ListFilter
            className="size-3.5 text-muted-foreground"
            aria-hidden="true"
          />
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{t("filterAll")}</SelectItem>
          <SelectItem value="enabled">{t("filterEnabled")}</SelectItem>
          <SelectItem value="disabled">{t("filterDisabled")}</SelectItem>
        </SelectContent>
      </Select>
    </div>
  )
}

// Status dot: muted when the workflow is paused; otherwise tinted by the last
// run — emerald for "ready"/success, amber while a fire is in flight, red
// after a failure. Mirrors the Automations row idiom with our `last_status`
// vocabulary (idle/running/success/failed).
const WORKFLOW_STATUS_DOT: Record<string, string> = {
  running: "bg-amber-500",
  success: "bg-emerald-500",
  failed: "bg-destructive",
  idle: "bg-emerald-500",
}

function WorkflowDot({
  enabled,
  status,
}: {
  enabled: boolean
  status: WorkflowStatus | null
}) {
  const color = !enabled
    ? "bg-muted-foreground/40"
    : status
      ? (WORKFLOW_STATUS_DOT[status] ?? "bg-emerald-500")
      : "bg-emerald-500"
  return (
    <span
      className={cn(
        "block size-1.5 rounded-full ring-2 ring-background",
        color
      )}
      aria-hidden="true"
    />
  )
}

function WorkflowListItem({
  workflow,
  now,
  selected,
  onSelect,
  onRunNow,
  onToggleEnabled,
  onDelete,
}: {
  workflow: CustomWorkflow
  now: number
  selected: boolean
  onSelect: () => void
  onRunNow: () => void
  onToggleEnabled: () => void
  onDelete: () => void
}) {
  const t = useTranslations("CustomWorkflows")
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const timeLabel = workflow.last_run
    ? formatRelative(workflow.last_run, now)
    : null

  // The row's quick actions, authored once so the ⋯ dropdown and the
  // right-click context menu render exactly the same set (parity with
  // Automations).
  const actions: Array<{
    key: string
    icon: ReactNode
    label: string
    onSelect: () => void
    variant?: "destructive"
    separatorBefore?: boolean
  }> = [
    {
      key: "run",
      icon: <Play className="size-3.5" aria-hidden="true" />,
      label: t("runNow"),
      onSelect: onRunNow,
    },
    {
      key: "toggle",
      icon: workflow.enabled ? (
        <PowerOff className="size-3.5" aria-hidden="true" />
      ) : (
        <Power className="size-3.5" aria-hidden="true" />
      ),
      label: workflow.enabled ? t("disable") : t("enable"),
      onSelect: onToggleEnabled,
    },
    {
      key: "edit",
      icon: <Pencil className="size-3.5" aria-hidden="true" />,
      label: t("edit"),
      onSelect: onSelect,
    },
    {
      key: "delete",
      icon: <Trash2 className="size-3.5" aria-hidden="true" />,
      label: t("delete"),
      // Let the menu close (and restore focus) before the dialog mounts —
      // opening synchronously races focus restoration and self-dismisses.
      onSelect: () => setTimeout(() => setConfirmOpen(true), 0),
      variant: "destructive",
      separatorBefore: true,
    },
  ]

  // Render the shared actions into either menu's item/separator components.
  const renderActions = (
    Item: ComponentType<{
      variant?: "destructive"
      onSelect?: () => void
      children?: ReactNode
    }>,
    Separator: ComponentType
  ) =>
    actions.map((a) => (
      <Fragment key={a.key}>
        {a.separatorBefore ? <Separator /> : null}
        <Item variant={a.variant} onSelect={a.onSelect}>
          {a.icon}
          {a.label}
        </Item>
      </Fragment>
    ))

  return (
    <li>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            className={cn(
              "group flex h-8 w-full items-center rounded-full pr-1 transition-colors",
              selected ? "bg-accent" : "hover:bg-accent/60"
            )}
          >
            <button
              type="button"
              onClick={onSelect}
              className="flex h-full min-w-0 flex-1 items-center gap-2.5 rounded-full pl-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            >
              <span className="relative flex size-5 shrink-0 items-center justify-center">
                <span className="flex size-4 items-center justify-center rounded-md bg-muted text-muted-foreground">
                  <Workflow className="size-3" aria-hidden="true" />
                </span>
                <span className="absolute -right-0.5 -bottom-0.5">
                  <WorkflowDot
                    enabled={workflow.enabled}
                    status={workflow.last_status}
                  />
                </span>
              </span>
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-sm",
                  workflow.enabled
                    ? "font-medium"
                    : "font-normal text-muted-foreground"
                )}
              >
                {workflow.name || t("untitled")}
              </span>
            </button>

            <div className="flex shrink-0 items-center gap-0.5 pl-1">
              {/* Time yields to the ⋯ affordance on hover, keyboard focus, or
                  while the menu is open — mirroring the conversation row. */}
              <span
                className={cn(
                  "flex items-center group-hover:hidden group-focus-within:hidden",
                  menuOpen && "hidden"
                )}
              >
                {timeLabel ? (
                  <span
                    className={cn(
                      "shrink-0 tabular-nums text-[0.71875rem]",
                      selected
                        ? "font-medium text-muted-foreground"
                        : "text-muted-foreground/70"
                    )}
                    title={
                      workflow.last_run
                        ? new Date(workflow.last_run).toLocaleString()
                        : undefined
                    }
                  >
                    {timeLabel}
                  </span>
                ) : null}
              </span>

              <DropdownMenu onOpenChange={setMenuOpen}>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="hidden justify-end text-muted-foreground/80 hover:bg-transparent hover:text-foreground group-hover:flex group-focus-within:flex aria-expanded:bg-transparent data-[state=open]:flex dark:hover:bg-transparent"
                    aria-label={t("moreActions")}
                  >
                    <MoreHorizontal className="size-4" aria-hidden="true" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-40">
                  {renderActions(DropdownMenuItem, DropdownMenuSeparator)}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </ContextMenuTrigger>
        {/* Right-click anywhere on the row opens the same actions as ⋯. */}
        <ContextMenuContent className="w-40">
          {renderActions(ContextMenuItem, ContextMenuSeparator)}
        </ContextMenuContent>
      </ContextMenu>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("deleteDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={onDelete}>
              {t("delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  )
}

// The detail pane: hosts the copied native Automations editor for both create
// ("workflow" null) and edit, plus the edit-mode header (run now / delete /
// enabled switch / last run). Keyed by the parent so switching targets
// remounts with fresh field state.
function WorkflowForm({
  workflow,
  busy,
  onboarding,
  onSave,
  onDelete,
  onRunNow,
  onToggleEnabled,
  onCancel,
}: {
  workflow: CustomWorkflow | null
  busy: boolean
  onboarding: boolean
  onSave: (draft: WorkflowDraft) => Promise<void>
  onDelete: () => void
  onRunNow: () => void
  onToggleEnabled: (enabled: boolean) => void
  onCancel: () => void
}) {
  const t = useTranslations("CustomWorkflows")

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="@container mx-auto flex w-full max-w-3xl min-h-0 flex-1 flex-col gap-4 p-4 sm:p-6">
        {onboarding ? (
          <div className="flex flex-col items-center gap-2 pt-2 pb-2 text-center">
            <span className="flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
              <Workflow className="size-6" aria-hidden="true" />
            </span>
            <h2 className="text-base font-semibold">{t("onboardTitle")}</h2>
            <p className="max-w-md text-sm text-muted-foreground">
              {t("onboardHint")}
            </p>
          </div>
        ) : null}

        <div className="flex flex-wrap items-start justify-between gap-3">
          <h2 className="truncate text-lg font-semibold">
            {workflow ? workflow.name || t("untitled") : t("new")}
          </h2>
          {workflow ? (
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={onRunNow}
                disabled={busy}
              >
                <Play className="size-3.5" aria-hidden="true" />
                {t("runNow")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive"
                onClick={onDelete}
                disabled={busy}
              >
                <Trash2 className="size-3.5" aria-hidden="true" />
                {t("delete")}
              </Button>
              <label className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                {workflow.enabled ? t("enabled") : t("disabled")}
                <Switch
                  checked={workflow.enabled}
                  disabled={busy}
                  onCheckedChange={onToggleEnabled}
                  aria-label={t("enabled")}
                />
              </label>
            </div>
          ) : null}
        </div>

        {workflow ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
            <WorkflowStatusChip status={workflow.last_status} />
            <span>
              {t("lastRun")}:{" "}
              <span
                title={
                  workflow.last_run
                    ? new Date(workflow.last_run).toLocaleString()
                    : undefined
                }
              >
                {workflow.last_run
                  ? new Date(workflow.last_run).toLocaleString()
                  : t("neverRun")}
              </span>
            </span>
            <span className="tabular-nums">
              {t("runCount")}: {workflow.run_count}
            </span>
          </div>
        ) : null}

        {workflow &&
        workflow.last_status === "failed" &&
        workflow.last_error ? (
          <div className="flex min-w-0 items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-2.5 py-1.5 text-xs text-destructive">
            <span className="truncate" title={workflow.last_error}>
              {t("lastError")}: {workflow.last_error}
            </span>
          </div>
        ) : null}

        {/* The native Automations editor, copied verbatim with the folder
            target swapped for the target-chat conversation picker. It owns its
            own scrolling, so there's no outer ScrollArea here. */}
        <AutomationEditor
          workflow={workflow}
          onSubmit={onSave}
          onCancel={onCancel}
        />
      </div>
    </div>
  )
}
