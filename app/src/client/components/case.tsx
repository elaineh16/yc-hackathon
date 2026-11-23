// Pieces every role's case view shares.
import { ArrowRight, Bot, CircleAlert, Clock } from "lucide-react";
import type { Role } from "../../shared/domain";
import { MAIN_PATH } from "../../shared/machine";
import type { CaseListItem, EventView } from "../../shared/views";
import { actorLabel, categoryLabel, clock, dueIn, holderText, SEVERITY_TONE, STATUS_TONE, statusLabel, when } from "../lib";
import { Badge, cn } from "../ui";

export const StatusBadge = ({ status }: { status: CaseListItem["status"] }) => <Badge tone={STATUS_TONE[status]}>{statusLabel(status)}</Badge>;
export const SeverityBadge = ({ severity }: { severity: CaseListItem["severity"] }) =>
  severity === "ROUTINE" ? <Badge tone="outline">Routine</Badge> : <Badge tone={SEVERITY_TONE[severity]}>{severity === "EMERGENCY" ? "Emergency" : "Urgent"}</Badge>;

/**
 * The product's core idea made visible: every case has a state, an owner, a next action.
 * When the viewer is the one the case is waiting on, it is marked in hi-vis orange.
 */
export function NextActionBar({ c, viewer }: { c: Pick<CaseListItem, "status" | "holder" | "nextAction" | "nextActionDueAt" | "overdue">; viewer: Role }) {
  const h = holderText(c.holder, viewer);
  const due = dueIn(c.nextActionDueAt);
  if (c.holder === "NONE") {
    return (
      <div className="flex items-center gap-3 rounded-md border border-line bg-surface px-4 py-3 text-sm">
        <StatusBadge status={c.status} />
        <span className="text-muted">{c.status === "RESOLVED" ? "This case is closed." : "This case was cancelled."}</span>
      </div>
    );
  }
  return (
    <div className={cn("flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border px-4 py-3 text-sm", h.mine ? "border-move bg-move-soft" : "border-line bg-surface")} data-testid="next-action">
      <StatusBadge status={c.status} />
      <span className={cn("font-semibold", h.mine ? "text-[#a4400a]" : "text-ink")}>{h.text}</span>
      <span className="flex min-w-0 items-center gap-2 text-ink-2">
        <ArrowRight className="size-4 shrink-0 text-faint" aria-hidden />
        {c.nextAction}
      </span>
      {due && (
        <span className={cn("ml-auto flex items-center gap-1.5 text-xs", due.overdue ? "font-medium text-danger" : "text-muted")}>
          {due.overdue ? <CircleAlert className="size-3.5" /> : <Clock className="size-3.5" />}
          {due.text}
        </span>
      )}
    </div>
  );
}

/** The main path as a compact progress line; side states are shown by the badge instead. */
export function CaseProgress({ status }: { status: CaseListItem["status"] }) {
  const index = MAIN_PATH.indexOf(status);
  if (index < 0) return null;
  return (
    <ol className="flex gap-1" aria-label={`Progress: ${statusLabel(status)}`}>
      {MAIN_PATH.map((s, i) => (
        <li key={s} title={statusLabel(s)} className={cn("h-1.5 flex-1 rounded-full", i < index ? "bg-ink/70" : i === index ? "bg-move" : "bg-line")} />
      ))}
    </ol>
  );
}

const DOT: Record<string, string> = { RESIDENT: "bg-[#6b7c8a]", MANAGER: "bg-ink", CONTRACTOR: "bg-info", SYSTEM: "bg-faint", AGENT: "bg-ai" };

/** Chronological history. Each entry says who did what, when; AI entries are labelled as such. */
export function Timeline({ events, compact }: { events: EventView[]; compact?: boolean }) {
  return (
    <ol className="relative space-y-4 before:absolute before:top-2 before:bottom-2 before:left-[5px] before:w-px before:bg-line" data-testid="timeline">
      {events.map((e) => (
        <li key={e.id} className="relative pl-6">
          <span className={cn("absolute top-1.5 left-0 size-[11px] rounded-full ring-4 ring-surface", DOT[e.actorRole] ?? "bg-faint")} aria-hidden />
          <div className="flex flex-wrap items-baseline gap-x-2 text-xs text-muted">
            <span className="font-medium text-ink-2">{e.actorName}</span>
            {e.actorRole === "AGENT" && (
              <Badge tone="ai" className="px-1.5 py-0">
                <Bot /> AI
              </Badge>
            )}
            {!compact && e.actorRole !== "AGENT" && <span>{actorLabel(e.actorRole)}</span>}
            <time className="tnum" dateTime={e.at} title={new Date(e.at).toLocaleString()}>
              {when(e.at)} ({clock(e.at)})
            </time>
            {e.audience !== "EVERYONE" && <Badge tone="outline" className="px-1.5 py-0">{e.audience === "MANAGEMENT" ? "Managers only" : "Managers and vendor"}</Badge>}
          </div>
          <p className="mt-0.5 text-sm text-ink">{e.message}</p>
          {e.toStatus && e.fromStatus && e.fromStatus !== e.toStatus && (
            <p className="mt-0.5 text-xs text-muted">
              {statusLabel(e.fromStatus)} <ArrowRight className="inline size-3" /> {statusLabel(e.toStatus)}
            </p>
          )}
        </li>
      ))}
    </ol>
  );
}

export const CaseMeta = ({ c }: { c: CaseListItem }) => (
  <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
    <span className="tnum font-medium text-ink-2">{c.ref}</span>
    <SeverityBadge severity={c.severity} />
    <Badge tone="outline">{categoryLabel(c.category)}</Badge>
    <span>
      {c.propertyName}, unit {c.unitLabel}
    </span>
  </div>
);
