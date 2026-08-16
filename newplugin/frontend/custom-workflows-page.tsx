"use client"

import { CalendarCog } from "lucide-react"

/** Feature 5 — Custom Workflows placeholder.
 *
 * Deliberately inert: the scheduler engine (custom_cron.rs / web_workflows.rs)
 * is intentionally NOT wired up. This page only exists so the left-sidebar
 * route renders. It hardcodes its copy on purpose — it is a committed custom
 * file (newplugin/), type-checked in the pure tree where the i18n key added by
 * the customtab patch group does not exist yet.
 */

/** Title strip shown in the window-chrome band above the page (same metrics
 *  and icon-then-label shape as AutomationsPageTitle / TasksPageTitle). */
export function CustomWorkflowsPageTitle() {
  return (
    <div className="flex h-10 shrink-0 items-center gap-2 pl-4">
      <h1 className="flex items-center gap-1.5 text-[0.8125rem] font-semibold leading-none">
        <CalendarCog
          className="size-4 text-muted-foreground"
          aria-hidden="true"
        />
        Custom Workflows
      </h1>
    </div>
  )
}

/** Placeholder main content region. */
export function CustomWorkflowsPage() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <CalendarCog
        className="size-10 text-muted-foreground"
        aria-hidden="true"
      />
      <h2 className="text-base font-semibold">Custom Workflows</h2>
      <p className="max-w-md text-sm text-muted-foreground">
        Custom workflow scheduling is coming soon.
      </p>
    </div>
  )
}
