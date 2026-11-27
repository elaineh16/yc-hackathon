// Every action a manager, contractor or resident can take on a case after intake.
// Pattern: lock the case -> check access -> check the rule -> write through the engine. Repeating an action that
// already took effect returns { repeated: true } and changes nothing; an action that no longer applies is a 409.
import { HttpError, prisma } from "wasp/server";
import { caseRef, type Category, CATEGORIES, CATEGORY_SHORT, formatMoney, type Severity, SEVERITIES } from "../../shared/domain";
import { canPerform } from "../../shared/machine";
import { approvalRequired, overlaps } from "../../shared/triage";
import { assertCaseAccess } from "../access";
import { assertDispatchable } from "../vendors/directory";
import {
  type ActorCtx,
  addEvent,
  flagForCoordinator,
  fmtWhen,
  fmtWindow,
  isUuid,
  liveAssignment,
  type LoadedAssignment,
  type LoadedCase,
  managerIds,
  move,
  notFound,
  notify,
  openSlots,
  refreshOwnership,
  SYSTEM,
  type Tx,
  vendorUserIds,
  withCase,
} from "./engine";

export type Done = { ok: true; repeated: boolean; status: string; caseId: string };
const done = (c: LoadedCase, repeated = false): Done => ({ ok: true, repeated, status: c.status, caseId: c.id });
const text = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const need = (role: ActorCtx["kind"], actor: ActorCtx) => {
  if (actor.kind !== role) throw new HttpError(403, "Your account cannot do that.");
};
const conflict = (message: string, code = "not_applicable") => new HttpError(409, message, { code });
const ref = (c: LoadedCase) => caseRef(c.number);

export type SlotInput = { startAt: string; endAt: string };
function parseSlots(raw: unknown, now: Date): { startAt: Date; endAt: Date }[] {
  if (!Array.isArray(raw)) return [];
  if (raw.length > 5) throw new HttpError(400, "Propose at most five visit times.");
  const out = raw.map((s) => ({ startAt: new Date((s as SlotInput)?.startAt), endAt: new Date((s as SlotInput)?.endAt) }));
  for (const s of out) {
    const minutes = (s.endAt.getTime() - s.startAt.getTime()) / 60_000;
    if (Number.isNaN(minutes)) throw new HttpError(400, "A visit time is not a valid date.");
    if (minutes < 30 || minutes > 12 * 60) throw new HttpError(400, "Each visit window must be between 30 minutes and 12 hours.");
    if (s.startAt.getTime() < now.getTime() - 60_000) throw new HttpError(400, "Visit times must be in the future.");
    if (s.startAt.getTime() > now.getTime() + 90 * 24 * 3600_000) throw new HttpError(400, "Visit times must be within the next 90 days.");
  }
  for (let i = 0; i < out.length; i++) for (let j = i + 1; j < out.length; j++) if (overlaps(out[i].startAt, out[i].endAt, out[j].startAt, out[j].endAt)) throw new HttpError(400, "Proposed visit times overlap each other.");
  return out;
}

/** Cancels whatever is in flight with the current vendor: the offer or accepted job, its open windows, a pending approval. */
/** Ends the live offer or job on a case: slots cancelled, pending approvals void, and the vendor told. */
export async function releaseVendor(tx: Tx, c: LoadedCase, to: "WITHDRAWN" | "CANCELLED" | "REJECTED" | "EXPIRED", why: string): Promise<LoadedAssignment | null> {
  const a = liveAssignment(c);
  if (!a) return null;
  await tx.vendorAssignment.update({ where: { id: a.id }, data: { status: to } });
  await tx.appointmentSlot.updateMany({ where: { assignmentId: a.id, status: { in: ["PROPOSED", "ACCEPTED", "CONFIRMED"] } }, data: { status: "CANCELLED" } });
  await tx.spendApproval.updateMany({ where: { assignmentId: a.id, status: "PENDING" }, data: { status: "VOID" } });
  await notify(tx, await vendorUserIds(tx, a.vendorId), c.id, `released:${a.id}`, { kind: "JOB_CLOSED", title: `${ref(c)} is no longer yours`, body: why });
  a.status = to;
  return a;
}

// ───────────────────────── manager ─────────────────────────

/** A person settles the classification of a report the rules could not place, then routes or escalates it. */
export function reviewTriage(actor: ActorCtx, input: { caseId: string; category: Category; severity: Severity; note?: string }) {
  need("MANAGER", actor);
  if (!(CATEGORIES as readonly string[]).includes(input.category) || !(SEVERITIES as readonly string[]).includes(input.severity)) throw new HttpError(400, "Choose a category and a severity.");
  return withCase(input.caseId, async (tx, c) => {
    await assertCaseAccess(tx, actor, c);
    if (!["TRIAGED", "AWAITING_ASSIGNMENT", "REOPENED"].includes(c.status)) throw conflict(`The classification can no longer be changed (${c.status}).`);
    const note = text(input.note, 300);
    const changed = c.category !== input.category || c.severity !== input.severity || c.needsReview;
    if (!changed && c.status !== "TRIAGED") return done(c, true);
    await tx.case.update({
      where: { id: c.id },
      data: { category: input.category, severity: input.severity, emergency: input.severity === "EMERGENCY", needsReview: false, triageSource: "MANAGER", triageReasons: { push: `${actor.name} set this to ${CATEGORY_SHORT[input.category].toLowerCase()}, ${input.severity.toLowerCase()}.` } },
    });
    await addEvent(tx, c.id, actor, { type: "TRIAGE_REVIEWED", message: `Classified as ${CATEGORY_SHORT[input.category].toLowerCase()}, ${input.severity.toLowerCase()}${note ? `: ${note}` : "."}`, audience: "MANAGEMENT" });
    if (c.status === "TRIAGED") {
      if (input.severity === "EMERGENCY") await move(tx, c, "ESCALATE", actor, { message: "Escalated after review. No routine dispatch." });
      else await move(tx, c, "ROUTE", actor, { message: "Reviewed and ready for a vendor to be assigned." });
    }
    return done(c);
  });
}

export function assignVendor(actor: ActorCtx, input: { caseId: string; vendorId: string; note?: string }) {
  need("MANAGER", actor);
  return withCase(input.caseId, async (tx, c) => {
    await assertCaseAccess(tx, actor, c);
    const live = liveAssignment(c);
    if (live && c.status === "AWAITING_VENDOR") {
      if (live.vendorId === input.vendorId) return { ...done(c, true), vendorHasLogin: true, assignmentId: live.id };
      throw conflict("This case is already offered to another vendor. Withdraw that offer first.", "already_offered");
    }
    return offerVendorTx(tx, c, actor, input.vendorId, input.note);
  });
}

