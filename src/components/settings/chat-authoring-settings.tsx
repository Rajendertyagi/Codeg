"use client"

/**
 * Create-from-chat settings panel — two independent kill switches persisted as
 * `chat_authoring.automations_enabled` / `chat_authoring.work_tasks_enabled` on
 * the Rust side.
 *
 * When on, `codeg-mcp` exposes `create_automation` (save a scheduled or manual
 * automation) and/or `create_work_task` (queue a card on the task board) so an
 * agent can park recurring or deferred work without the user leaving the
 * conversation. Both ship OFF: unlike the read-only lookups next to them these
 * tools write app state, and a scheduled automation goes on to spawn agents on
 * its own. Mounted under `/settings/general` with the other MCP-tool toggles.
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { CalendarClock, ListTodo, Loader2, Sparkles } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import {
  type ChatAuthoringSettings,
  getChatAuthoringSettings,
  setChatAuthoringSettings,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"

export function ChatAuthoringSettingsSection() {
  const t = useTranslations("ChatAuthoringSettings")
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [automations, setAutomations] = useState(false)
  const [workTasks, setWorkTasks] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void getChatAuthoringSettings()
      .then((s) => {
        if (cancelled) return
        setAutomations(s.automations_enabled)
        setWorkTasks(s.work_tasks_enabled)
        setLoadError(null)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setLoadError(toErrorMessage(err))
      })
      .finally(() => {
        if (cancelled) return
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const save = useCallback(async () => {
    const payload: ChatAuthoringSettings = {
      automations_enabled: automations,
      work_tasks_enabled: workTasks,
    }
    setSaving(true)
    try {
      const applied = await setChatAuthoringSettings(payload)
      setAutomations(applied.automations_enabled)
      setWorkTasks(applied.work_tasks_enabled)
      toast.success(t("saved"))
    } catch (err: unknown) {
      toast.error(t("saveFailed"), { description: toErrorMessage(err) })
    } finally {
      setSaving(false)
    }
  }, [automations, workTasks, t])

  return (
    <section className="rounded-xl border bg-card p-4 space-y-4">
      <div className="flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-muted-foreground" aria-hidden />
        <h2 className="text-sm font-semibold">{t("title")}</h2>
      </div>
      <p className="text-xs text-muted-foreground leading-5">
        {t("description")}
      </p>

      {loadError && (
        <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {t("loadFailed", { detail: loadError })}
        </p>
      )}

      <div className="flex items-center justify-between gap-3">
        <div className="space-y-1 min-w-0">
          <label
            htmlFor="chat-authoring-automations"
            className="flex items-center gap-1.5 text-sm font-medium"
          >
            <CalendarClock
              className="h-3.5 w-3.5 text-muted-foreground"
              aria-hidden
            />
            {t("enableAutomations")}
          </label>
          <p className="text-xs text-muted-foreground">
            {t("enableAutomationsHint")}
          </p>
        </div>
        <Switch
          id="chat-authoring-automations"
          checked={automations}
          onCheckedChange={setAutomations}
          disabled={loading}
          className="shrink-0"
        />
      </div>

      <div className="flex items-center justify-between gap-3">
        <div className="space-y-1 min-w-0">
          <label
            htmlFor="chat-authoring-work-tasks"
            className="flex items-center gap-1.5 text-sm font-medium"
          >
            <ListTodo
              className="h-3.5 w-3.5 text-muted-foreground"
              aria-hidden
            />
            {t("enableWorkTasks")}
          </label>
          <p className="text-xs text-muted-foreground">
            {t("enableWorkTasksHint")}
          </p>
        </div>
        <Switch
          id="chat-authoring-work-tasks"
          checked={workTasks}
          onCheckedChange={setWorkTasks}
          disabled={loading}
          className="shrink-0"
        />
      </div>

      <div className="flex justify-end pt-2">
        <Button onClick={save} disabled={loading || saving} size="sm">
          {saving ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t("saving")}
            </>
          ) : (
            t("save")
          )}
        </Button>
      </div>
    </section>
  )
}
