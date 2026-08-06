"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { Check, ChevronDown, Loader2, MessagesSquare } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { listAllConversations } from "@/lib/api"
import { cn } from "@/lib/utils"
import type {
  AgentType,
  ConversationStatus,
  DbConversationSummary,
} from "@/lib/types"

interface AutomationConversationPickerProps {
  /** Agent the automation fires with; the list shows only that agent's
   *  top-level conversations (the resume chain is per-agent). */
  agentType: AgentType
  /** Currently pinned conversation id, or null for a fresh conversation. */
  value: number | null
  onChange: (conversationId: number) => void
  placeholder: string
}

/** Statuses whose conversations an automation may resume. A mid-turn
 *  `in_progress` conversation must not be targeted — the manager's turn guard
 *  would reject the prompt — so it is never offered. */
const RESUMABLE_STATUSES: ReadonlySet<ConversationStatus> = new Set([
  "pending_review",
  "completed",
  "cancelled",
])

function conversationTitle(
  conv: DbConversationSummary,
  untitled: string
): string {
  return conv.title?.trim() ? conv.title : untitled
}

/**
 * A select-only conversation dropdown for the automation editor: a searchable
 * list of the automation's agent's top-level conversations, styled after the
 * branch picker. Picking pins `existing_conversation_id` on the automation so
 * each fire resumes that conversation instead of creating a fresh one.
 */
export function AutomationConversationPicker({
  agentType,
  value,
  onChange,
  placeholder,
}: AutomationConversationPickerProps) {
  const t = useTranslations("Folder")
  const [open, setOpen] = useState(false)
  const [conversations, setConversations] = useState<
    DbConversationSummary[] | null
  >(null)
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState("")
  const reqRef = useRef(0)

  const load = useCallback(async () => {
    const id = ++reqRef.current
    setLoading(true)
    try {
      const list = await listAllConversations({ agent_type: agentType })
      if (id === reqRef.current) {
        setConversations(
          list.filter((c) =>
            RESUMABLE_STATUSES.has(c.status as ConversationStatus)
          )
        )
      }
    } catch {
      if (id === reqRef.current) setConversations([])
    } finally {
      if (id === reqRef.current) setLoading(false)
    }
  }, [agentType])

  // Load on every open (fresh data), and once on mount when a conversation is
  // already pinned so the closed trigger can show its title immediately.
  useEffect(() => {
    if (open) void load()
  }, [open, load])
  useEffect(() => {
    if (value != null) void load()
  }, [value != null, load])

  // Drop the cached list when the agent changes so the next load refetches.
  useEffect(() => {
    setConversations(null)
    setQuery("")
  }, [agentType])

  // Clear the (controlled) search on every close — mirrors the branch picker.
  const [prevOpen, setPrevOpen] = useState(open)
  if (open !== prevOpen) {
    setPrevOpen(open)
    if (!open) setQuery("")
  }

  const untitled = t("search.untitledConversation")
  const selected = conversations?.find((c) => c.id === value) ?? null
  const triggerLabel = selected
    ? conversationTitle(selected, untitled)
    : value != null
      ? `#${value}`
      : placeholder

  const q = query.trim()
  const visible = (conversations ?? []).filter((c) => {
    if (!q) return true
    return conversationTitle(c, untitled)
      .toLowerCase()
      .includes(q.toLowerCase())
  })

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 max-w-[22rem] justify-start gap-1.5 text-xs font-normal"
        >
          <MessagesSquare
            className="size-3.5 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <span
            className={cn(
              "min-w-0 truncate",
              !selected && value == null && "text-muted-foreground"
            )}
          >
            {triggerLabel}
          </span>
          <ChevronDown
            className="size-3.5 shrink-0 text-muted-foreground/60"
            aria-hidden="true"
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 overflow-hidden p-0">
        <Command className="rounded-2xl">
          <CommandInput
            placeholder={t("sidebar.searchPlaceholder")}
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            {loading ? (
              <div className="py-6 text-center">
                <Loader2
                  className="mx-auto size-3.5 animate-spin text-muted-foreground"
                  aria-hidden="true"
                />
              </div>
            ) : (
              <>
                <CommandEmpty>{t("sidebar.noConversationsFound")}</CommandEmpty>
                {visible.length > 0 ? (
                  <CommandGroup>
                    {visible.map((c) => (
                      <CommandItem
                        key={c.id}
                        value={`conv-${c.id}`}
                        onSelect={() => {
                          onChange(c.id)
                          setOpen(false)
                        }}
                      >
                        <MessagesSquare
                          className="size-4 shrink-0 opacity-60"
                          aria-hidden="true"
                        />
                        <span className="min-w-0 flex-1 truncate">
                          {conversationTitle(c, untitled)}
                        </span>
                        {c.id === value ? (
                          <Check
                            className="size-4 shrink-0"
                            aria-hidden="true"
                          />
                        ) : null}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                ) : null}
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
