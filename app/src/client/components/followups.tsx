// Follow-ups on a case: every notification, to whom, on which channel, and what really happened to it.
import { Bell, ChevronDown, Mail } from "lucide-react";
import { useState } from "react";
import type { FollowUpView } from "../../shared/views";
import { dueIn, when } from "../lib";
import { cn, Panel, PanelHeader } from "../ui";
import { Delivery } from "./provenance";

const EVENT: Record<string, string> = {
  "case.received": "Report received",
  "case.new": "New report",
  "case.emergency": "Emergency alert",
  "case.review_needed": "Needs review",
  "offer.received": "Job offer",
  "offer.reminder": "Offer reminder",
  "offer.expired": "Offer expired",
  "offer.declined": "Offer declined",
  "offer.closed": "Job withdrawn",
  "estimate.decision": "Estimate",
  "estimate.approved": "Estimate approved",
  "estimate.rejected": "Estimate rejected",
  "estimate.reminder": "Approval reminder",
  "appointment.proposed": "Visit times proposed",
  "appointment.reminder_to_choose": "Reminder to choose a time",
  "appointment.no_answer": "No time chosen",
  "appointment.confirmed": "Visit confirmed",
  "appointment.reminder": "Visit reminder",
  "appointment.declined": "Times declined",
  "appointment.cancelled": "Visit cancelled",
  "appointment.clash": "Time clash",
  "repair.started": "Work started",
  "repair.completed": "Is it fixed?",
  "verification.reminder": "Confirmation reminder",
  "verification.overdue": "No confirmation",
  "budget.requested": "More money requested",
  "budget.decided": "Budget decision",
  "budget.over_cap": "Over approved amount",
  "case.resolved": "Resolved",
  "case.not_fixed": "Not fixed",
  "case.reopened": "Reopened",
  "case.cancelled": "Cancelled",
  "case.closed_unverified": "Closed unverified",
  "case.escalated": "Escalated",
  "agent.suggestion": "AI suggestion",
  "agent.blocked": "Relay needs you",
  "message.update": "Update to resident",
  "discovery.started": "Vendor search started",
  "discovery.approval_needed": "Approve vendor search",
  "discovery.completed": "Businesses found",
};

export function FollowUpsPanel({ items }: { items: FollowUpView[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, 10);
  const email = items.filter((f) => f.channel === "EMAIL");
  const sent = email.filter((f) => f.status === "ACCEPTED" || f.status === "CAPTURED").length;
  return (
    <Panel>
      <PanelHeader title={<span className="flex items-center gap-2"><Bell className="size-4 text-muted" /> Follow-ups</span>}>
        {items.length} notification{items.length === 1 ? "" : "s"} on this case; {sent} of {email.length} email{email.length === 1 ? "" : "s"} handed to a mail server. In-app ones are in the person's Relay inbox.
      </PanelHeader>
      {items.length === 0 ? (
        <p className="px-4 py-5 text-sm text-muted">Nobody has been notified yet.</p>
      ) : (
        <ul className="divide-y divide-line" data-testid="followups">
          {shown.map((f) => {
            const due = f.ackDueAt && !f.acknowledgedAt ? dueIn(f.ackDueAt) : null;
            return (
              <li key={f.id} className="px-4 py-2.5 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  {f.channel === "EMAIL" ? <Mail className="size-3.5 text-faint" aria-label="Email" /> : <Bell className="size-3.5 text-faint" aria-label="In-app" />}
                  <span className="font-medium text-ink-2">{f.recipient}</span>
                  <span className="text-faint">{f.role.toLowerCase()}</span>
                  <Delivery f={f} />
                  <span className="ml-auto text-faint">{when(f.at)}</span>
                </div>
                <p className="mt-1 text-[13px]">
                  <span className="text-muted">{EVENT[f.eventType] ?? f.eventType}:</span> {f.title}
                </p>
                {(f.statusNote || f.lastError || due) && (
                  <p className={cn("mt-0.5", f.status === "FAILED" ? "text-danger" : "text-faint")}>
                    {f.statusNote ?? f.lastError}
                    {due && <span className={cn(due.overdue && "text-danger")}> Acknowledgement {due.text}.</span>}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {items.length > 10 && (
        <button className="flex w-full items-center justify-center gap-1 border-t border-line py-2 text-xs text-muted hover:text-ink" onClick={() => setAll(!all)}>
          <ChevronDown className={cn("size-3.5", all && "rotate-180")} /> {all ? "Show fewer" : `Show all ${items.length}`}
        </button>
      )}
    </Panel>
  );
}
