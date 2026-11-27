// Deadlines and follow-ups. They are data (timestamps on rows), not in-memory timers, so nothing is lost when the
// server restarts. A pg-boss job calls sweepDeadlines() every minute (see main.wasp); each step is a locked or
// deduplicated write, so running it twice, or on two servers, changes nothing the second time.
//
// Follow-ups are bounded: every reminder has a number in its dedupe key and stops at the property's maxReminders,
// after which a manager is told instead (once). Nothing reminds forever.
import { prisma } from "wasp/server";
import { caseRef } from "../../shared/domain";
import { kickCoordinator } from "../agent/coordinator";
import { flagForReview, kickIntake } from "../agent/intake";
import { idleMinutes, idleReviewDue, voiceIdleMinutes } from "../agent/intakeSafety";
import { deliverNow, type DeliveryResult } from "../notify/email";
import { mark } from "../tracing";
import { kickDiscovery } from "../vendors/discovery";
import { fiberConfig } from "../vendors/fiber";
import { addEvent, fmtWhen, fmtWindow, lockCase, managerIds, notify, SYSTEM, vendorUserIds } from "./engine";
import { expireOffer } from "./flow";

export type SweepResult = {
  offersExpired: number;
  offerReminders: number;
  verificationReminders: number;
  managersAsked: number;
  slotReminders: number;
  slotEscalations: number;
  appointmentReminders: number;
  approvalReminders: number;
  ackEscalations: number;
  coordinatorRequeued: number;
  discoveriesResumed: number;
  discoveriesFailed: number;
  intakeTurnsRequeued: number;
  /** Unfinished chats and calls put in front of a person (the resident stopped, or the call was cut off, before anything was filed). */
  intakeReviews: number;
  email: DeliveryResult | null;
};

