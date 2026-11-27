// Notifications. In-app is the primary channel and is always on. Email is secondary: only for recipients who opted
// in, only when SMTP is configured, and only for events worth an email.
//
// Every notification is one row per recipient, event and channel. The dedupe key makes a retried action, a
// re-run sweep or a duplicated job create nothing new. A row records what really happened to it (DeliveryStatus):
// in-app rows are DELIVERED when written (the inbox is the destination); email rows start PENDING and are sent by
// deliverPendingEmails() outside the transaction, so a slow or failing mail server never blocks a case action.
import type { Role } from "../../shared/domain";
import type { Tx } from "../cases/engine";
import { emailConfig } from "./config";

export type Notice = {
  /** How it is shown: ACTION, UPDATE, EMERGENCY, JOB_OFFER, REVIEW_NEEDED, NEW_CASE, APPROVED, JOB_CLOSED. */
  kind: string;
  title: string;
  body: string;
  /** What happened, for filtering and reporting. Derived from the event key when not given. */
  event?: string;
  /** Also email it to recipients who opted in. Defaults to true for kinds that need someone to act. */
  email?: boolean;
  /** The recipient is expected to act or acknowledge by then. Defaults by kind; null for none. */
  ackBy?: Date | null;
};

const EMAIL_KINDS = new Set(["ACTION", "EMERGENCY", "JOB_OFFER", "REVIEW_NEEDED", "NEW_CASE"]);
const ACK_MINUTES: Record<string, number> = { EMERGENCY: 15, REVIEW_NEEDED: 240, JOB_OFFER: 1440, ACTION: 1440 };

// Event types, from the prefix of the event key used at each call site.
const EVENT_BY_PREFIX: Record<string, string> = {
  received: "case.received",
  new: "case.new",
  emergency: "case.emergency",
  review: "case.review_needed",
  offer: "offer.received",
  released: "offer.closed",
  declined: "offer.declined",
  expired: "offer.expired",
  "expired-v": "offer.expired",
  accepted: "estimate.decision",
  approved: "estimate.approved",
  rejected: "estimate.rejected",
  "approval-reminder": "estimate.reminder",
  times: "appointment.proposed",
  pick: "appointment.proposed",
  clash: "appointment.clash",
  confirmed: "appointment.confirmed",
  "declined-times": "appointment.declined",
  "visit-cancelled": "appointment.cancelled",
  "appt-reminder": "appointment.reminder",
  started: "repair.started",
  completed: "repair.completed",
  verify: "repair.completed",
  "verify-reminder": "verification.reminder",
  "verify-overdue": "verification.overdue",
  "slot-reminder": "appointment.reminder_to_choose",
  "slot-overdue": "appointment.no_answer",
  "offer-reminder": "offer.reminder",
  overcap: "budget.over_cap",
  "budget-request": "budget.requested",
  "budget-decided": "budget.decided",
  resolved: "case.resolved",
  unresolved: "case.not_fixed",
  reopened: "case.reopened",
  "reopened-r": "case.reopened",
  cancelled: "case.cancelled",
  "closed-unverified": "case.closed_unverified",
  escalated: "case.escalated",
  "ai-escalated": "case.escalated",
  proposal: "agent.suggestion",
  "ai-escalate-suggestion": "agent.suggestion",
  "agent-blocked": "agent.blocked",
  msg: "message.update",
  discovery: "discovery.update",
  handled: "case.handled",
};
export const eventTypeFor = (eventKey: string) => EVENT_BY_PREFIX[eventKey.split(":")[0]] ?? "case.update";

const HOME: Record<Role, string> = { RESIDENT: "/my/cases/", MANAGER: "/ops/cases/", CONTRACTOR: "/jobs/" };
/** A plain app link. Opening it requires signing in; it carries no token and no personal data. */
export const actionPath = (role: Role, caseId: string | null) => (caseId ? `${HOME[role]}${caseId}` : role === "MANAGER" ? "/ops" : role === "CONTRACTOR" ? "/jobs" : "/my");

type Recipient = { id: number; role: Role; email: string | null; emailNotifications: boolean };

/** Why an email will not be sent to this person, or null when it may be. Checked again at send time. */
export function emailBlocker(u: Pick<Recipient, "email" | "emailNotifications">): string | null {
  if (!emailConfig().enabled) return "Email is not configured on this server (no SMTP_HOST), so only the in-app notification was sent.";
  if (!u.email) return "No email address on file.";
  if (!u.emailNotifications) return "Has not turned on email notifications.";
  return null;
}

/**
 * Notifies each recipient once per event: an in-app notification, and an email row when the event warrants it.
 * Returns how many recipients there were (each got the in-app notification).
 */
export async function notify(tx: Tx, userIds: number[], caseId: string | null, eventKey: string, n: Notice): Promise<number> {
  const unique = [...new Set(userIds.filter((id) => Number.isInteger(id)))];
  if (unique.length === 0) return 0;
  const users = (await tx.user.findMany({ where: { id: { in: unique } }, select: { id: true, role: true, email: true, emailNotifications: true } })) as Recipient[];
  const now = new Date();
  const event = n.event ?? eventTypeFor(eventKey);
  const ackMinutes = ACK_MINUTES[n.kind];
  const ackDueAt = n.ackBy === null ? null : (n.ackBy ?? (ackMinutes ? new Date(now.getTime() + ackMinutes * 60_000) : null));
  const wantsEmail = n.email ?? EMAIL_KINDS.has(n.kind);
  const key = `${caseId ?? "none"}:${eventKey}`;
  const rows = users.flatMap((u) => {
    const base = { userId: u.id, caseId, kind: n.kind, eventType: event, title: n.title.slice(0, 200), body: n.body.slice(0, 1000), actionUrl: actionPath(u.role, caseId) };
    const inApp = { ...base, channel: "IN_APP" as const, status: "DELIVERED" as const, sentAt: now, ackRequired: ackDueAt !== null, ackDueAt, dedupeKey: `${key}:${u.id}` };
    if (!wantsEmail) return [inApp];
    const blocked = emailBlocker(u);
    const email = { ...base, channel: "EMAIL" as const, status: blocked ? ("SKIPPED" as const) : ("PENDING" as const), statusNote: blocked, scheduledFor: now, dedupeKey: `${key}:${u.id}:email` };
    return [inApp, email];
  });
  await tx.notification.createMany({ data: rows, skipDuplicates: true });
  return users.length;
}

/** Acting on a case acknowledges the actor's open notifications for it. */
export async function acknowledgeForCase(db: Pick<Tx, "notification">, userId: number, caseId: string) {
  await db.notification.updateMany({ where: { userId, caseId, channel: "IN_APP", ackRequired: true, acknowledgedAt: null }, data: { acknowledgedAt: new Date(), readAt: new Date() } });
}
