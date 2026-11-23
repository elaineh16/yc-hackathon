// The case state machine. Every status change in the product goes through assertTransition() on the server
// (src/server/cases/engine.ts); nothing else is allowed to write Case.status. See docs/workflow.md.
import type { Actor, CaseStatus, Holder } from "./domain";

export type Action =
  | "TRIAGE"
  | "ROUTE"
  | "ESCALATE"
  | "RESUME"
  | "HANDLED_OUTSIDE"
  | "ASSIGN_VENDOR"
  | "WITHDRAW_OFFER"
  | "VENDOR_DECLINE"
  | "OFFER_EXPIRED"
  | "VENDOR_ACCEPT"
  | "APPROVE_SPEND"
  | "REJECT_SPEND"
  | "CONFIRM_APPOINTMENT"
  | "CANCEL_APPOINTMENT"
  | "START_WORK"
  | "COMPLETE_WORK"
  | "VERIFY_RESOLVED"
  | "REPORT_UNRESOLVED"
  | "CLOSE_UNVERIFIED"
  | "REOPEN"
  | "CANCEL";

type Rule = { from: readonly CaseStatus[]; to: readonly CaseStatus[]; by: readonly Actor[] };

export const TRANSITIONS: Record<Action, Rule> = {
  TRIAGE: { from: ["NEW"], to: ["TRIAGED"], by: ["SYSTEM"] },
  // Automatic when triage is confident and the category is supported; otherwise a manager routes it after review.
  ROUTE: { from: ["TRIAGED"], to: ["AWAITING_ASSIGNMENT"], by: ["SYSTEM", "MANAGER"] },
  ESCALATE: {
    from: ["TRIAGED", "AWAITING_ASSIGNMENT", "AWAITING_VENDOR", "AWAITING_APPROVAL", "SCHEDULING", "SCHEDULED", "AWAITING_VERIFICATION", "REOPENED"],
    to: ["ESCALATED"],
    by: ["SYSTEM", "MANAGER", "AGENT"],
  },
  RESUME: { from: ["ESCALATED"], to: ["AWAITING_ASSIGNMENT"], by: ["MANAGER"] },
  // The emergency was dealt with outside Relay (emergency services, on-call staff): ask the resident to confirm.
  HANDLED_OUTSIDE: { from: ["ESCALATED"], to: ["AWAITING_VERIFICATION"], by: ["MANAGER"] },
  // AGENT only when the property turned on autopilot for routine cases (checked by the coordinator's policy).
  ASSIGN_VENDOR: { from: ["AWAITING_ASSIGNMENT", "REOPENED"], to: ["AWAITING_VENDOR"], by: ["MANAGER", "AGENT"] },
  WITHDRAW_OFFER: { from: ["AWAITING_VENDOR"], to: ["AWAITING_ASSIGNMENT"], by: ["MANAGER"] },
  VENDOR_DECLINE: { from: ["AWAITING_VENDOR"], to: ["AWAITING_ASSIGNMENT"], by: ["CONTRACTOR"] },
  OFFER_EXPIRED: { from: ["AWAITING_VENDOR"], to: ["AWAITING_ASSIGNMENT"], by: ["SYSTEM"] },
  // Over the approval threshold (or inspection only) -> AWAITING_APPROVAL; otherwise policy approves it -> SCHEDULING.
  VENDOR_ACCEPT: { from: ["AWAITING_VENDOR"], to: ["AWAITING_APPROVAL", "SCHEDULING"], by: ["CONTRACTOR"] },
  APPROVE_SPEND: { from: ["AWAITING_APPROVAL"], to: ["SCHEDULING"], by: ["MANAGER"] },
  REJECT_SPEND: { from: ["AWAITING_APPROVAL"], to: ["AWAITING_ASSIGNMENT"], by: ["MANAGER"] },
  // The resident accepts a proposed window once spending is settled; the system confirms a window the resident
  // had already accepted when the manager's approval arrives.
  CONFIRM_APPOINTMENT: { from: ["SCHEDULING"], to: ["SCHEDULED"], by: ["RESIDENT", "SYSTEM"] },
  CANCEL_APPOINTMENT: { from: ["SCHEDULED"], to: ["SCHEDULING"], by: ["RESIDENT", "CONTRACTOR", "MANAGER"] },
  START_WORK: { from: ["SCHEDULED"], to: ["IN_PROGRESS"], by: ["CONTRACTOR"] },
  // A contractor can only hand the case to the resident. It cannot resolve it.
  COMPLETE_WORK: { from: ["IN_PROGRESS"], to: ["AWAITING_VERIFICATION"], by: ["CONTRACTOR"] },
  VERIFY_RESOLVED: { from: ["AWAITING_VERIFICATION"], to: ["RESOLVED"], by: ["RESIDENT"] },
  REPORT_UNRESOLVED: { from: ["AWAITING_VERIFICATION"], to: ["REOPENED"], by: ["RESIDENT"] },
  // Only after the property's verification window has passed with no answer (checked by the engine).
  CLOSE_UNVERIFIED: { from: ["AWAITING_VERIFICATION"], to: ["RESOLVED"], by: ["MANAGER"] },
  REOPEN: { from: ["RESOLVED"], to: ["REOPENED"], by: ["RESIDENT", "MANAGER"] },
  CANCEL: {
    from: ["NEW", "TRIAGED", "AWAITING_ASSIGNMENT", "AWAITING_VENDOR", "AWAITING_APPROVAL", "SCHEDULING", "SCHEDULED", "ESCALATED", "REOPENED"],
    to: ["CANCELLED"],
    by: ["RESIDENT", "MANAGER"],
  },
};