export async function sweepDeadlines(now: Date = new Date(), o: { deliverEmail?: boolean } = {}): Promise<SweepResult> {
  const result: SweepResult = {
    offersExpired: 0,
    offerReminders: 0,
    verificationReminders: 0,
    managersAsked: 0,
    slotReminders: 0,
    slotEscalations: 0,
    appointmentReminders: 0,
    approvalReminders: 0,
    ackEscalations: 0,
    coordinatorRequeued: 0,
    discoveriesResumed: 0,
    discoveriesFailed: 0,
    intakeTurnsRequeued: 0,
    intakeReviews: 0,
    email: null,
  };

  // 1. Vendors who did not answer an offer in time.
  const lapsed = await prisma.vendorAssignment.findMany({ where: { status: "OFFERED", respondByAt: { lt: now } }, select: { id: true, caseId: true } });
  for (const row of lapsed) {
    await prisma.$transaction(async (tx) => {
      const c = await lockCase(tx, row.caseId);
      const a = c.assignments.find((x) => x.id === row.id);
      // Re-check under the lock: the vendor may have answered, or the case been cancelled, since the query.
      if (!a || a.status !== "OFFERED" || c.status !== "AWAITING_VENDOR") return;
      await expireOffer(tx, c, a);
      result.offersExpired++;
    });
    await kickCoordinator(row.caseId);
  }

  // 2. Offers past half their response window: one reminder to the vendor (behaviour B: who, by when, what happens).
  const open = await prisma.vendorAssignment.findMany({ where: { status: "OFFERED", respondByAt: { gte: now } }, select: { id: true, caseId: true, offeredAt: true, respondByAt: true, vendorId: true, case: { select: { number: true, title: true } } } });
  for (const a of open) {
    const half = a.offeredAt.getTime() + (a.respondByAt.getTime() - a.offeredAt.getTime()) / 2;
    if (now.getTime() < half) continue;
    const sent = await prisma.$transaction(async (tx) =>
      notify(tx, await vendorUserIds(tx, a.vendorId), a.caseId, `offer-reminder:${a.id}`, {
        kind: "ACTION",
        title: `Reminder: respond to ${caseRef(a.case.number)}`,
        body: `Please accept or decline "${a.case.title}" by ${fmtWhen(a.respondByAt)}. After that the offer expires and the manager assigns someone else.`,
        ackBy: a.respondByAt,
      }),
    );
    if (sent) result.offerReminders++;
  }

  // 3. Residents who have not said whether the work fixed the problem (behaviours E and F).
  const waiting = await prisma.case.findMany({ where: { status: "AWAITING_VERIFICATION", verificationRequestedAt: { not: null } }, select: { id: true } });
  for (const row of waiting) {
    await prisma.$transaction(async (tx) => {
      const c = await lockCase(tx, row.id);
      if (c.status !== "AWAITING_VERIFICATION" || !c.verificationRequestedAt) return;
      const every = c.property.verificationReminderMinutes * 60_000;
      const closeAt = c.verificationRequestedAt.getTime() + c.property.verificationCloseAfterMinutes * 60_000;
      const nextReminderAt = c.verificationRequestedAt.getTime() + (c.verificationReminders + 1) * every;
      if (now.getTime() >= nextReminderAt && nextReminderAt < closeAt && c.verificationReminders < c.property.maxReminders) {
        const n = c.verificationReminders + 1;
        await tx.case.update({ where: { id: c.id }, data: { verificationReminders: n, nextActionDueAt: new Date(Math.min(nextReminderAt + every, closeAt)) } });
        await addEvent(tx, c.id, SYSTEM, { type: "VERIFICATION_REMINDER", message: `Reminder ${n} of ${c.property.maxReminders} sent to ${c.resident.displayName}: please confirm whether the problem is fixed.` });
        await notify(tx, [c.residentId], c.id, `verify-reminder:${n}`, {
          kind: "ACTION",
          title: `Is this fixed? ${c.title}`,
          body: `Reminder ${n} of ${c.property.maxReminders}. Please answer "Yes, resolved" or "No, still having problems". If we do not hear back, your property manager will follow up.`,
          ackBy: new Date(closeAt),
        });
        result.verificationReminders++;
      }
      if (now.getTime() >= closeAt) {
        // The resident still has the case. Managers are told they may now decide; nothing is resolved automatically.
        const asked = await notify(tx, await managerIds(tx, c.propertyId), c.id, "verify-overdue", {
          kind: "ACTION",
          title: `No confirmation from the resident: ${caseRef(c.number)}`,
          body: `${c.verificationReminders} reminder${c.verificationReminders === 1 ? "" : "s"} sent and the waiting period has passed. You can close it as unverified or follow up.`,
        });
        const already = await tx.caseEvent.findFirst({ where: { caseId: c.id, type: "VERIFICATION_OVERDUE" } });
        if (!already) {
          await addEvent(tx, c.id, SYSTEM, { type: "VERIFICATION_OVERDUE", audience: "MANAGEMENT", message: "The resident has not confirmed within the waiting period. A manager may close this as unverified." });
          result.managersAsked += asked > 0 ? 1 : 0;
        }
      }
    });
  }

  // 4. Visit times nobody chose (behaviour C then F): limited reminders to the resident, then the manager is told.
  const choosing = await prisma.vendorAssignment.findMany({
    where: { status: "ACCEPTED", case: { status: { in: ["SCHEDULING", "AWAITING_APPROVAL"] } }, slots: { some: { status: "PROPOSED" } }, NOT: { slots: { some: { status: { in: ["ACCEPTED", "CONFIRMED"] } } } } },
    select: { id: true, caseId: true, case: { select: { number: true, title: true, residentId: true, propertyId: true, property: { select: { residentResponseMinutes: true, maxReminders: true } }, resident: { select: { displayName: true } } } }, slots: { where: { status: "PROPOSED" }, select: { proposedAt: true }, orderBy: { proposedAt: "desc" }, take: 1 } },
  });
  for (const a of choosing) {
    const since = a.slots[0]?.proposedAt;
    if (!since) continue;
    const every = a.case.property.residentResponseMinutes * 60_000;
    const max = a.case.property.maxReminders;
    const due = Math.floor((now.getTime() - since.getTime()) / every); // how many windows have passed
    if (due < 1) continue;
    const stamp = since.getTime();
    if (due <= max) {
      const n = due;
      const sent = await prisma.$transaction(async (tx) =>
        notify(tx, [a.case.residentId], a.caseId, `slot-reminder:${a.id}:${stamp}:${n}`, {
          kind: "ACTION",
          title: `Reminder: choose a visit time for ${a.case.title}`,
          body: `Reminder ${n} of ${max}. Choose one of the proposed times, or tell us none of them work.${n === max ? " If we do not hear back, your property manager will follow up." : ""}`,
          ackBy: new Date(since.getTime() + (max + 1) * every),
        }),
      );
      if (sent) result.slotReminders++;
    } else {
      const told = await prisma.$transaction(async (tx) => {
        const n = await notify(tx, await managerIds(tx, a.case.propertyId), a.caseId, `slot-overdue:${a.id}:${stamp}`, {
          kind: "ACTION",
          title: `No visit time chosen: ${caseRef(a.case.number)}`,
          body: `${a.case.resident.displayName} has not chosen a visit time after ${max} reminder${max === 1 ? "" : "s"}. Follow up with them, or ask the vendor for other times.`,
        });
        const already = await tx.caseEvent.findFirst({ where: { caseId: a.caseId, type: "SLOTS_UNANSWERED", data: { path: ["stamp"], equals: stamp } } });
        if (!already) await addEvent(tx, a.caseId, SYSTEM, { type: "SLOTS_UNANSWERED", audience: "MANAGEMENT", message: `No visit time chosen after ${max} reminder${max === 1 ? "" : "s"}. The manager was asked to follow up.`, data: { stamp } });
        return already ? 0 : n;
      });
      if (told) result.slotEscalations++;
    }
  }

  // 5. Confirmed visits coming up (behaviour D): one reminder to the resident and the contractor.
  const soon = await prisma.appointmentSlot.findMany({
    where: { status: "CONFIRMED", startAt: { gt: now }, case: { status: "SCHEDULED" } },
    select: { id: true, caseId: true, startAt: true, endAt: true, vendorId: true, vendor: { select: { name: true } }, case: { select: { title: true, residentId: true, unit: { select: { label: true } }, property: { select: { appointmentReminderMinutes: true } } } } },
  });
  for (const sl of soon) {
    if (sl.startAt.getTime() - now.getTime() > sl.case.property.appointmentReminderMinutes * 60_000) continue;
    const sent = await prisma.$transaction(async (tx) =>
      notify(tx, [sl.case.residentId, ...(await vendorUserIds(tx, sl.vendorId))], sl.caseId, `appt-reminder:${sl.id}`, {
        kind: "UPDATE",
        email: true,
        title: `Upcoming visit: ${sl.case.title}`,
        body: `${sl.vendor.name}, ${fmtWindow(sl.startAt, sl.endAt)}, unit ${sl.case.unit.label}. If this no longer works, cancel or change it in Relay.`,
      }),
    );
    if (sent) result.appointmentReminders++;
  }

  // 6. Estimates waiting for a manager: one reminder a day, at most three.
  const stale = await prisma.case.findMany({ where: { status: "AWAITING_APPROVAL", statusChangedAt: { lt: new Date(now.getTime() - 24 * 3600_000) } }, select: { id: true, number: true, title: true, propertyId: true, statusChangedAt: true } });
  for (const c of stale) {
    const day = Math.floor((now.getTime() - c.statusChangedAt.getTime()) / (24 * 3600_000));
    if (day > 3) continue;
    const before = await prisma.notification.count({ where: { caseId: c.id, dedupeKey: { startsWith: `${c.id}:approval-reminder:${day}:` } } });
    if (before > 0) continue;
    await prisma.$transaction(async (tx) => {
      await notify(tx, await managerIds(tx, c.propertyId), c.id, `approval-reminder:${day}`, { kind: "ACTION", title: `Still waiting for your approval: ${caseRef(c.number)}`, body: `${c.title}. Day ${day} of waiting.` });
    });
    result.approvalReminders++;
  }

  // 7. Emergencies nobody acknowledged in time: the managers are alerted once more, once per emergency (not once per
  //    recipient), and not at all if one of them has already acknowledged or acted on it. Oldest first; rows already
  //    handled here are marked, so a backlog of old alerts can never crowd out a new emergency.
  const unacked = await prisma.notification.findMany({
    where: { channel: "IN_APP", kind: "EMERGENCY", ackRequired: true, acknowledgedAt: null, escalatedAt: null, ackDueAt: { lt: now }, caseId: { not: null }, case: { status: { notIn: ["RESOLVED", "CANCELLED"] } } },
    select: { caseId: true, dedupeKey: true, title: true, case: { select: { propertyId: true, number: true } } },
    orderBy: { ackDueAt: "asc" },
    take: 100,
  });
  const emergencies = new Map<string, (typeof unacked)[number]>();
  for (const n of unacked) {
    // The in-app key is `${caseId}:${eventKey}:${userId}`: everyone alerted about the same emergency shares the prefix.
    const prefix = n.dedupeKey.slice(0, n.dedupeKey.lastIndexOf(":"));
    if (n.caseId && n.case && !emergencies.has(prefix)) emergencies.set(prefix, n);
  }
  for (const [prefix, n] of [...emergencies].slice(0, 25)) {
    const sameAlert = { caseId: n.caseId, channel: "IN_APP" as const, dedupeKey: { startsWith: `${prefix}:` } };
    const sent = await prisma.$transaction(async (tx) => {
      const handled = await tx.notification.count({ where: { ...sameAlert, acknowledgedAt: { not: null } } });
      await tx.notification.updateMany({ where: { ...sameAlert, escalatedAt: null }, data: { escalatedAt: now } });
      if (handled > 0) return 0;
      const eventKey = prefix.slice(n.caseId!.length + 1);
      return notify(tx, await managerIds(tx, n.case!.propertyId), n.caseId, `ack-overdue:${eventKey}`, { kind: "ACTION", title: `Not yet acknowledged: ${n.title}`, body: `${caseRef(n.case!.number)} was reported as a possible emergency and nobody has acknowledged it.`, ackBy: null });
    });
    if (sent) result.ackEscalations++;
  }

  // 8. Coordinator triggers that were never picked up (a crash between commit and queueing, or a lost job).
  const stuck = await prisma.case.findMany({ where: { agentPendingSince: { lt: new Date(now.getTime() - 90_000) } }, select: { id: true }, take: 25 });
  for (const c of stuck) await kickCoordinator(c.id);
  result.coordinatorRequeued = stuck.length;

  // 9. Discoveries: a queued one whose job was lost is queued again; one interrupted mid-run resumes (using the saved
  //    response if the paid call had already returned) or, after the last attempt, fails with the reason.
  const lost = await prisma.vendorDiscovery.findMany({ where: { status: "QUEUED", updatedAt: { lt: new Date(now.getTime() - 120_000) } }, select: { id: true }, take: 10 });
  for (const d of lost) await kickDiscovery(d.id);
  const interrupted = await prisma.vendorDiscovery.findMany({ where: { status: "RUNNING", startedAt: { lt: new Date(now.getTime() - 5 * 60_000) } }, select: { id: true, attempts: true } });
  for (const d of interrupted) {
    if (d.attempts < fiberConfig().maxAttempts) {
      const back = await prisma.vendorDiscovery.updateMany({ where: { id: d.id, status: "RUNNING" }, data: { status: "QUEUED", errorCode: "interrupted", errorMessage: "The search was interrupted (the server stopped mid-run) and is being resumed." } });
      if (back.count) {
        await kickDiscovery(d.id);
        result.discoveriesResumed++;
      }
    } else {
      const failed = await prisma.vendorDiscovery.updateMany({ where: { id: d.id, status: "RUNNING" }, data: { status: "FAILED", errorCode: "interrupted", errorMessage: `The search was interrupted ${d.attempts} times and was stopped. Add a vendor manually or search again.`, finishedAt: now } });
      result.discoveriesFailed += failed.count;
    }
  }

  // 10. Chat replies that were never produced (a lost job, a restart mid-turn).
  const turns = await prisma.intakeConversation.findMany({ where: { status: "OPEN", pendingSince: { lt: new Date(now.getTime() - 3 * 60_000) } }, select: { id: true }, take: 10 });
  for (const t of turns) await kickIntake(t.id);
  result.intakeTurnsRequeued = turns.length;

  // 10b. The intake safety net: a chat the resident left, or a call that went silent without ending (a closed tab, a
  // crash), before anything was filed goes to the property's managers. One with nothing the resident said is closed
  // instead, so it never blocks this query. A call goes quiet for far less time than a chat before it counts.
  const idle = await prisma.intakeConversation.findMany({
    where: {
      status: "OPEN",
      caseId: null,
      reviewSince: null,
      pendingSince: null,
      OR: [
        { channel: "CHAT", updatedAt: { lt: new Date(now.getTime() - idleMinutes() * 60_000) } },
        { channel: "VOICE", updatedAt: { lt: new Date(now.getTime() - voiceIdleMinutes() * 60_000) } },
      ],
    },
    select: { id: true, channel: true, status: true, caseId: true, reviewSince: true, pendingSince: true, updatedAt: true, messages: true },
    orderBy: { updatedAt: "asc" },
    take: 25,
  });
  for (const c of idle) {
    if (idleReviewDue(c, now)) {
      if (await flagForReview(c.id, c.channel === "VOICE" ? "call_ended" : "unfinished").catch(() => false)) result.intakeReviews++;
    } else await prisma.intakeConversation.updateMany({ where: { id: c.id, status: "OPEN", caseId: null, pendingSince: null, updatedAt: c.updatedAt }, data: { status: "ABANDONED" } });
  }

  // 11. Email: send what is due (retries with backoff live on the rows themselves).
  if (o.deliverEmail !== false) result.email = await deliverNow();

  const { email, ...counts } = result;
  if (Object.values(counts).some((v) => v) || email?.claimed) mark("relay.sweep", { ...counts, emailsClaimed: email?.claimed ?? 0 });
  return result;
}