/**
 * Offers the case to a vendor. Shared by the manager's action and the coordinator's autopilot, so both pass the
 * same checks: an allowed transition, an approved vendor, the right trade.
 */
export async function offerVendorTx(tx: Tx, c: LoadedCase, actor: ActorCtx, vendorId: string, rawNote?: string) {
  if (!canPerform("ASSIGN_VENDOR", c.status, actor.kind)) throw conflict(`A vendor cannot be assigned while the case is ${c.status}.`, "invalid_transition");
  if (liveAssignment(c)) throw conflict("This case already has a vendor offer in progress.", "already_offered");
  if (!isUuid(vendorId)) throw new HttpError(400, "Choose a vendor.");
  // Only a vendor approved at this property, for this trade. A discovered business is not a vendor until onboarded.
  const vendor = await assertDispatchable(tx, c, vendorId);
  const respondByAt = new Date(Date.now() + c.property.vendorResponseMinutes * 60_000);
  const note = text(rawNote, 300) || null;
  // offeredById records the person responsible: the manager, or for autopilot the property's first manager on record
  // (the event itself is recorded as Relay AI's). Never the resident: a property without a manager gets no AI offers.
  const offeredById = actor.userId ?? (await managerIds(tx, c.propertyId))[0];
  if (offeredById === undefined) throw conflict("This property has no manager on record, so Relay AI cannot send offers for it.", "no_manager");
  const a = await tx.vendorAssignment.create({ data: { caseId: c.id, vendorId: vendor.id, offeredById, respondByAt, noteToVendor: note } });
  await move(tx, c, "ASSIGN_VENDOR", actor, {
    message: `${actor.kind === "AGENT" ? "Relay AI offered the job" : "Offered"} to ${vendor.name}. They have until ${fmtWhen(respondByAt)} to respond.`,
    dueAt: respondByAt,
    vendorId: vendor.id,
  });
  const recipients = await notify(tx, await vendorUserIds(tx, vendor.id), c.id, `offer:${a.id}`, {
    kind: "JOB_OFFER",
    title: `New job offer: ${c.title}`,
    body: `${ref(c)} at ${c.property.name}, ${c.unit.label}. Please accept or decline by ${fmtWhen(respondByAt)}. If there is no answer by then, the offer expires and the property manager assigns someone else.`,
    ackBy: respondByAt,
  });
  if (recipients === 0) {
    await addEvent(tx, c.id, SYSTEM, { type: "NO_VENDOR_LOGIN", audience: "MANAGEMENT", message: `${vendor.name} has no Relay login, so nobody was notified. Contact them directly or assign another vendor.` });
  }
  return { ...done(c), vendorHasLogin: recipients > 0, assignmentId: a.id, vendorName: vendor.name };
}

export function withdrawOffer(actor: ActorCtx, input: { caseId: string; reason?: string }) {
  need("MANAGER", actor);
  return withCase(input.caseId, async (tx, c) => {
    await assertCaseAccess(tx, actor, c);
    if (c.status === "AWAITING_ASSIGNMENT" && !liveAssignment(c)) return done(c, true);
    const a = liveAssignment(c);
    if (c.status !== "AWAITING_VENDOR" || !a) throw conflict("There is no open offer to withdraw.");
    const reason = text(input.reason, 300);
    await releaseVendor(tx, c, "WITHDRAWN", `The manager withdrew the offer${reason ? `: ${reason}` : "."}`);
    await move(tx, c, "WITHDRAW_OFFER", actor, { message: `Offer to ${a.vendor.name} withdrawn${reason ? `: ${reason}` : "."}`, vendorId: a.vendorId });
    return done(c);
  });
}

/** Approve or reject the spending for the accepted estimate. Approval can confirm a visit the resident already chose. */
export function decideSpend(actor: ActorCtx, input: { caseId: string; approve: boolean; capCents?: number; note?: string }) {
  need("MANAGER", actor);
  return withCase(input.caseId, async (tx, c) => {
    await assertCaseAccess(tx, actor, c);
    const a = liveAssignment(c) ?? c.assignments.filter((x) => x.approval).at(-1) ?? null;
    const approval = a?.approval ?? null;
    if (!a || !approval) throw conflict("There is no estimate waiting for a decision.");
    if (approval.status !== "PENDING" || c.status !== "AWAITING_APPROVAL") {
      const same = (input.approve && approval.status === "APPROVED") || (!input.approve && approval.status === "REJECTED");
      if (same) return done(c, true);
      throw conflict(`This estimate was already ${approval.status.toLowerCase().replace("_", " ")}.`, "already_decided");
    }
    const note = text(input.note, 300) || null;
    if (!input.approve) {
      await tx.spendApproval.update({ where: { id: approval.id }, data: { status: "REJECTED", decidedAt: new Date(), decidedById: actor.userId, note } });
      approval.status = "REJECTED";
      await releaseVendor(tx, c, "REJECTED", `The manager did not approve the estimate${note ? `: ${note}` : "."}`);
      await move(tx, c, "REJECT_SPEND", actor, { message: `Estimate from ${a.vendor.name} rejected${note ? `: ${note}` : "."} The case needs another vendor.`, audience: "MANAGEMENT", vendorId: a.vendorId });
      await notify(tx, [c.residentId], c.id, `rejected:${approval.id}`, { kind: "UPDATE", title: `Update on ${c.title}`, body: "The manager is arranging a different vendor." });
      return done(c);
    }
    // An inspection-first response has no repair price yet: the manager must say how much they approve.
    if (a.estimateType === "INSPECTION_REQUIRED" && input.capCents === undefined) {
      throw new HttpError(400, "This vendor needs to inspect before pricing. Enter the maximum you approve for the inspection and repair.", { code: "cap_required" });
    }
    const cap = input.capCents ?? approval.amountCents;
    if (typeof cap !== "number" || !Number.isInteger(cap) || cap <= 0) throw new HttpError(400, "Enter the maximum amount you approve.", { code: "cap_required" });
    if (approval.amountCents !== null && cap < approval.amountCents) throw new HttpError(400, `The approved maximum (${formatMoney(cap)}) is below the estimate (${formatMoney(approval.amountCents)}).`, { code: "cap_below_estimate" });
    await tx.spendApproval.update({ where: { id: approval.id }, data: { status: "APPROVED", capCents: cap, decidedAt: new Date(), decidedById: actor.userId, note } });
    approval.status = "APPROVED";
    const open = openSlots(a);
    await move(tx, c, "APPROVE_SPEND", actor, {
      message: `${actor.name} approved up to ${formatMoney(cap)} for ${a.vendor.name}${note ? `: ${note}` : "."}`,
      audience: "VENDOR",
      vendorId: a.vendorId,
      hasOpenSlots: open.length > 0,
    });
    await addEvent(tx, c.id, SYSTEM, { type: "SPEND_APPROVED_NOTICE", message: "The repair was approved." });
    await notify(tx, await vendorUserIds(tx, a.vendorId), c.id, `approved:${approval.id}`, { kind: "APPROVED", title: `Approved: ${c.title}`, body: `${ref(c)} is approved up to ${formatMoney(cap)}.` });
    // If the resident already chose a time, everyone required has now agreed: confirm it.
    const chosen = a.slots.find((s) => s.status === "ACCEPTED");
    if (chosen) await confirmSlot(tx, c, a, chosen, SYSTEM);
    else await notify(tx, [c.residentId], c.id, `pick:${approval.id}`, { kind: "ACTION", title: `Choose a visit time for ${c.title}`, body: open.length ? `${a.vendor.name} proposed ${open.length} time${open.length === 1 ? "" : "s"}.` : `${a.vendor.name} will propose times.` });
    return done(c);
  });
}

