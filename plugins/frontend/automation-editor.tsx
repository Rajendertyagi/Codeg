"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { ArrowLeft, Globe, MessagesSquare, Wand2 } from "lucide-react"
import { useTranslations } from "next-intl"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { AgentSelector } from "@/components/chat/agent-selector"
import {
  RichComposer,
  type RichComposerHandle,
} from "@/components/chat/composer/rich-composer"
import {
  useReferenceSearch,
  type ReferenceGroupLabels,
} from "@/components/chat/composer/use-reference-search"
import { isComposerChromeClick } from "@/components/chat/composer/composer-commands"
import type { MentionUiLabels } from "@/components/chat/composer/suggestion/types"
import { AgentConfigSection } from "@/components/automations/agent-config-section"
import {
  ComposerInvocationsPopup,
  useComposerInvocations,
} from "@/components/automations/composer-invocations"
import { CronBuilderDialog } from "@/components/automations/cron-builder-dialog"
import { useAgentOptions } from "@/components/automations/use-agent-options"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import { automationComputeNextRun, type CustomWorkflow } from "@/lib/api"
import type { AgentType, AutomationTriggerKind } from "@/lib/types"

/** Editor compat: the custom-workflow backend stores no per-workflow agent,
 *  trigger-kind or timezone columns (the engine fires against the live
 *  connection's agent; manual-vs-schedule isn't a persisted dimension). These
 *  optional mirror fields exist only so this copy can initialize its state from
 *  an existing workflow without special-casing — in practice they are always
 *  absent (the API returns just the persisted `CustomWorkflow` fields). */
type WorkflowLike = CustomWorkflow & {
  agent_type?: AgentType
  trigger_kind?: AutomationTriggerKind
  timezone?: string
  config?: { mode_id?: string | null; config_values?: Record<string, string> }
}

interface AutomationEditorProps {
  /** The workflow being edited, or `null` for a blank create. */
  workflow: WorkflowLike | null
  onSubmit: (draft: WorkflowDraft) => Promise<void>
  onCancel: () => void
  /** Kept for structural parity with the native editor (the custom plugin has
   *  no template gallery). */
  onBackToTemplates?: () => void
}

/** The payload this copy produces, matching the custom workflow API. */
export interface WorkflowDraft {
  name: string
  conversation_id: number
  cron: string
  prompt: string
}

const CRON_PRESETS = [
  { key: "presetHourly" as const, cron: "0 * * * *" },
  { key: "presetDaily" as const, cron: "0 9 * * *" },
  { key: "presetWeekdays" as const, cron: "0 9 * * 1-5" },
]

function detectTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  } catch {
    return "UTC"
  }
}

