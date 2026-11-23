// Relay workflow. Every transition is a compare-and-set (updateMany ... where status = expected), so repeated
// clicks, agent retries and concurrent polls can never skip a step or write a second result.
import { HttpError, prisma } from "wasp/server";
import type { Prisma } from "@prisma/client";
import { mark, traced } from "../tracing.js";
import * as D from "./domain.js";

type Db = Prisma.TransactionClient | typeof prisma;

interface EventIn {
  lane: "INTAKE" | "STAFF" | "REPAIR";
  type: string;
  actor: "RELAY" | "STUDENT" | "STAFF" | "MANAGER" | "SYSTEM";
  message: string;
  studentMessage?: string | null;
  simulated?: boolean;
  dedupe?: string; // defaults to the type: one event of each type per work order
}
async function addEvents(db: Db, workOrderId: string, events: EventIn[]) {
  // Events written together share a transaction; 1 ms apart keeps their timeline order stable.
  const base = Date.now();
  const written = await db.timelineEvent.createMany({
    data: events.map((e, i) => ({
      createdAt: new Date(base + i),
      workOrderId,
      lane: e.lane,
      type: e.type,
      actor: e.actor,
      message: e.message,
      studentMessage: e.studentMessage ?? null,
      simulated: e.simulated ?? false,
      dedupeKey: `${workOrderId}:${e.dedupe ?? e.type}`,
    })),
    skipDuplicates: true,
  });
  // Trace a student-visible update only when something new was actually written.
  const forStudent = events.filter((e) => e.studentMessage).map((e) => e.type);
  if (forStudent.length && written.count > 0) mark("relay.student_update.publish", { workOrderId, types: forStudent.join(",") });
}

const isUniqueViolation = (e: unknown) => (e as { code?: string })?.code === "P2002";

// ---------- sessions ----------
export async function createSession() {
  const s = await prisma.demoSession.create({ data: {} });
  return { sessionId: s.id };
}
export async function requireSession(sessionId: unknown) {
  if (typeof sessionId !== "string" || !sessionId) return null;
  return prisma.demoSession.findUnique({ where: { id: sessionId } });
}

// ---------- intake ----------
export class IntakeError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}
export interface IntakeResult {
  workOrderId: string;
  number: number;
  created: boolean;
  duplicate: boolean;
  hazard: boolean;
}

/** Persists the report. Returns only after the transaction commits, so the agent never hears "saved" early. */
export function recordIntake(v: D.IntakeInput): Promise<IntakeResult> {
  const hazard = D.isHazard(v);
  mark("relay.safety.classify", { demoSessionId: v.sessionId, hazard, floorStatus: v.floorStatus, outcome: hazard ? "hazard_escalated" : "normal_flow" });
  return traced("relay.work_order.persist", { demoSessionId: v.sessionId }, () => persistIntake(v), (r) => {
    if (r.created) mark("relay.staff_request.create", { demoSessionId: v.sessionId, workOrderId: r.workOrderId, priority: r.hazard ? "SAFETY" : "NORMAL" });
    return { workOrderId: r.workOrderId, created: r.created, duplicate: r.duplicate };
  });
}

