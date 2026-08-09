"use client"

/**
 * Notification-sound settings — pick which agent events play an audible cue,
 * and which tone each one uses.
 *
 * The event rows are the same catalogue as the chat-channel Events tab, and
 * deliberately borrow that tab's labels (`ChatChannelSettings.events.*`) so a
 * user reads the identical trigger names in both places. Only the short names
 * are reused: the channel descriptions talk about what gets pushed off the
 * machine, which does not apply to a local sound.
 *
 * Preferences live in localStorage (see `notification-sound-prefs.ts`), so
 * every change is written immediately — there is no Save button and no
 * failure mode to report, unlike the backend-backed sections around it.
 */

import { useCallback } from "react"
import { useTranslations } from "next-intl"
import { Play, Volume2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { previewTone } from "@/lib/notification-sound"
import {
  SOUND_EVENT_IDS,
  SOUND_TONE_IDS,
  saveNotificationSoundPrefs,
  useNotificationSoundPrefs,
  type SoundEventId,
  type SoundToneId,
} from "@/lib/notification-sound-prefs"

// Literal message keys per id — next-intl only resolves literal keys, so the
// lookup tables keep the rows data-driven without losing key checking.
const EVENT_LABEL_KEYS = {
  turn_complete: "turnComplete",
  permission_request: "permissionRequest",
  question_request: "questionRequest",
  error: "error",
  user_prompt_sent: "userPromptSent",
} as const satisfies Record<SoundEventId, string>

const TONE_LABEL_KEYS = {
  none: "toneNone",
  chime: "toneChime",
  ding: "toneDing",
  blip: "toneBlip",
  pop: "tonePop",
  alert: "toneAlert",
  descend: "toneDescend",
} as const satisfies Record<SoundToneId, string>

export function NotificationSoundSettingsSection() {
  const t = useTranslations("NotificationSoundSettings")
  const tEvents = useTranslations("ChatChannelSettings.events")

  // Stored preferences are the only state: the panel renders straight off the
  // shared snapshot, and every write re-renders it through that snapshot — so
  // a write that silently failed (quota, blocked storage) leaves the control
  // showing what is actually stored, not a value nothing kept. Another window
  // (the workspace, or a second settings window) writing the same key lands
  // here the same way.
  const prefs = useNotificationSoundPrefs()

  const setTone = useCallback(
    (eventId: SoundEventId, tone: SoundToneId) => {
      saveNotificationSoundPrefs({
        ...prefs,
        tones: { ...prefs.tones, [eventId]: tone },
      })
      // Play what was just picked, so choosing a tone is how you hear it.
      // (Only unlocks audio in THIS window; the workspace has its own audio
      // context and arms its own gesture — see primeNotificationSoundOutput.)
      previewTone(tone, prefs.volume)
    },
    [prefs]
  )

  const volumePercent = Math.round(prefs.volume * 100)

  return (
    <section className="rounded-xl border bg-card p-4 space-y-4">
      <div className="flex items-center gap-2">
        <Volume2 className="h-4 w-4 text-muted-foreground" aria-hidden />
        <h2 className="text-sm font-semibold">{t("title")}</h2>
      </div>
      <p className="text-xs text-muted-foreground leading-5">
        {t("description")}
      </p>

      <div className="flex items-center justify-between gap-3">
        <div className="space-y-1 min-w-0">
          <label
            htmlFor="notification-sound-enabled"
            className="text-sm font-medium"
          >
            {t("enable")}
          </label>
          <p className="text-xs text-muted-foreground">{t("enableHint")}</p>
        </div>
        <Switch
          id="notification-sound-enabled"
          checked={prefs.enabled}
          onCheckedChange={(enabled) =>
            saveNotificationSoundPrefs({ ...prefs, enabled })
          }
          className="shrink-0"
        />
      </div>

      {prefs.enabled && (
        <>
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <label className="text-xs font-medium text-muted-foreground">
                {t("volume")}
              </label>
              <span className="text-xs tabular-nums text-muted-foreground">
                {volumePercent}%
              </span>
            </div>
            <div className="flex items-center gap-3">
              <Slider
                value={[volumePercent]}
                min={0}
                max={100}
                step={5}
                aria-label={t("volume")}
                onValueChange={([value]) =>
                  saveNotificationSoundPrefs({ ...prefs, volume: value / 100 })
                }
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0"
                onClick={() => previewTone("chime", prefs.volume)}
              >
                <Play className="h-3.5 w-3.5" />
                {t("preview")}
              </Button>
            </div>
          </div>

          <div className="flex items-center justify-between gap-3">
            <div className="space-y-1 min-w-0">
              <label
                htmlFor="notification-sound-unfocused"
                className="text-sm font-medium"
              >
                {t("onlyWhenUnfocused")}
              </label>
              <p className="text-xs text-muted-foreground">
                {t("onlyWhenUnfocusedHint")}
              </p>
            </div>
            <Switch
              id="notification-sound-unfocused"
              checked={prefs.onlyWhenUnfocused}
              onCheckedChange={(onlyWhenUnfocused) =>
                saveNotificationSoundPrefs({ ...prefs, onlyWhenUnfocused })
              }
              className="shrink-0"
            />
          </div>

          <div className="space-y-2">
            <h3 className="text-xs font-medium text-muted-foreground">
              {t("eventsTitle")}
            </h3>
            <div className="space-y-1">
              {SOUND_EVENT_IDS.map((eventId) => {
                const tone = prefs.tones[eventId]
                const label = tEvents(EVENT_LABEL_KEYS[eventId])
                return (
                  <div
                    key={eventId}
                    className="flex items-center justify-between gap-3 rounded-lg border bg-background px-3 py-2"
                  >
                    <span className="min-w-0 truncate text-sm">{label}</span>
                    <div className="flex shrink-0 items-center gap-2">
                      <Select
                        value={tone}
                        onValueChange={(value) =>
                          setTone(eventId, value as SoundToneId)
                        }
                      >
                        <SelectTrigger className="w-36" aria-label={label}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent align="end">
                          {SOUND_TONE_IDS.map((toneId) => (
                            <SelectItem key={toneId} value={toneId}>
                              {t(TONE_LABEL_KEYS[toneId])}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        disabled={tone === "none"}
                        aria-label={t("previewEvent", { event: label })}
                        onClick={() => previewTone(tone, prefs.volume)}
                      >
                        <Play className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                )
              })}
            </div>
            <p className="text-[11px] text-muted-foreground leading-4">
              {t("eventsHint")}
            </p>
          </div>
        </>
      )}
    </section>
  )
}