export function escalateCase(actor: ActorCtx, input: { caseId: string; reason: string }) {
  need("MANAGER", actor);
  const reason = text(input.reason, 300);
  if (reason.length < 3) throw new HttpError(400, "Say why this is being escalated.");
  return withCase(input.caseId, async (tx, c) => {
    await assertCaseAccess(tx, actor, c);
    if (c.status === "ESCALATED") return done(c, true);
    await releaseVendor(tx, c, "CANCELLED", "The case was escalated and is being handled by the property manager.");
    await move(tx, c, "ESCALATE", actor, { message: `Escalated by ${actor.name}: ${reason}` });
    await notify(tx, (await managerIds(tx, c.propertyId)).filter((id) => id !== actor.userId), c.id, `escalated:${Date.now()}`, { kind: "EMERGENCY", title: `Escalated: ${c.title}`, body: `${ref(c)}: ${reason}` });
    return done(c);
  });
}

/** The escalation is under control and the case can go to a vendor through the normal flow. */
export function resumeCase(actor: ActorCtx, input: { caseId: string; note: string; severity?: Severity }) {
  need("MANAGER", actor);
  const note = text(input.note, 300);
  if (note.length < 3) throw new HttpError(400, "Record what was done before resuming.");
  return withCase(input.caseId, async (tx, c) => {
    await assertCaseAccess(tx, actor, c);
    if (c.status === "AWAITING_ASSIGNMENT") return done(c, true);
    const severity = input.severity && (SEVERITIES as readonly string[]).includes(input.severity) && input.severity !== "EMERGENCY" ? input.severity : "URGENT";
    await move(tx, c, "RESUME", actor, { message: `Escalation handled by ${actor.name}: ${note} The case continues as ${severity.toLowerCase()}.`, patch: { severity, needsReview: false, emergency: false } });
    return done(c);
  });
}

/**
 * Handled without a vendor job: an emergency dealt with by emergency services or on-call staff, or a matter the
 * manager handles directly (noise, a lockout let in by staff after checking identity). Only the resident can resolve it.
 */
export function markHandledOutside(actor: ActorCtx, input: { caseId: string; note: string }) {
  need("MANAGER", actor);
  const note = text(input.note, 300);
  if (note.length < 3) throw new HttpError(400, "Record how it was handled.");
  return withCase(input.caseId, async (tx, c) => {
    await assertCaseAccess(tx, actor, c);
    if (c.status === "AWAITING_VERIFICATION") return done(c, true);
    if (liveAssignment(c)) throw conflict("A vendor is working on this case. Withdraw the offer or let the job finish first.", "vendor_on_case");
    const now = new Date();
    const due = new Date(now.getTime() + c.property.verificationReminderMinutes * 60_000);
    await move(tx, c, "HANDLED_OUTSIDE", actor, {
      message: `${c.status === "ESCALATED" ? "Handled outside Relay" : "Handled directly by management"} (${actor.name}): ${note}`,
      dueAt: due,
      patch: { verificationRequestedAt: now, verificationReminders: 0, needsReview: false },
    });
    await notify(tx, [c.residentId], c.id, `verify:${now.getTime()}`, {
      kind: "ACTION",
      title: `Is this sorted? ${c.title}`,
      body: `${actor.name} says this was handled: ${note} Please confirm whether it is resolved, or tell us it is not.`,
      ackBy: due,
    });
    return done(c);
  });
}

/** Policy: a manager may close a case the resident never confirmed, but only after the property's waiting period. */
export function closeUnverified(actor: ActorCtx, input: { caseId: string; note?: string }) {
  need("MANAGER", actor);
  return withCase(input.caseId, async (tx, c) => {
    await assertCaseAccess(tx, actor, c);
    if (c.status === "RESOLVED") return done(c, true);
    if (c.status !== "AWAITING_VERIFICATION" || !c.verificationRequestedAt) throw conflict("Only a case waiting for the resident's confirmation can be closed this way.");
    const allowedAt = new Date(c.verificationRequestedAt.getTime() + c.property.verificationCloseAfterMinutes * 60_000);
    if (Date.now() < allowedAt.getTime()) {
      throw new HttpError(409, `The resident has until ${fmtWhen(allowedAt)} to confirm. A case cannot be resolved without their confirmation before then.`, { code: "verification_window_open", allowedAt: allowedAt.toISOString() });
    }
    const note = text(input.note, 300);
    await move(tx, c, "CLOSE_UNVERIFIED", actor, {
      message: `Closed by ${actor.name} without the resident's confirmation (no answer after ${c.verificationReminders} reminder${c.verificationReminders === 1 ? "" : "s"})${note ? `: ${note}` : "."}`,
      patch: { resolvedAt: new Date(), resolution: "CLOSED_UNVERIFIED" },
    });
    await notify(tx, [c.residentId], c.id, "closed-unverified", { kind: "UPDATE", title: `Closed: ${c.title}`, body: "We did not hear back, so this was closed. Reopen it if the problem is not fixed." });
    return done(c);
  });
}

// ───────────────────────── contractor ─────────────────────────