async function persistIntake(v: D.IntakeInput): Promise<IntakeResult> {
  if (!(await requireSession(v.sessionId))) {
    throw new IntakeError(404, "unknown_session", "demo_session_id is not an active session (the demo may have been reset).");
  }
  const openKey = D.openKeyFor(v);
  const fp = D.fingerprint(v);
  const hazard = D.isHazard(v);

  for (let attempt = 0; ; attempt++) {
    try {
      const r = await prisma.$transaction(async (tx) => {
        const existing = await tx.workOrder.findUnique({ where: { openKey } });
        if (existing) return updateExisting(tx, existing, v, fp, hazard);

        const wo = await tx.workOrder.create({
          data: {
            sessionId: v.sessionId,
            openKey,
            residence: v.residence,
            room: v.room,
            machine: v.machine,
            symptom: v.symptom,
            floorStatus: v.floorStatus,
            reportedErrorCode: v.reportedErrorCode,
            safetyHazard: hazard,
            hazardDetails: v.hazardDetails,
            intakeFingerprint: fp,
            conversationId: v.conversationId,
            repairStatus: hazard ? D.REPAIR.ESCALATED : D.REPAIR.OPTIONS_PENDING,
            optionsStartedAt: hazard ? null : new Date(),
            staffRequest: {
              create: { desk: D.deskFor(v.residence), priority: hazard ? "SAFETY" : "NORMAL" },
            },
          },
        });
        const code = v.reportedErrorCode ? `, display shows "${v.reportedErrorCode}" (reported, not a diagnosis)` : "";
        await addEvents(tx, wo.id, [
          {
            lane: "INTAKE",
            type: "intake.saved",
            actor: "RELAY",
            message: `Work order #${wo.number} saved from ${v.source === "test" ? "a typed test report (no voice)" : "voice intake"}: ${D.locationLabel(wo)}. ${v.symptom}. Floor ${v.floorStatus.toLowerCase()}${code}.`,
            studentMessage: "Your report is saved.",
          },
          {
            lane: "STAFF",
            type: "staff.requested",
            actor: "RELAY",
            message: hazard
              ? `SAFETY: asked ${D.deskFor(v.residence)} to attend now. ${v.hazardDetails ?? "Water on the floor reported."} Normal repair flow stopped.`
              : `Asked ${D.deskFor(v.residence)} to help retrieve the clothes.`,
            studentMessage: hazard ? "Residence staff have been alerted to a safety issue." : "Residence staff have been asked to help.",
          },
          ...(hazard
            ? []
            : [
                {
                  lane: "REPAIR" as const,
                  type: "repair.outreach_started",
                  actor: "RELAY" as const,
                  message: "Contacting Bluejay, QuickFix and Metro for repair options (simulated).",
                  studentMessage: "Getting repair options.",
                  simulated: true,
                },
              ]),
        ]);
        return { workOrderId: wo.id, number: wo.number, created: true, duplicate: false, hazard };
      });
      if (r.created && !r.hazard) scheduleSimulation(r.workOrderId);
      return r;
    } catch (e) {
      // Two identical reports raced to create the same open order: the loser retries as an update.
      if (isUniqueViolation(e) && attempt === 0) continue;
      throw e;
    }
  }
}

async function updateExisting(
  tx: Prisma.TransactionClient,
  existing: { id: string; number: number; sessionId: string; intakeFingerprint: string; safetyHazard: boolean; intakeCount: number; repairStatus: string },
  v: D.IntakeInput,
  fp: string,
  hazard: boolean,
): Promise<IntakeResult> {
  // The phone that reported most recently follows the order (e.g. the student reopened the page in a new session).
  if (existing.sessionId !== v.sessionId) {
    await tx.workOrder.update({ where: { id: existing.id }, data: { sessionId: v.sessionId } });
  }
  if (existing.intakeFingerprint === fp) {
    return { workOrderId: existing.id, number: existing.number, created: false, duplicate: true, hazard: existing.safetyHazard };
  }
  const escalate = hazard && !existing.safetyHazard;
  const wo = await tx.workOrder.update({
    where: { id: existing.id },
    data: {
      symptom: v.symptom,
      floorStatus: v.floorStatus,
      reportedErrorCode: v.reportedErrorCode,
      hazardDetails: v.hazardDetails ?? undefined,
      safetyHazard: existing.safetyHazard || hazard,
      intakeFingerprint: fp,
      intakeCount: { increment: 1 },
    },
  });
  await addEvents(tx, wo.id, [
    {
      lane: "INTAKE",
      type: "intake.updated",
      dedupe: `intake.updated:${fp}`,
      actor: "RELAY",
      message: `Repeat report for the same washer updated work order #${wo.number} (report ${wo.intakeCount}).`,
      studentMessage: "Your report was updated.",
    },
  ]);
  if (escalate) {
    await tx.staffRequest.update({ where: { workOrderId: wo.id }, data: { priority: "SAFETY" } });
    // Stop the normal repair flow unless the repair is already confirmed.
    await tx.workOrder.updateMany({
      where: { id: wo.id, repairStatus: { in: [D.REPAIR.OPTIONS_PENDING, D.REPAIR.PENDING_APPROVAL] } },
      data: { repairStatus: D.REPAIR.ESCALATED },
    });
    await tx.managerDecision.updateMany({ where: { workOrderId: wo.id, status: "PENDING" }, data: { status: "DENIED", decidedBy: "SYSTEM", note: "Safety hazard reported", decidedAt: new Date() } });
    await addEvents(tx, wo.id, [
      {
        lane: "STAFF",
        type: "staff.safety_escalated",
        actor: "RELAY",
        message: `SAFETY: ${v.hazardDetails ?? "hazard reported"}. Escalated to ${D.deskFor(v.residence)}; normal repair flow stopped.`,
        studentMessage: "Residence staff have been alerted to a safety issue.",
      },
    ]);
  }
  return { workOrderId: wo.id, number: wo.number, created: false, duplicate: false, hazard: existing.safetyHazard || hazard };
}