export function AutomationEditor({
  workflow,
  onSubmit,
  onCancel,
  onBackToTemplates,
}: AutomationEditorProps) {
  const t = useTranslations("Automations")
  // The @-mention panel chrome reuses the chat composer's existing keys.
  const tComposer = useTranslations("Folder.chat.messageInput")
  // The conversation-target labels live in the plugin's own catalog; the rest
  // of the form's chrome reuses the native Automations catalog (shared copy).
  const tCustom = useTranslations("CustomWorkflows")
  const conversations = useAppWorkspaceStore((s) => s.conversations)

  const [name, setName] = useState(workflow?.name ?? "")
  const [agentType, setAgentType] = useState<AgentType>(
    workflow?.agent_type ?? "claude_code"
  )
  // Mirrors the composer's plain text for live validation; the authoritative
  // value is read from the editor ref at submit (so a prefilled edit validates
  // even before the user types — defaultText applies without firing onChange).
  const [prompt, setPrompt] = useState(workflow?.prompt ?? "")
  const [conversationId, setConversationId] = useState<number | null>(
    workflow?.conversation_id ?? null
  )
  const [trigger, setTrigger] = useState<AutomationTriggerKind>(
    workflow?.trigger_kind ?? "schedule"
  )
  const [cron, setCron] = useState(workflow?.cron ?? "0 9 * * 1-5")
  // Detected from this device once and shown read-only (Codex-style — no manual
  // override). Still feeds the next-run preview and the cron builder.
  const [timezone] = useState(workflow?.timezone ?? detectTimezone())
  const [modeId, setModeId] = useState<string | null>(
    workflow?.config?.mode_id ?? null
  )
  const [configValues, setConfigValues] = useState<Record<string, string>>(
    workflow?.config?.config_values ?? {}
  )
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [nextRun, setNextRun] = useState<string | null>(null)
  const [cronBuilderOpen, setCronBuilderOpen] = useState(false)

  const editorRef = useRef<RichComposerHandle>(null)

  const referenceGroupLabels = useMemo<ReferenceGroupLabels>(
    () => ({
      file: tComposer("mentionGroupFile"),
      agent: tComposer("mentionGroupAgent"),
      session: tComposer("mentionGroupSession"),
      commit: tComposer("mentionGroupCommit"),
      skill: tComposer("mentionGroupSkill"),
    }),
    [tComposer]
  )
  const mentionUiLabels = useMemo<MentionUiLabels>(
    () => ({
      empty: tComposer("mentionEmpty"),
      loading: tComposer("mentionLoading"),
      listbox: tComposer("mentionListLabel"),
      more: tComposer("mentionMore"),
      count: (count: number) => tComposer("mentionCount", { count }),
    }),
    [tComposer]
  )
  // Live data sources for the @ panel (files/agents/sessions/commits). All
  // transport-only — no live ACP session needed; just the folder path. The
  // custom plugin has no folder dimension, so the mention search runs global.
  const referenceSearch = useReferenceSearch({
    defaultPath: null,
    enabled: true,
    labels: referenceGroupLabels,
  })

  // One transient probe feeds both the config selectors and the `/` command menu
  // (the snapshot carries available_commands). `$` Codex skills load separately
  // (filesystem scan) inside the invocations hook.
  const agentOptions = useAgentOptions(agentType, null)
  const invocations = useComposerInvocations({
    editorRef,
    agentType,
    folderPath: null,
    availableCommands: agentOptions.snapshot?.available_commands ?? [],
  })

  // Authoritative "next run" preview — same backend evaluator the scheduler
  // uses, so the previewed time can never diverge from the actual fire.
  useEffect(() => {
    if (trigger !== "schedule" || !cron.trim()) {
      setNextRun(null)
      return
    }
    let cancelled = false
    const handle = setTimeout(() => {
      automationComputeNextRun(cron.trim(), timezone)
        .then((r) => {
          if (!cancelled) setNextRun(r)
        })
        .catch(() => {
          if (!cancelled) setNextRun(null)
        })
    }, 300)
    return () => {
      cancelled = true
      clearTimeout(handle)
    }
  }, [cron, timezone, trigger])

  // Backfill the default conversation once the workspace conversations finish
  // hydrating — a new workflow opened before they load would otherwise keep
  // conversationId null and block submit. Guarding on
  // `workflow?.conversation_id == null` (rather than `!workflow`) never
  // overrides the target of an existing workflow being edited (its
  // conversationId is non-null, so the `conversationId == null` guard already
  // short-circuits).
  useEffect(() => {
    if (
      conversationId == null &&
      workflow?.conversation_id == null &&
      conversations.length > 0
    ) {
      setConversationId(conversations[0].id)
    }
  }, [conversations, conversationId, workflow])

  const submit = async () => {
    setError(null)
    const displayText = (editorRef.current?.getText() ?? prompt).trim()
    if (!name.trim()) return setError(t("errorName"))
    if (!displayText) return setError(t("errorPrompt"))
    if (!cron.trim()) return setError(t("errorCron"))
    // The Save button is disabled while there are no conversations to target,
    // so this is a race-safety net — the message matches the empty-state hint.
    if (conversationId == null) return setError(tCustom("noConversations"))

    setSaving(true)
    try {
      // The composer keeps its rich document for editing; the persisted payload
      // is the plain-text prompt (the engine replays it as a message into the
      // target conversation).
      const draft: WorkflowDraft = {
        name: name.trim(),
        conversation_id: conversationId,
        cron: cron.trim(),
        prompt: displayText,
      }
      await onSubmit(draft)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-1 py-1">
      {onBackToTemplates ? (
        <button
          type="button"
          onClick={onBackToTemplates}
          className="-ml-1 inline-flex w-fit items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
          {t("backToTemplates")}
        </button>
      ) : null}

      {/* Name — borderless title input */}
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={t("namePlaceholder")}
        aria-label={t("name")}
        className="w-full bg-transparent text-lg font-semibold tracking-tight outline-none placeholder:font-normal placeholder:text-muted-foreground/50"
      />

      {/* Agent pill — above the composer box, as on the new-conversation screen */}
      <div className="flex">
        <AgentSelector
          defaultAgentType={agentType}
          onSelect={(a) => {
            // Switching agents changes the option universe — reset overrides.
            setAgentType(a)
            setModeId(null)
            setConfigValues({})
          }}
          // A system substitution (saved agent unavailable) updates the type but
          // must NOT be treated as a user choice that wipes the saved config.
          onFallback={setAgentType}
        />
      </div>

      {/* The real conversation composer (rich text + @-mentions) plus an inline
          config bottom bar, matching the new-conversation input. */}
      <div
        // Clicking the box's blank chrome (padding, the dead space below a short
        // prompt, the config-bar gaps) focuses the editor at the click point —
        // same affordance as the chat composer. Interactive controls, badges and
        // the editor surface exclude themselves via NON_CHROME_SELECTOR;
        // `codeg-composer-chrome` paints the text I-beam over the dead space.
        onMouseDown={(e) => {
          if (!isComposerChromeClick(e.target)) return
          e.preventDefault()
          editorRef.current?.focusAtCoords(e.clientX, e.clientY)
        }}
        className="codeg-composer-chrome relative rounded-xl border border-input bg-background transition-colors focus-within:border-ring focus-within:ring-[3px] focus-within:ring-inset focus-within:ring-ring/50"
      >
        <ComposerInvocationsPopup inv={invocations} />
        <RichComposer
          ref={editorRef}
          defaultText={workflow?.prompt ?? ""}
          placeholder={t("promptPlaceholder")}
          ariaLabel={t("prompt")}
          referenceSearch={referenceSearch}
          mentionUiLabels={mentionUiLabels}
          tabLabels={referenceGroupLabels}
          onChange={(text) => {
            setPrompt(text)
            invocations.detect()
          }}
          isExternalMenuOpen={invocations.isOpen}
          onExternalMenuKeyDown={invocations.onKeyDown}
          className="max-h-[18rem] min-h-[7.5rem]"
        />
        <div className="px-2 pb-2 pt-1">
          <AgentConfigSection
            snapshot={agentOptions.snapshot}
            loading={agentOptions.loading}
            error={agentOptions.error}
            onReload={agentOptions.reload}
            modeId={modeId}
            configValues={configValues}
            layout="inline"
            onModeChange={setModeId}
            onConfigChange={(optionId, valueId) =>
              setConfigValues((prev) => {
                const next = { ...prev }
                if (valueId === null) delete next[optionId]
                else next[optionId] = valueId
                return next
              })
            }
          />
        </div>
      </div>

      {/* Target — the chat thread the run fires into (this replaces the native
          folder/isolation/branch picker; a workflow always targets one fixed
          conversation). */}
      <div className="flex flex-col gap-2">
        <h3 className="text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground">
          {t("sectionTarget")}
        </h3>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={conversationId != null ? String(conversationId) : undefined}
            onValueChange={(v) => setConversationId(Number(v))}
          >
            <SelectTrigger size="sm" className="h-7 gap-1.5 text-xs">
              <MessagesSquare
                className="size-3.5 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <SelectValue placeholder={tCustom("targetChatPlaceholder")} />
            </SelectTrigger>
            <SelectContent>
              {conversations.map((c) => (
                <SelectItem key={c.id} value={String(c.id)}>
                  {c.title ?? `Conversation #${c.id}`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {conversations.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {tCustom("noConversations")}
          </p>
        ) : null}
      </div>

      {/* Trigger — manual vs scheduled, with the schedule details folded in. */}
      <div className="flex flex-col gap-2">
        <h3 className="text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground">
          {t("trigger")}
        </h3>
        <div
          role="group"
          aria-label={t("trigger")}
          className="inline-flex w-fit rounded-lg border border-border bg-card/40 p-0.5"
        >
          {(
            [
              { value: "schedule", label: t("triggerSchedule") },
              { value: "manual", label: t("triggerManual") },
            ] as Array<{ value: AutomationTriggerKind; label: string }>
          ).map((opt) => (
            <button
              key={opt.value}
              type="button"
              aria-pressed={trigger === opt.value}
              onClick={() => setTrigger(opt.value)}
              className={cn(
                "rounded-md px-3 py-1 text-xs font-medium transition-colors",
                trigger === opt.value
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {trigger === "schedule" ? (
          <div className="flex flex-col gap-2 rounded-lg border border-border bg-card/40 p-3">
            <div className="flex flex-wrap gap-1.5">
              {CRON_PRESETS.map((p) => (
                <Button
                  key={p.key}
                  type="button"
                  size="sm"
                  variant={cron === p.cron ? "default" : "outline"}
                  onClick={() => setCron(p.cron)}
                >
                  {t(p.key)}
                </Button>
              ))}
            </div>
            <div className="flex items-center gap-1.5">
              <Input
                value={cron}
                onChange={(e) => setCron(e.target.value)}
                placeholder={t("cronPlaceholder")}
                aria-label={t("cron")}
                className="flex-1 font-mono"
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={() => setCronBuilderOpen(true)}
                aria-label={t("cronOpenBuilder")}
                title={t("cronOpenBuilder")}
              >
                <Wand2 className="size-4" aria-hidden="true" />
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <span>
                {t("nextRun")}:{" "}
                {nextRun ? new Date(nextRun).toLocaleString() : "—"}
              </span>
              <span className="text-muted-foreground/40" aria-hidden="true">
                ·
              </span>
              {/* Timezone is auto-detected from this device and shown read-only;
                  it still drives the next-run preview and the cron builder. */}
              <span
                className="inline-flex items-center gap-1"
                title={t("timezone")}
              >
                <Globe className="size-3 shrink-0" aria-hidden="true" />
                <span className="font-mono">{timezone}</span>
              </span>
            </div>
          </div>
        ) : null}
      </div>

      <CronBuilderDialog
        open={cronBuilderOpen}
        onOpenChange={setCronBuilderOpen}
        cron={cron}
        timezone={timezone}
        onApply={setCron}
      />

      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}

      <div className="mt-1 flex justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          onClick={onCancel}
          disabled={saving}
        >
          {t("cancel")}
        </Button>
        <Button
          type="button"
          onClick={submit}
          // No conversations to target yet (workspace still hydrating or empty):
          // keep the primary action disabled rather than saving a broken target.
          disabled={saving || conversations.length === 0}
        >
          {t("save")}
        </Button>
      </div>
    </div>
  )
}