export type OfferResponse = {
  assignmentId: string;
  accept: boolean;
  declineReason?: string;
  estimateType?: "FIXED" | "INSPECTION_REQUIRED";
  estimateCents?: number | null;
  estimateNotes?: string;
  slots?: SlotInput[];
};

export async function respondToOffer(actor: ActorCtx, input: OfferResponse): Promise<Done> {
  need("CONTRACTOR", actor);
  if (!isUuid(input.assignmentId) || !actor.vendorId) throw notFound();
  const found = await prisma.vendorAssignment.findUnique({ where: { id: input.assignmentId }, select: { caseId: true, vendorId: true } });
  if (!found || found.vendorId !== actor.vendorId) throw notFound();
  const result = await withCase<Done | "expired">(found.caseId, async (tx, c) => {
    const a = c.assignments.find((x) => x.id === input.assignmentId);
    if (!a || a.vendorId !== actor.vendorId) throw notFound();
    if (a.status !== "OFFERED") {
      if ((input.accept && a.status === "ACCEPTED") || (!input.accept && a.status === "DECLINED")) return done(c, true);
      throw conflict(`This offer is no longer open (${a.status.toLowerCase()}).`, "offer_closed");
    }
    const now = new Date();
    if (now > a.respondByAt) {
      // Record the expiry (commit), then tell the contractor outside the transaction.
      await expireOffer(tx, c, a);
      return "expired";
    }
    const managers = await managerIds(tx, c.propertyId);
    if (!input.accept) {
      const reason = text(input.declineReason, 300);
      if (reason.length < 3) throw new HttpError(400, "Say briefly why you are declining.");
      await tx.vendorAssignment.update({ where: { id: a.id }, data: { status: "DECLINED", respondedAt: now, respondedById: actor.userId, declineReason: reason } });
      a.status = "DECLINED";
      await move(tx, c, "VENDOR_DECLINE", actor, { message: `${a.vendor.name} declined: ${reason}`, audience: "VENDOR", vendorId: a.vendorId });
      await addEvent(tx, c.id, SYSTEM, { type: "VENDOR_DECLINED_NOTICE", message: "The vendor could not take this job. The manager is assigning another." });
      await notify(tx, managers, c.id, `declined:${a.id}`, { kind: "ACTION", title: `${a.vendor.name} declined ${ref(c)}`, body: `${reason} Assign another vendor.` });
      return done(c);
    }
    const type = input.estimateType === "INSPECTION_REQUIRED" ? "INSPECTION_REQUIRED" : "FIXED";
    const cents = input.estimateCents ?? null;
    if (type === "FIXED" && (typeof cents !== "number" || !Number.isInteger(cents) || cents <= 0 || cents > 10_000_000)) throw new HttpError(400, "Enter your price estimate, or say that an inspection is needed first.", { code: "estimate_required" });
    if (type === "INSPECTION_REQUIRED" && cents !== null && (!Number.isInteger(cents) || cents < 0 || cents > 10_000_000)) throw new HttpError(400, "The inspection fee is not a valid amount.");
    const slots = parseSlots(input.slots, now);
    if (slots.length === 0) throw new HttpError(400, "Propose at least one visit time.", { code: "slots_required" });
    const notes = text(input.estimateNotes, 500) || null;
    await tx.vendorAssignment.update({ where: { id: a.id }, data: { status: "ACCEPTED", respondedAt: now, respondedById: actor.userId, estimateType: type, estimateCents: cents, estimateNotes: notes } });
    a.status = "ACCEPTED";
    await tx.appointmentSlot.createMany({ data: slots.map((s) => ({ caseId: c.id, assignmentId: a.id, vendorId: a.vendorId, startAt: s.startAt, endAt: s.endAt, proposedById: actor.userId! })) });
    const threshold = c.property.approvalThresholdCents;
    const needsApproval = approvalRequired(type, cents, threshold);
    const approval = await tx.spendApproval.create({
      data: { caseId: c.id, assignmentId: a.id, amountCents: cents, thresholdCents: threshold, ...(needsApproval ? { status: "PENDING" } : { status: "AUTO_APPROVED", capCents: cents, decidedAt: now, note: "Within the property's approval threshold" }) },
    });
    const priced = type === "FIXED" ? `an estimate of ${formatMoney(cents!)}` : `an inspection first${cents ? ` (${formatMoney(cents)} fee)` : ""}`;
    await move(tx, c, "VENDOR_ACCEPT", actor, {
      to: needsApproval ? "AWAITING_APPROVAL" : "SCHEDULING",
      message: `${a.vendor.name} accepted with ${priced} and proposed ${slots.length} visit time${slots.length === 1 ? "" : "s"}.`,
      audience: "VENDOR",
      vendorId: a.vendorId,
      hasOpenSlots: true,
    });
    await addEvent(tx, c.id, SYSTEM, {
      type: needsApproval ? "APPROVAL_REQUESTED" : "APPROVED_BY_POLICY",
      audience: "MANAGEMENT",
      message: needsApproval
        ? type === "FIXED"
          ? `${formatMoney(cents!)} is over this property's ${formatMoney(threshold)} approval threshold: a manager must decide.`
          : "The vendor needs to inspect before pricing, so a manager must approve a maximum."
        : `${formatMoney(cents!)} is within this property's ${formatMoney(threshold)} approval threshold: approved by policy.`,
    });
    await addEvent(tx, c.id, SYSTEM, { type: "VENDOR_ACCEPTED_NOTICE", message: `${a.vendor.name} took the job and proposed visit times.`, vendorId: a.vendorId });
    await notify(tx, managers, c.id, `accepted:${a.id}`, {
      kind: needsApproval ? "ACTION" : "UPDATE",
      title: needsApproval ? `Approval needed: ${c.title}` : `${a.vendor.name} accepted ${ref(c)}`,
      body: needsApproval ? `${a.vendor.name} quoted ${priced}.` : `Estimate ${formatMoney(cents!)} approved by policy.`,
    });
    const answerBy = new Date(now.getTime() + c.property.residentResponseMinutes * 60_000);
    await notify(tx, [c.residentId], c.id, `times:${approval.id}`, {
      kind: "ACTION",
      title: `Choose a visit time for ${c.title}`,
      body: `${a.vendor.name} proposed ${slots.length} time${slots.length === 1 ? "" : "s"}. Choose one, or tell us none of them work, by ${fmtWhen(answerBy)}. If we do not hear back, your property manager will follow up.`,
      ackBy: answerBy,
    });
    return done(c);
  });
  if (result === "expired") throw conflict("This offer expired before you responded.", "offer_expired");
  return result;
}