// ---------- simulated contractor progression ----------
const timers = new Set<NodeJS.Timeout>();
function scheduleSimulation(workOrderId: string) {
  const step = D.simStepMs();
  for (let i = 1; i <= D.RECOMMEND_STEP; i++) {
    const t = setTimeout(() => {
      timers.delete(t);
      advanceSimulation(workOrderId).catch((e) => console.error("[relay] simulation step failed", e));
    }, i * step + 50);
    timers.add(t);
  }
}

/** Applies every seeded step that is due. Idempotent: timers and polling both call it (and catch up after a restart). */
export async function advanceSimulation(workOrderId: string, now = Date.now()) {
  const wo = await prisma.workOrder.findUnique({ where: { id: workOrderId }, select: { repairStatus: true, optionsStartedAt: true } });
  if (!wo || wo.repairStatus !== D.REPAIR.OPTIONS_PENDING || !wo.optionsStartedAt) return;
  const elapsed = now - wo.optionsStartedAt.getTime();
  const step = D.simStepMs();
  const due = D.SEEDED_RESULTS.filter((r) => elapsed >= r.revealStep * step);
  if (due.length) {
    const inserted = await prisma.contractorResult.createMany({
      data: due.map((r) => ({
        workOrderId,
        contractorKey: r.contractorKey,
        name: r.name,
        outcome: r.outcome,
        scope: r.scope,
        availability: r.availability,
        priceCents: r.priceCents,
        priceNote: r.priceNote,
        summary: r.summary,
        simulated: true,
      })),
      skipDuplicates: true,
    });
    // One span per real insert: polling and timers call this repeatedly, and repeats insert nothing.
    if (inserted.count > 0) {
      mark("relay.contractor_results.seed", { workOrderId, simulated: true, inserted: inserted.count, contractors: due.map((r) => r.contractorKey).join(",") });
    }
    await addEvents(
      prisma,
      workOrderId,
      due.map((r) => ({
        lane: "REPAIR" as const,
        type: `contractor.${r.contractorKey}`,
        actor: "SYSTEM" as const,
        message: `${r.name} (simulated): ${r.summary}`,
        simulated: true,
      })),
    );
  }
  if (elapsed >= D.RECOMMEND_STEP * step) await recommendAndRequestApproval(workOrderId);
}

async function recommendAndRequestApproval(workOrderId: string) {
  const limits = D.policy();
  await prisma.$transaction(async (tx) => {
    const results = await tx.contractorResult.findMany({ where: { workOrderId } });
    if (results.length < D.SEEDED_RESULTS.length) return;
    const rec = D.recommend(results);
    if (!rec) return;
    const moved = await tx.workOrder.updateMany({
      where: { id: workOrderId, repairStatus: D.REPAIR.OPTIONS_PENDING },
      data: { repairStatus: D.REPAIR.RECOMMENDED, recommendedKey: rec.contractorKey, recommendation: rec.text },
    });
    if (moved.count === 0) return; // another caller already did this step
    const chosen = results.find((r) => r.contractorKey === rec.contractorKey)!;
    const approval = D.needsApproval(rec.priceCents, limits.autoApproveLimitCents);
    mark("relay.recommendation.compute", {
      workOrderId,
      recommended: rec.contractorKey,
      estimateCents: rec.priceCents,
      currency: "CAD",
      approvalRequired: approval,
      simulated: true,
    });
    await tx.managerDecision.create({
      data: {
        workOrderId,
        contractorKey: rec.contractorKey,
        contractorName: rec.name,
        estimateCents: rec.priceCents,
        estimateNote: chosen.priceNote ?? "",
        autoApproveLimitCents: limits.autoApproveLimitCents,
        ...(approval
          ? {}
          : { status: "APPROVED", decidedBy: "POLICY", approvedCapCents: rec.priceCents, capNote: "within the auto-approval limit", decidedAt: new Date() }),
      },
    });
    await tx.workOrder.update({
      where: { id: workOrderId },
      data: { repairStatus: approval ? D.REPAIR.PENDING_APPROVAL : D.REPAIR.CONFIRMATION_PENDING },
    });
    await addEvents(tx, workOrderId, [
      { lane: "REPAIR", type: "repair.recommended", actor: "RELAY", message: rec.text, studentMessage: rec.text },
      approval
        ? {
            lane: "REPAIR",
            type: "approval.requested",
            actor: "RELAY",
            message: `${rec.name}'s ${D.fmtMoney(rec.priceCents)} pre-tax estimate exceeds the ${D.fmtMoney(limits.autoApproveLimitCents)} auto-approval threshold. Manager approval required.`,
            studentMessage: "The repair is waiting for manager approval.",
          }
        : {
            lane: "REPAIR",
            type: "approval.auto",
            actor: "SYSTEM",
            message: `${D.fmtMoney(rec.priceCents)} is within the ${D.fmtMoney(limits.autoApproveLimitCents)} auto-approval limit.`,
          },
    ]);
  });
}

