"use client"

/**
 * AI Channel Messaging settings panel — a single kill switch persisted as
 * `chat_channel_messaging.enabled` on the Rust side.
 *
 * When on, `codeg-mcp` exposes `send_channel_message` so an agent can push a
 * text message into the user's already-connected/enabled chat channels
 * (Telegram, Lark, Weixin). Ship OFF: the tool writes external state, so the
 * user opts in explicitly. Mounted under `/settings/general` with the other
 * MCP-tool toggles.
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { Loader2, Radio } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import {
  type ChannelMessagingSettings,
  getChannelMessagingSettings,
  setChannelMessagingSettings,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"

export function ChannelMessagingSettingsSection() {
  const t = useTranslations("ChannelMessagingSettings")
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [enabled, setEnabled] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void getChannelMessagingSettings()
      .then((s) => {
        if (cancelled) return
        setEnabled(s.enabled)
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
    const payload: ChannelMessagingSettings = { enabled }
    setSaving(true)
    try {
      const applied = await setChannelMessagingSettings(payload)
      setEnabled(applied.enabled)
      toast.success(t("saved"))
    } catch (err: unknown) {
      toast.error(t("saveFailed"), { description: toErrorMessage(err) })
    } finally {
      setSaving(false)
    }
  }, [enabled, t])

  return (
    <section className="rounded-xl border bg-card p-4 space-y-4">
      <div className="flex items-center gap-2">
        <Radio className="h-4 w-4 text-muted-foreground" aria-hidden />
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
            htmlFor="channel-messaging-enabled"
            className="flex items-center gap-1.5 text-sm font-medium"
          >
            <Radio
              className="h-3.5 w-3.5 text-muted-foreground"
              aria-hidden
            />
            {t("enable")}
          </label>
          <p className="text-xs text-muted-foreground">
            {t("enableHint")}
          </p>
        </div>
        <Switch
          id="channel-messaging-enabled"
          checked={enabled}
          onCheckedChange={setEnabled}
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