export function proposeSlots(actor: ActorCtx, input: { caseId: string; slots: SlotInput[] }) {
  need("CONTRACTOR", actor);
  return withCase(input.caseId, async (tx, c) => {
    await assertCaseAccess(tx, actor, c);
    const a = liveAssignment(c);
    if (!a || a.vendorId !== actor.vendorId || a.status !== "ACCEPTED") throw notFound();
    if (c.status !== "SCHEDULING" && c.status !== "AWAITING_APPROVAL") throw conflict(`Visit times cannot be proposed now (${c.status}).`);
    const slots = parseSlots(input.slots, new Date());
    if (slots.length === 0) throw new HttpError(400, "Propose at least one visit time.");
    await tx.appointmentSlot.createMany({ data: slots.map((s) => ({ caseId: c.id, assignmentId: a.id, vendorId: a.vendorId, startAt: s.startAt, endAt: s.endAt, proposedById: actor.userId! })) });
    await addEvent(tx, c.id, actor, { type: "SLOTS_PROPOSED", message: `${a.vendor.name} proposed ${slots.length} more visit time${slots.length === 1 ? "" : "s"}.`, vendorId: a.vendorId });
    if (c.status === "SCHEDULING") await refreshOwnership(tx, c, true);
    await notify(tx, [c.residentId], c.id, `times:${Date.now()}`, { kind: "ACTION", title: `New visit times for ${c.title}`, body: `${a.vendor.name} proposed ${slots.length} time${slots.length === 1 ? "" : "s"}.` });
    return done(c);
  });
}

export function startWork(actor: ActorCtx, input: { caseId: string }) {
  need("CONTRACTOR", actor);
  return withCase(input.caseId, async (tx, c) => {
    await assertCaseAccess(tx, actor, c);
    const a = liveAssignment(c);
    if (!a || a.vendorId !== actor.vendorId) throw notFound();
    if (c.status === "IN_PROGRESS") return done(c, true);
    await tx.vendorAssignment.update({ where: { id: a.id }, data: { startedAt: new Date() } });
    await move(tx, c, "START_WORK", actor, { message: `${a.vendor.name} started work.`, vendorId: a.vendorId });
    await notify(tx, [c.residentId], c.id, `started:${a.id}`, { kind: "UPDATE", title: `Work started: ${c.title}`, body: `${a.vendor.name} is working on it.` });
    return done(c);
  });
}

export function addProgressNote(actor: ActorCtx, input: { caseId: string; note: string }) {
  need("CONTRACTOR", actor);
  const note = text(input.note, 500);
  if (note.length < 3) throw new HttpError(400, "Write a short update.");
  return withCase(input.caseId, async (tx, c) => {
    await assertCaseAccess(tx, actor, c);
    const a = liveAssignment(c);
    if (!a || a.vendorId !== actor.vendorId || !["SCHEDULED", "IN_PROGRESS"].includes(c.status)) throw conflict("Updates can be added once the visit is scheduled or under way.");
    await addEvent(tx, c.id, actor, { type: "PROGRESS_NOTE", message: `${a.vendor.name}: ${note}`, vendorId: a.vendorId });
    return done(c);
  });
}

/** The contractor reports the work finished. This hands the case to the resident; it does not resolve it. */
export function completeWork(actor: ActorCtx, input: { caseId: string; notes: string; finalCostCents?: number | null }) {
  need("CONTRACTOR", actor);
  const notes = text(input.notes, 800);
  if (notes.length < 5) throw new HttpError(400, "Describe what was done.");
  const finalCost = input.finalCostCents ?? null;
  if (finalCost !== null && (!Number.isInteger(finalCost) || finalCost < 0 || finalCost > 10_000_000)) throw new HttpError(400, "The final cost is not a valid amount.");
  return withCase(input.caseId, async (tx, c) => {
    await assertCaseAccess(tx, actor, c);
    const a = liveAssignment(c) ?? c.assignments.find((x) => x.vendorId === actor.vendorId && x.status === "COMPLETED") ?? null;
    if (!a || a.vendorId !== actor.vendorId) throw notFound();
    if (c.status === "AWAITING_VERIFICATION" && a.status === "COMPLETED") return done(c, true);
    const now = new Date();
    await tx.vendorAssignment.update({ where: { id: a.id }, data: { status: "COMPLETED", completedAt: now, completionNotes: notes, finalCostCents: finalCost } });
    await move(tx, c, "COMPLETE_WORK", actor, {
      vendorId: a.vendorId,
      message: `${a.vendor.name} reported the work complete: ${notes}`,
      dueAt: new Date(now.getTime() + c.property.verificationReminderMinutes * 60_000),
      patch: { verificationRequestedAt: now, verificationReminders: 0 },
    });
    a.status = "COMPLETED";
    const managers = await managerIds(tx, c.propertyId);
    const cap = a.approval?.capCents ?? null;
    if (finalCost !== null && cap !== null && finalCost > cap) {
      await addEvent(tx, c.id, SYSTEM, { type: "OVER_APPROVED_CAP", audience: "MANAGEMENT", message: `Final cost ${formatMoney(finalCost)} is over the approved maximum of ${formatMoney(cap)}. Review before paying.` });
      await notify(tx, managers, c.id, `overcap:${a.id}`, { kind: "ACTION", title: `Over the approved amount: ${ref(c)}`, body: `${a.vendor.name} reported ${formatMoney(finalCost)} against an approved ${formatMoney(cap)}.` });
    }
    await notify(tx, [c.residentId], c.id, `verify:${a.id}`, {
      kind: "ACTION",
      title: `Is this fixed? ${c.title}`,
      body: `${a.vendor.name} says the work is done. Please answer "Yes, resolved" or "No, still having problems". If it is not fixed, the case reopens and your property manager follows up.`,
      ackBy: new Date(now.getTime() + c.property.verificationReminderMinutes * 60_000),
    });
    await notify(tx, managers, c.id, `completed:${a.id}`, { kind: "UPDATE", title: `Work reported complete: ${ref(c)}`, body: "Waiting for the resident to confirm." });
    return done(c);
  });
}

/**
 * The contractor asks to raise the approved amount mid-job (for example a part turned out to be needed). Only a
 * manager can decide; Relay's AI can summarise it but never approve it. The case status does not change.
 */