export class TransitionError extends Error {
  constructor(
    public action: Action,
    public from: CaseStatus,
    public reason: "wrong_state" | "wrong_actor" | "wrong_target",
    message: string,
  ) {
    super(message);
  }
}

/** Returns the target status, or throws TransitionError. `to` is required only when the action has two targets. */
export function assertTransition(action: Action, from: CaseStatus, by: Actor, to?: CaseStatus): CaseStatus {
  const rule = TRANSITIONS[action];
  if (!rule.by.includes(by)) throw new TransitionError(action, from, "wrong_actor", `${by} cannot perform ${action}.`);
  if (!rule.from.includes(from)) throw new TransitionError(action, from, "wrong_state", `${action} is not allowed while the case is ${from}.`);
  const target = to ?? (rule.to.length === 1 ? rule.to[0] : undefined);
  if (!target || !rule.to.includes(target)) throw new TransitionError(action, from, "wrong_target", `${action} cannot move a case to ${to ?? "an unspecified status"}.`);
  return target;
}

export const canPerform = (action: Action, from: CaseStatus, by: Actor) => TRANSITIONS[action].by.includes(by) && TRANSITIONS[action].from.includes(from);

/** Who holds the case in each status, and what they are expected to do next. */
export function ownership(status: CaseStatus, facts: { openSlots?: boolean } = {}): { holder: Holder; nextAction: string } {
  switch (status) {
    case "NEW":
      return { holder: "SYSTEM", nextAction: "Triage the report" };
    case "TRIAGED":
      return { holder: "MANAGER", nextAction: "Review the report and route it" };
    case "AWAITING_ASSIGNMENT":
      return { holder: "MANAGER", nextAction: "Assign an approved vendor" };
    case "AWAITING_VENDOR":
      return { holder: "CONTRACTOR", nextAction: "Respond to the job offer" };
    case "AWAITING_APPROVAL":
      return { holder: "MANAGER", nextAction: "Approve or reject the estimate" };
    case "SCHEDULING":
      return facts.openSlots ? { holder: "RESIDENT", nextAction: "Choose a visit time" } : { holder: "CONTRACTOR", nextAction: "Propose visit times" };
    case "SCHEDULED":
      return { holder: "CONTRACTOR", nextAction: "Carry out the visit" };
    case "IN_PROGRESS":
      return { holder: "CONTRACTOR", nextAction: "Finish the work and report back" };
    case "AWAITING_VERIFICATION":
      return { holder: "RESIDENT", nextAction: "Confirm whether the problem is fixed" };
    case "ESCALATED":
      return { holder: "MANAGER", nextAction: "Handle the escalation" };
    case "REOPENED":
      return { holder: "MANAGER", nextAction: "Review and assign a vendor again" };
    case "RESOLVED":
    case "CANCELLED":
      return { holder: "NONE", nextAction: "" };
  }
}

/** The main path, in order, for progress displays. Side states (escalated, cancelled, reopened) are shown separately. */
export const MAIN_PATH: readonly CaseStatus[] = [
  "NEW",
  "TRIAGED",
  "AWAITING_ASSIGNMENT",
  "AWAITING_VENDOR",
  "AWAITING_APPROVAL",
  "SCHEDULING",
  "SCHEDULED",
  "IN_PROGRESS",
  "AWAITING_VERIFICATION",
  "RESOLVED",
];