// ---------- staff lane ----------
async function staffTransition(
  workOrderId: string,
  from: string[],
  to: string,
  data: Prisma.StaffRequestUpdateManyMutationInput,
  verb: string,
  event: (sr: { desk: string; etaMinutes: number | null; previous: string }) => EventIn,
) {
  return prisma.$transaction(async (tx) => {
    const sr = await tx.staffRequest.findUnique({ where: { workOrderId } });
    if (!sr) throw new HttpError(404, "Work order not found");
    if (sr.status === to) return { ok: true, idempotent: true };
    if (!from.includes(sr.status)) throw new HttpError(409, `Staff request is ${sr.status}; cannot ${verb}.`);
    const moved = await tx.staffRequest.updateMany({ where: { workOrderId, status: sr.status }, data: { ...data, status: to } });
    if (moved.count === 0) throw new HttpError(409, "Staff request changed; refresh and try again.");
    await addEvents(tx, workOrderId, [event({ desk: sr.desk, etaMinutes: (data.etaMinutes as number) ?? sr.etaMinutes, previous: sr.status })]);
    return { ok: true, idempotent: false };
  });
}

export function staffAccept(workOrderId: string, etaMinutes: number) {
  if (!Number.isInteger(etaMinutes) || etaMinutes < 1 || etaMinutes > 240) throw new HttpError(400, "ETA must be 1 to 240 minutes.");
  return staffTransition(workOrderId, [D.STAFF.REQUESTED], D.STAFF.ACCEPTED, { etaMinutes, acceptedAt: new Date() }, "accept", (s) => ({
    lane: "STAFF",
    type: "staff.accepted",
    actor: "STAFF",
    message: `${s.desk} accepted. ETA ${etaMinutes} minutes.`,
    studentMessage: `Staff on the way · ${etaMinutes} minutes`,
  }));
}
export function staffRetrieved(workOrderId: string) {
  return staffTransition(workOrderId, [D.STAFF.ACCEPTED, D.STAFF.UNAVAILABLE], D.STAFF.RETRIEVED, { retrievedAt: new Date() }, "mark retrieved", (s) => ({
    lane: "STAFF",
    type: "staff.retrieved",
    actor: s.previous === D.STAFF.UNAVAILABLE ? "MANAGER" : "STAFF",
    message: `Clothes retrieved${s.previous === D.STAFF.UNAVAILABLE ? " (arranged by the manager)" : ` by ${s.desk}`}. Repair continues separately.`,
    studentMessage: "Clothes retrieved",
  }));
}
export function staffUnavailable(workOrderId: string, reason: string | undefined) {
  const why = reason?.trim().slice(0, 200) || "Staff can't help safely right now";
  return staffTransition(
    workOrderId,
    [D.STAFF.REQUESTED, D.STAFF.ACCEPTED],
    D.STAFF.UNAVAILABLE,
    { unavailableAt: new Date(), assignedTo: "MANAGER", note: why },
    "mark unavailable",
    (s) => ({
      lane: "STAFF",
      type: "staff.unavailable",
      actor: "STAFF",
      message: `${s.desk} unavailable: ${why}. Retrieval referred to the manager.`,
      studentMessage: "Staff can't help right now. The manager is arranging retrieval.",
    }),
  );
}