export function requestMoreBudget(actor: ActorCtx, input: { caseId: string; additionalCents: number; reason: string }) {
  need("CONTRACTOR", actor);
  const reason = text(input.reason, 500);
  const extra = input.additionalCents;
  if (!Number.isInteger(extra) || extra <= 0 || extra > 10_000_000) throw new HttpError(400, "Enter the additional amount you need.", { code: "amount_required" });
  if (reason.length < 5) throw new HttpError(400, "Explain what the extra money is for.");
  return withCase(input.caseId, async (tx, c) => {
    await assertCaseAccess(tx, actor, c);
    const a = liveAssignment(c);
    if (!a || a.vendorId !== actor.vendorId || a.status !== "ACCEPTED") throw notFound();
    if (!["SCHEDULING", "SCHEDULED", "IN_PROGRESS"].includes(c.status)) throw conflict(`A budget change cannot be requested now (${c.status}).`);
    const approval = a.approval;
    if (!approval || !["APPROVED", "AUTO_APPROVED"].includes(approval.status)) throw conflict("The original estimate has not been approved yet.", "not_approved_yet");
    if (a.changeRequestStatus === "PENDING") {
      if (a.changeRequestCents === extra) return done(c, true);
      throw conflict("A budget change is already waiting for the manager.", "budget_request_pending");
    }
    const cap = approval.capCents ?? approval.amountCents ?? 0;
    await tx.vendorAssignment.update({ where: { id: a.id }, data: { changeRequestCents: extra, changeRequestReason: reason, changeRequestStatus: "PENDING", changeRequestedAt: new Date(), changeDecidedAt: null, changeDecidedById: null } });
    const eventId = await addEvent(tx, c.id, actor, {
      type: "BUDGET_CHANGE_REQUESTED",
      audience: "VENDOR",
      vendorId: a.vendorId,
      message: `${a.vendor.name} asked for ${formatMoney(extra)} more than the approved ${formatMoney(cap)} (new total ${formatMoney(cap + extra)}): ${reason}`,
    });
    await flagForCoordinator(tx, c.id, "CHANGE_REQUESTED", eventId);
    await notify(tx, await managerIds(tx, c.propertyId), c.id, `budget-request:${a.id}:${Date.now()}`, {
      kind: "ACTION",
      title: `Approval needed: ${a.vendor.name} asks for ${formatMoney(extra)} more on ${ref(c)}`,
      body: `${reason} Approve or decline. Nothing above the approved ${formatMoney(cap)} is authorised until you decide.`,
      ackBy: new Date(Date.now() + 24 * 3600_000),
    });
    return done(c);
  });
}

/** The manager approves or declines a contractor's request for more money. Approval raises the cap; nothing else. */
export function decideBudgetRequest(actor: ActorCtx, input: { caseId: string; approve: boolean; note?: string }) {
  need("MANAGER", actor);
  return withCase(input.caseId, async (tx, c) => {
    await assertCaseAccess(tx, actor, c);
    const a = liveAssignment(c);
    if (!a || !a.approval) throw conflict("There is no budget request on this case.");
    if (a.changeRequestStatus !== "PENDING") {
      const same = (input.approve && a.changeRequestStatus === "APPROVED") || (!input.approve && a.changeRequestStatus === "REJECTED");
      if (same) return done(c, true);
      throw conflict("There is no budget request waiting for a decision.", "no_budget_request");
    }
    const note = text(input.note, 300);
    const extra = a.changeRequestCents ?? 0;
    const cap = a.approval.capCents ?? a.approval.amountCents ?? 0;
    const now = new Date();
    if (input.approve) {
      await tx.spendApproval.update({ where: { id: a.approval.id }, data: { capCents: cap + extra, note: `Raised by ${actor.name} from ${formatMoney(cap)} to ${formatMoney(cap + extra)}${note ? `: ${note}` : ""}` } });
    }
    await tx.vendorAssignment.update({ where: { id: a.id }, data: { changeRequestStatus: input.approve ? "APPROVED" : "REJECTED", changeDecidedAt: now, changeDecidedById: actor.userId } });
    await addEvent(tx, c.id, actor, {
      type: input.approve ? "BUDGET_CHANGE_APPROVED" : "BUDGET_CHANGE_REJECTED",
      audience: "VENDOR",
      vendorId: a.vendorId,
      message: input.approve
        ? `${actor.name} approved ${formatMoney(extra)} more for ${a.vendor.name}: the approved maximum is now ${formatMoney(cap + extra)}${note ? `. ${note}` : "."}`
        : `${actor.name} declined the request for ${formatMoney(extra)} more. The approved maximum stays ${formatMoney(cap)}${note ? `: ${note}` : "."}`,
    });
    await notify(tx, await vendorUserIds(tx, a.vendorId), c.id, `budget-decided:${a.id}:${now.getTime()}`, {
      kind: input.approve ? "APPROVED" : "UPDATE",
      email: true,
      title: input.approve ? `Approved: ${formatMoney(extra)} more for ${ref(c)}` : `Not approved: extra budget for ${ref(c)}`,
      body: input.approve ? `The approved maximum is now ${formatMoney(cap + extra)}.` : `Stay within ${formatMoney(cap)}, or stop and report back to the manager.${note ? ` ${note}` : ""}`,
    });
    return done(c);
  });
}

// ───────────────────────── resident ─────────────────────────

