// Deadlines. They are data (timestamps on rows), not in-memory timers, so nothing is lost when the server restarts.
// A pg-boss job calls sweepDeadlines() every minute (see main.wasp); each step is a locked, idempotent transition,
// so running it twice, or on two servers, changes nothing the second time.
import { prisma } from "wasp/server";
import { caseRef } from "../../shared/domain";
import { kickCoordinator } from "../agent/coordinator";
import { mark } from "../tracing";
import { addEvent, lockCase, managerIds, notify, SYSTEM } from "./engine";
import { expireOffer } from "./flow";

export type SweepResult = { offersExpired: number; verificationReminders: number; managersAsked: number; approvalReminders: number; coordinatorRequeued: number };

export async function sweepDeadlines(now: Date = new Date()): Promise<SweepResult> {
  const result: SweepResult = { offersExpired: 0, verificationReminders: 0, managersAsked: 0, approvalReminders: 0, coordinatorRequeued: 0 };

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

  // 2. Residents who have not said whether the work fixed the problem.
  const waiting = await prisma.case.findMany({ where: { status: "AWAITING_VERIFICATION", verificationRequestedAt: { not: null } }, select: { id: true } });
  for (const row of waiting) {
    await prisma.$transaction(async (tx) => {
      const c = await lockCase(tx, row.id);
      if (c.status !== "AWAITING_VERIFICATION" || !c.verificationRequestedAt) return;
      const every = c.property.verificationReminderMinutes * 60_000;
      const closeAt = c.verificationRequestedAt.getTime() + c.property.verificationCloseAfterMinutes * 60_000;
      const nextReminderAt = c.verificationRequestedAt.getTime() + (c.verificationReminders + 1) * every;
      if (now.getTime() >= nextReminderAt && nextReminderAt < closeAt) {
        const n = c.verificationReminders + 1;
        await tx.case.update({ where: { id: c.id }, data: { verificationReminders: n, nextActionDueAt: new Date(Math.min(nextReminderAt + every, closeAt)) } });
        await addEvent(tx, c.id, SYSTEM, { type: "VERIFICATION_REMINDER", message: `Reminder ${n} sent to ${c.resident.displayName}: please confirm whether the problem is fixed.` });
        await notify(tx, [c.residentId], c.id, `verify-reminder:${n}`, { kind: "ACTION", title: `Is this fixed? ${c.title}`, body: "Please confirm whether the problem is resolved." });
        result.verificationReminders++;
      }
      if (now.getTime() >= closeAt) {
        // The resident still has the case. Managers are told they may now decide; nothing is resolved automatically.
        const asked = await notify(tx, await managerIds(tx, c.propertyId), c.id, "verify-overdue", {
          kind: "ACTION",
          title: `No confirmation from the resident: ${caseRef(c.number)}`,
          body: "The waiting period has passed. You can close it as unverified or follow up.",
        });
        const already = await tx.caseEvent.findFirst({ where: { caseId: c.id, type: "VERIFICATION_OVERDUE" } });
        if (!already) {
          await addEvent(tx, c.id, SYSTEM, { type: "VERIFICATION_OVERDUE", audience: "MANAGEMENT", message: "The resident has not confirmed within the waiting period. A manager may close this as unverified." });
          result.managersAsked += asked > 0 ? 1 : 0;
        }
      }
    });
  }

  // 3. Estimates that have waited a day for a manager.
  const stale = await prisma.case.findMany({ where: { status: "AWAITING_APPROVAL", statusChangedAt: { lt: new Date(now.getTime() - 24 * 3600_000) } }, select: { id: true, number: true, title: true, propertyId: true, statusChangedAt: true } });
  for (const c of stale) {
    const day = Math.floor((now.getTime() - c.statusChangedAt.getTime()) / (24 * 3600_000));
    const before = await prisma.notification.count({ where: { caseId: c.id, dedupeKey: { startsWith: `${c.id}:approval-reminder:${day}:` } } });
    if (before > 0) continue;
    await prisma.$transaction(async (tx) => {
      await notify(tx, await managerIds(tx, c.propertyId), c.id, `approval-reminder:${day}`, { kind: "ACTION", title: `Still waiting for your approval: ${caseRef(c.number)}`, body: c.title });
    });
    result.approvalReminders++;
  }

  // 4. Coordinator triggers that were never picked up (a crash between commit and queueing, or a lost job).
  const stuck = await prisma.case.findMany({ where: { agentPendingSince: { lt: new Date(now.getTime() - 90_000) } }, select: { id: true }, take: 25 });
  for (const c of stuck) await kickCoordinator(c.id);
  result.coordinatorRequeued = stuck.length;

  if (result.offersExpired || result.verificationReminders || result.managersAsked || result.approvalReminders || stuck.length) mark("relay.sweep", { ...result });
  return result;
}