// ---------- approval and simulated confirmation ----------
export async function approveRepair(workOrderId: string, capCents: number, approver: string, note?: string) {
  const limits = D.policy();
  return prisma.$transaction(async (tx) => {
    const d = await tx.managerDecision.findUnique({ where: { workOrderId } });
    if (!d) throw new HttpError(409, "There is no repair waiting for approval yet.");
    if (d.status === "APPROVED") return { ok: true, idempotent: true };
    if (d.status !== "PENDING") throw new HttpError(409, `This repair was already ${d.status.toLowerCase()}.`);
    const bad = D.validateCap(capCents, d.estimateCents, limits.hardCapCents);
    if (bad) throw new HttpError(400, bad);
    const moved = await tx.managerDecision.updateMany({
      where: { workOrderId, status: "PENDING" },
      data: {
        status: "APPROVED",
        approvedCapCents: capCents,
        capNote: "including taxes and fees, conditional on diagnosis",
        decidedBy: approver,
        note: note?.slice(0, 300) || null,
        decidedAt: new Date(),
      },
    });
    if (moved.count === 0) return { ok: true, idempotent: true };
    const wo = await tx.workOrder.updateMany({
      where: { id: workOrderId, repairStatus: D.REPAIR.PENDING_APPROVAL },
      data: { repairStatus: D.REPAIR.CONFIRMATION_PENDING },
    });
    if (wo.count === 0) throw new HttpError(409, "The repair is not waiting for approval.");
    await addEvents(tx, workOrderId, [
      {
        lane: "REPAIR",
        type: "approval.approved",
        actor: "MANAGER",
        message: `${approver} approved ${d.contractorName} up to ${D.fmtMoney(capCents)} including taxes and fees, conditional on diagnosis (estimate ${D.fmtMoney(d.estimateCents)} before tax).`,
        studentMessage: `The manager approved the repair. Waiting for ${d.contractorName} to confirm.`,
      },
    ]);
    return { ok: true, idempotent: false };
  });
}

export async function denyRepair(workOrderId: string, approver: string, note?: string) {
  return prisma.$transaction(async (tx) => {
    const d = await tx.managerDecision.findUnique({ where: { workOrderId } });
    if (!d) throw new HttpError(409, "There is no repair waiting for approval yet.");
    if (d.status === "DENIED") return { ok: true, idempotent: true };
    if (d.status !== "PENDING") throw new HttpError(409, `This repair was already ${d.status.toLowerCase()}.`);
    const moved = await tx.managerDecision.updateMany({
      where: { workOrderId, status: "PENDING" },
      data: { status: "DENIED", decidedBy: approver, note: note?.slice(0, 300) || null, decidedAt: new Date() },
    });
    if (moved.count === 0) return { ok: true, idempotent: true };
    await tx.workOrder.updateMany({ where: { id: workOrderId, repairStatus: D.REPAIR.PENDING_APPROVAL }, data: { repairStatus: D.REPAIR.DENIED } });
    await addEvents(tx, workOrderId, [
      {
        lane: "REPAIR",
        type: "approval.denied",
        actor: "MANAGER",
        message: `${approver} denied the ${d.contractorName} repair${note ? `: ${note}` : ""}. No appointment will be confirmed.`,
        studentMessage: "Repair not approved yet. The manager will follow up.",
      },
    ]);
    return { ok: true, idempotent: false };
  });
}

/** Server-enforced: refused unless the manager approved. A second call returns the same appointment. */
export async function simulateConfirmation(workOrderId: string) {
  return prisma.$transaction(async (tx) => {
    const wo = await tx.workOrder.findUnique({ where: { id: workOrderId }, include: { decision: true, appointment: true } });
    if (!wo) throw new HttpError(404, "Work order not found");
    if (wo.appointment) return { ok: true, idempotent: true };
    const allowed = wo.decision?.status === "APPROVED";
    mark("relay.confirmation.guard", { workOrderId, allowed, reason: allowed ? "approved" : "approval_required" });
    if (wo.decision?.status !== "APPROVED") throw new HttpError(409, "Manager approval is required before confirmation.");
    const moved = await tx.workOrder.updateMany({
      where: { id: workOrderId, repairStatus: D.REPAIR.CONFIRMATION_PENDING },
      data: { repairStatus: D.REPAIR.CONFIRMED },
    });
    if (moved.count === 0) throw new HttpError(409, `The repair is ${wo.repairStatus}; it cannot be confirmed.`);
    const w = D.arrivalWindow();
    await tx.appointment.create({
      data: {
        workOrderId,
        contractorKey: wo.decision.contractorKey,
        contractorName: wo.decision.contractorName,
        arrivalWindow: w.label,
        arrivalStart: w.start,
        arrivalEnd: w.end,
        simulated: true,
      },
    });
    await addEvents(tx, workOrderId, [
      {
        lane: "REPAIR",
        type: "repair.confirmed",
        actor: "SYSTEM",
        message: `${wo.decision.contractorName} confirmed (simulated): arriving ${w.label}.`,
        studentMessage: `${wo.decision.contractorName} arriving ${w.label} (simulated).`,
        simulated: true,
      },
    ]);
    return { ok: true, idempotent: false };
  });
}

// ---------- reset ----------
/** Wipes every session (cascades to all work-order data). Stale student pages see sessionValid: false. */
export async function resetDemo() {
  for (const t of timers) clearTimeout(t);
  timers.clear();
  const { count } = await prisma.demoSession.deleteMany({});
  return { ok: true, sessionsCleared: count };
}