/** Confirms a window: every required party has agreed, and neither the vendor nor the unit has a clash. */
async function confirmSlot(tx: Tx, c: LoadedCase, a: LoadedAssignment, slot: LoadedAssignment["slots"][number], by: ActorCtx) {
  // Serialize confirmations per vendor so two cases cannot take overlapping time at once.
  await tx.$queryRaw`SELECT id FROM "Vendor" WHERE id = ${a.vendorId} FOR UPDATE`;
  const clashes = await tx.appointmentSlot.findMany({
    where: { status: "CONFIRMED", id: { not: slot.id }, startAt: { lt: slot.endAt }, endAt: { gt: slot.startAt }, OR: [{ vendorId: a.vendorId }, { case: { unitId: c.unitId } }] },
    select: { id: true, vendorId: true },
  });
  if (clashes.length > 0) {
    await tx.appointmentSlot.update({ where: { id: slot.id }, data: { status: "UNAVAILABLE" } });
    slot.status = "UNAVAILABLE";
    const stillOpen = openSlots(a).length > 0;
    await addEvent(tx, c.id, SYSTEM, { type: "SLOT_UNAVAILABLE", message: `${fmtWindow(slot.startAt, slot.endAt)} is no longer available${clashes.some((x) => x.vendorId === a.vendorId) ? ` for ${a.vendor.name}` : ""}.`, vendorId: a.vendorId });
    if (c.status === "SCHEDULING") await refreshOwnership(tx, c, stillOpen);
    await notify(tx, await vendorUserIds(tx, a.vendorId), c.id, `clash:${slot.id}`, { kind: "ACTION", title: `Propose new times: ${ref(c)}`, body: "A chosen time clashed with another booking." });
    return false;
  }
  const now = new Date();
  await tx.appointmentSlot.update({ where: { id: slot.id }, data: { status: "CONFIRMED", confirmedAt: now } });
  await tx.appointmentSlot.updateMany({ where: { assignmentId: a.id, id: { not: slot.id }, status: { in: ["PROPOSED", "ACCEPTED"] } }, data: { status: "SUPERSEDED" } });
  for (const s of a.slots) s.status = s.id === slot.id ? "CONFIRMED" : s.status === "PROPOSED" || s.status === "ACCEPTED" ? "SUPERSEDED" : s.status;
  await move(tx, c, "CONFIRM_APPOINTMENT", by, { message: `Visit confirmed with ${a.vendor.name}: ${fmtWindow(slot.startAt, slot.endAt)}.`, dueAt: slot.startAt, vendorId: a.vendorId });
  const body = `${a.vendor.name}, ${fmtWindow(slot.startAt, slot.endAt)}, ${c.unit.label}.`;
  await notify(tx, [...(await vendorUserIds(tx, a.vendorId)), ...(await managerIds(tx, c.propertyId)), c.residentId], c.id, `confirmed:${slot.id}`, { kind: "UPDATE", email: true, title: `Visit confirmed: ${c.title}`, body });
  return true;
}

/** The resident picks one of the proposed windows. It is confirmed at once only if the spending is already settled. */
export async function answerSlot(actor: ActorCtx, input: { slotId: string }): Promise<Done & { confirmed: boolean }> {
  need("RESIDENT", actor);
  if (!isUuid(input.slotId)) throw notFound();
  const found = await prisma.appointmentSlot.findUnique({ where: { id: input.slotId }, select: { caseId: true } });
  if (!found) throw notFound();
  const result = await withCase<(Done & { confirmed: boolean }) | "clash">(found.caseId, async (tx, c) => {
    await assertCaseAccess(tx, actor, c);
    const a = liveAssignment(c);
    const slot = a?.slots.find((s) => s.id === input.slotId);
    if (!a || !slot) throw conflict("That visit time is no longer on offer.", "slot_closed");
    if (slot.status === "CONFIRMED") return { ...done(c, true), confirmed: true };
    if (c.status !== "SCHEDULING" && c.status !== "AWAITING_APPROVAL") throw conflict(`A visit time cannot be chosen now (${c.status}).`);
    if (slot.status !== "PROPOSED" && slot.status !== "ACCEPTED") throw conflict("That visit time is no longer on offer.", "slot_closed");
    if (slot.endAt <= new Date()) throw conflict("That visit time has already passed.", "slot_closed");
    // One choice at a time: picking a new window releases an earlier pick.
    await tx.appointmentSlot.updateMany({ where: { assignmentId: a.id, status: "ACCEPTED", id: { not: slot.id } }, data: { status: "PROPOSED" } });
    for (const s of a.slots) if (s.status === "ACCEPTED" && s.id !== slot.id) s.status = "PROPOSED";
    const settled = a.approval?.status === "APPROVED" || a.approval?.status === "AUTO_APPROVED";
    if (!settled || c.status === "AWAITING_APPROVAL") {
      if (slot.status === "ACCEPTED") return { ...done(c, true), confirmed: false };
      await tx.appointmentSlot.update({ where: { id: slot.id }, data: { status: "ACCEPTED", residentAnsweredAt: new Date() } });
      await addEvent(tx, c.id, actor, { type: "SLOT_CHOSEN", message: `${actor.name} chose ${fmtWindow(slot.startAt, slot.endAt)}. It will be confirmed once the manager approves the estimate.`, vendorId: slot.vendorId });
      return { ...done(c), confirmed: false };
    }
    await tx.appointmentSlot.update({ where: { id: slot.id }, data: { residentAnsweredAt: new Date() } });
    const confirmed = await confirmSlot(tx, c, a, slot, actor);
    // On a clash the window is marked unavailable (committed); the resident is told after the transaction.
    return confirmed ? { ...done(c), confirmed: true } : "clash";
  });
  if (result === "clash") throw conflict("That time was just taken by another booking. Choose another time, or ask for new ones.", "slot_conflict");
  return result;
}

export function declineSlots(actor: ActorCtx, input: { caseId: string; note?: string }) {
  need("RESIDENT", actor);
  return withCase(input.caseId, async (tx, c) => {
    await assertCaseAccess(tx, actor, c);
    const a = liveAssignment(c);
    const open = openSlots(a);
    if (!a || open.length === 0) throw conflict("There are no visit times waiting for your answer.");
    const note = text(input.note, 300);
    await tx.appointmentSlot.updateMany({ where: { id: { in: open.map((s) => s.id) } }, data: { status: "DECLINED", residentAnsweredAt: new Date() } });
    const eventId = await addEvent(tx, c.id, actor, { type: "SLOTS_DECLINED", message: `${actor.name} cannot make the proposed times${note ? `: ${note}` : "."}`, vendorId: a.vendorId });
    await flagForCoordinator(tx, c.id, "TIMES_DECLINED", eventId);
    if (c.status === "SCHEDULING") await refreshOwnership(tx, c, false);
    await notify(tx, await vendorUserIds(tx, a.vendorId), c.id, `declined-times:${Date.now()}`, { kind: "ACTION", title: `Propose new times: ${ref(c)}`, body: note || "The resident cannot make the proposed times." });
    return done(c);
  });
}

