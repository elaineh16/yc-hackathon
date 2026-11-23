// Provenance: one visual language for WHO or WHAT did something, used everywhere on the manager's case workspace.
// The point is never to blur these: an AI proposal is not an executed action; a system acceptance is not a person's
// confirmation; a captured email is not a delivered one; waiting is not failure.
import { Bot, Check, CheckCheck, Clock, Cpu, Hourglass, Mail, MailX, MinusCircle, Send, Sparkles, User, UserCheck, Wrench, XCircle } from "lucide-react";
import type { ReactNode } from "react";
import type { EventView, FollowUpView } from "../../shared/views";
import { cn } from "../ui";

export type Kind = "ai-proposal" | "ai-action" | "system" | "manager" | "vendor" | "resident" | "confirmed" | "waiting" | "failed" | "skipped";

const STYLE: Record<Kind, { label: string; icon: ReactNode; className: string }> = {
  "ai-proposal": { label: "AI proposal", icon: <Sparkles />, className: "border-[#d5daf0] bg-ai-soft text-ai" },
  "ai-action": { label: "AI action (policy)", icon: <Bot />, className: "border-ai bg-ai text-white" },
  system: { label: "System", icon: <Cpu />, className: "border-line bg-sunk text-ink-2" },
  manager: { label: "Manager", icon: <UserCheck />, className: "border-line-strong bg-surface text-ink" },
  vendor: { label: "Vendor", icon: <Wrench />, className: "border-[#c9dcf2] bg-info-soft text-info" },
  resident: { label: "Resident", icon: <User />, className: "border-line bg-surface text-[#45606d]" },
  confirmed: { label: "Confirmed by a person", icon: <CheckCheck />, className: "border-[#c3e2cb] bg-ok-soft text-ok" },
  waiting: { label: "Waiting", icon: <Hourglass />, className: "border-[#f1d9b0] bg-warn-soft text-warn" },
  failed: { label: "Failed", icon: <XCircle />, className: "border-[#f0c4be] bg-danger-soft text-danger" },
  skipped: { label: "Skipped", icon: <MinusCircle />, className: "border-line bg-sunk text-muted" },
};

export function Provenance({ kind, label, className }: { kind: Kind; label?: string; className?: string }) {
  const s = STYLE[kind];
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-px text-[11px] font-medium whitespace-nowrap [&_svg]:size-3", s.className, className)}>
      {s.icon}
      {label ?? s.label}
    </span>
  );
}

const FAILED = /(FAILED|UNAVAILABLE|SKIPPED|OVERDUE|UNANSWERED|EXPIRED|REJECTED|DECLINED)/;
/** What kind of thing an event is, from who did it and what it was. */
export function eventKind(e: Pick<EventView, "actorRole" | "type">): Kind {
  if (e.actorRole === "AGENT") return e.type === "AI_PROPOSAL" || e.type === "MESSAGE_TO_RESIDENT" ? "ai-proposal" : e.type === "AI_UNAVAILABLE" ? "skipped" : e.type === "AI_FAILED" ? "failed" : "ai-action";
  if (/DISCOVERY_FAILED|AI_UNAVAILABLE|DISCOVERY_UNAVAILABLE/.test(e.type)) return "failed";
  if (/DISCOVERY_SKIPPED/.test(e.type)) return "skipped";
  if (e.actorRole === "SYSTEM") return FAILED.test(e.type) ? "waiting" : "system";
  if (e.actorRole === "MANAGER") return "manager";
  if (e.actorRole === "CONTRACTOR") return "vendor";
  if (e.type === "VERIFY_RESOLVED") return "confirmed";
  return "resident";
}
export function eventLabel(e: Pick<EventView, "actorRole" | "type">): string | undefined {
  if (e.type === "MESSAGE_TO_RESIDENT") return "AI draft, sent by a manager";
  if (e.type === "AI_UNAVAILABLE") return "AI unavailable";
  if (e.type === "AI_FAILED") return "AI review failed";
  if (e.actorRole === "AGENT" && e.type === "ESCALATE") return "AI escalation (rules agreed)";
  if (e.actorRole === "AGENT" && e.type === "ASSIGN_VENDOR") return "AI offer (autopilot)";
  if (e.actorRole === "CONTRACTOR" && e.type === "VENDOR_ACCEPT") return "Vendor accepted";
  if (e.actorRole === "CONTRACTOR" && e.type === "COMPLETE_WORK") return "Vendor says done";
  if (e.type === "VERIFY_RESOLVED") return "Resident confirmed";
  if (e.type === "REPORT_UNRESOLVED") return "Resident: not fixed";
  return undefined;
}

/** A delivery state, worded exactly as strongly as the channel can prove. */
export function Delivery({ f }: { f: Pick<FollowUpView, "channel" | "status" | "readAt" | "acknowledgedAt" | "ackDueAt"> }) {
  const base = "inline-flex items-center gap-1 rounded border px-1.5 py-px text-[11px] font-medium whitespace-nowrap [&_svg]:size-3";
  if (f.channel === "IN_APP") {
    if (f.acknowledgedAt) return <span className={cn(base, "border-[#c3e2cb] bg-ok-soft text-ok")}><CheckCheck /> Acknowledged</span>;
    if (f.ackDueAt && new Date(f.ackDueAt) < new Date()) return <span className={cn(base, "border-[#f0c4be] bg-danger-soft text-danger")}><Clock /> Ack overdue</span>;
    if (f.readAt) return <span className={cn(base, "border-line bg-surface text-ink-2")}><Check /> Read</span>;
    return <span className={cn(base, "border-line bg-sunk text-ink-2")}><Send /> In inbox</span>;
  }
  const map: Record<FollowUpView["status"], { t: string; c: string; i: ReactNode }> = {
    CAPTURED: { t: "Captured (test server)", c: "border-line bg-sunk text-muted", i: <Mail /> },
    ACCEPTED: { t: "Accepted by mail server", c: "border-[#c9dcf2] bg-info-soft text-info", i: <Mail /> },
    PENDING: { t: "Queued", c: "border-[#f1d9b0] bg-warn-soft text-warn", i: <Hourglass /> },
    SENDING: { t: "Sending", c: "border-[#f1d9b0] bg-warn-soft text-warn", i: <Hourglass /> },
    FAILED: { t: "Failed", c: "border-[#f0c4be] bg-danger-soft text-danger", i: <MailX /> },
    SKIPPED: { t: "Not sent", c: "border-line bg-surface text-faint", i: <MinusCircle /> },
    DELIVERED: { t: "Delivered", c: "border-line bg-sunk text-ink-2", i: <Send /> },
  };
  const m = map[f.status];
  return (
    <span className={cn(base, m.c)}>
      {m.i} {m.t}
    </span>
  );
}

/** A ref like RLY-0042, in the mono face. */
export const Ref = ({ children, className }: { children: ReactNode; className?: string }) => <span className={cn("font-mono text-[12px] text-muted", className)}>{children}</span>;