/** Only the resident can say the problem is fixed. "Not fixed" reopens the case for the manager. */
export function verifyResolution(actor: ActorCtx, input: { caseId: string; resolved: boolean; note?: string }) {
  need("RESIDENT", actor);
  return withCase(input.caseId, async (tx, c) => {
    await assertCaseAccess(tx, actor, c);
    if (input.resolved && c.status === "RESOLVED" && c.resolution === "VERIFIED_BY_RESIDENT") return done(c, true);
    if (!input.resolved && c.status === "REOPENED") return done(c, true);
    const note = text(input.note, 500);
    const managers = await managerIds(tx, c.propertyId);
    const vendor = c.assignments.filter((x) => x.status === "COMPLETED").at(-1);
    const vendorUsers = vendor ? await vendorUserIds(tx, vendor.vendorId) : [];
    if (input.resolved) {
      await move(tx, c, "VERIFY_RESOLVED", actor, { message: `${actor.name} confirmed the problem is fixed${note ? `: ${note}` : "."}`, patch: { resolvedAt: new Date(), resolution: "VERIFIED_BY_RESIDENT" } });
      await notify(tx, [...managers, ...vendorUsers], c.id, "resolved", { kind: "UPDATE", title: `Resolved: ${c.title}`, body: `${ref(c)} was confirmed fixed by the resident.` });
      return done(c);
    }
    if (note.length < 3) throw new HttpError(400, "Tell us what is still wrong.");
    await move(tx, c, "REPORT_UNRESOLVED", actor, { message: `${actor.name} says the problem is not fixed: ${note}` });
    await notify(tx, [...managers, ...vendorUsers], c.id, `unresolved:${Date.now()}`, { kind: "ACTION", title: `Not fixed: ${c.title}`, body: `${ref(c)}: ${note}` });
    return done(c);
  });
}

// ───────────────────────── shared ─────────────────────────

export function reopenCase(actor: ActorCtx, input: { caseId: string; reason: string }) {
  if (actor.kind !== "RESIDENT" && actor.kind !== "MANAGER") throw new HttpError(403, "Your account cannot do that.");
  const reason = text(input.reason, 500);
  if (reason.length < 3) throw new HttpError(400, "Say what is wrong.");
  return withCase(input.caseId, async (tx, c) => {
    await assertCaseAccess(tx, actor, c);
    if (c.status === "REOPENED") return done(c, true);
    await move(tx, c, "REOPEN", actor, { message: `Reopened by ${actor.name}: ${reason}`, patch: { resolvedAt: null, resolution: null } });
    await notify(tx, (await managerIds(tx, c.propertyId)).filter((id) => id !== actor.userId), c.id, `reopened:${Date.now()}`, { kind: "ACTION", title: `Reopened: ${c.title}`, body: `${ref(c)}: ${reason}` });
    if (actor.kind === "MANAGER") await notify(tx, [c.residentId], c.id, `reopened-r:${Date.now()}`, { kind: "UPDATE", title: `Reopened: ${c.title}`, body: reason });
    return done(c);
  });
}

export function cancelCase(actor: ActorCtx, input: { caseId: string; reason?: string }) {
  if (actor.kind !== "RESIDENT" && actor.kind !== "MANAGER") throw new HttpError(403, "Your account cannot do that.");
  const reason = text(input.reason, 300);
  if (actor.kind === "MANAGER" && reason.length < 3) throw new HttpError(400, "Say why this case is being cancelled.");
  return withCase(input.caseId, async (tx, c) => {
    await assertCaseAccess(tx, actor, c);
    if (c.status === "CANCELLED") return done(c, true);
    const released = liveAssignment(c);
    // Validate first: a cancel that is not allowed must not release the vendor.
    await move(tx, c, "CANCEL", actor, { message: `Cancelled by ${actor.name}${reason ? `: ${reason}` : "."}`, patch: { cancelledAt: new Date(), cancelReason: reason || null } });
    if (released) {
      c.status = "CANCELLED";
      await releaseVendor(tx, c, "CANCELLED", `The case was cancelled${reason ? `: ${reason}` : "."}`);
    }
    const others = actor.kind === "RESIDENT" ? await managerIds(tx, c.propertyId) : [c.residentId];
    await notify(tx, others, c.id, "cancelled", { kind: "UPDATE", title: `Cancelled: ${c.title}`, body: reason || `${ref(c)} was cancelled.` });
    return done(c);
  });
}

/** A confirmed visit is called off; the case goes back to finding a time. */
export function cancelAppointment(actor: ActorCtx, input: { caseId: string; reason: string }) {
  const reason = text(input.reason, 300);
  if (reason.length < 3) throw new HttpError(400, "Say why the visit is being cancelled.");
  return withCase(input.caseId, async (tx, c) => {
    await assertCaseAccess(tx, actor, c);
    const a = liveAssignment(c);
    if (c.status === "SCHEDULING" && a && !a.slots.some((s) => s.status === "CONFIRMED")) return done(c, true);
    const slot = a?.slots.find((s) => s.status === "CONFIRMED");
    if (!a || !slot) throw conflict("There is no confirmed visit to cancel.");
    if (actor.kind === "CONTRACTOR" && a.vendorId !== actor.vendorId) throw notFound();
    await tx.appointmentSlot.update({ where: { id: slot.id }, data: { status: "CANCELLED" } });
    slot.status = "CANCELLED";
    await move(tx, c, "CANCEL_APPOINTMENT", actor, { message: `Visit on ${fmtWindow(slot.startAt, slot.endAt)} cancelled by ${actor.name}: ${reason}`, hasOpenSlots: false });
    const everyone = [...(await vendorUserIds(tx, a.vendorId)), ...(await managerIds(tx, c.propertyId)), c.residentId].filter((id) => id !== actor.userId);
    await notify(tx, everyone, c.id, `visit-cancelled:${slot.id}`, { kind: "ACTION", title: `Visit cancelled: ${c.title}`, body: `${reason} New times are needed.` });
    return done(c);
  });
}

// ───────────────────────── system ─────────────────────────

/** The vendor did not answer in time: the offer lapses and the case returns to the manager. */
export async function expireOffer(tx: Tx, c: LoadedCase, a: LoadedAssignment) {
  await tx.vendorAssignment.update({ where: { id: a.id }, data: { status: "EXPIRED" } });
  a.status = "EXPIRED";
  await move(tx, c, "OFFER_EXPIRED", SYSTEM, { message: `${a.vendor.name} did not respond by ${fmtWhen(a.respondByAt)}. The offer expired and the case is back with the manager.`, audience: "VENDOR", vendorId: a.vendorId });
  await addEvent(tx, c.id, SYSTEM, { type: "OFFER_EXPIRED_NOTICE", message: "The vendor did not respond in time. The manager is assigning another." });
  await notify(tx, await managerIds(tx, c.propertyId), c.id, `expired:${a.id}`, { kind: "ACTION", title: `No response from ${a.vendor.name}`, body: `${ref(c)} needs another vendor.` });
  await notify(tx, await vendorUserIds(tx, a.vendorId), c.id, `expired-v:${a.id}`, { kind: "JOB_CLOSED", title: `Offer expired: ${ref(c)}`, body: "You did not respond in time." });
}
