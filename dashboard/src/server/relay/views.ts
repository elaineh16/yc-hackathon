// Database rows -> the shared view contract (src/shared/relayTypes.ts).
import { prisma } from "wasp/server";
import type {
  ContractorResultView,
  OperatorDashboard,
  StaffStatus,
  StudentStatus,
  TimelineEventView,
  WorkOrderView,
} from "../../shared/relayTypes.js";
import * as D from "./domain.js";

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const include = {
  staffRequest: true,
  contractorResults: { orderBy: { receivedAt: "asc" as const } },
  decision: true,
  appointment: true,
};

async function loadFull(id: string) {
  return prisma.workOrder.findUnique({ where: { id }, include });
}
type Full = NonNullable<Awaited<ReturnType<typeof loadFull>>>;

function toView(w: Full): WorkOrderView {
  const s = w.staffRequest;
  const appointment = w.appointment
    ? {
        contractorName: w.appointment.contractorName,
        arrivalWindow: w.appointment.arrivalWindow,
        arrivalStart: w.appointment.arrivalStart.toISOString(),
        arrivalEnd: w.appointment.arrivalEnd.toISOString(),
        simulated: true as const,
        confirmedAt: w.appointment.confirmedAt.toISOString(),
      }
    : null;
  const recName = w.decision?.contractorName ?? w.contractorResults.find((c) => c.contractorKey === w.recommendedKey)?.name;
  return {
    id: w.id,
    number: w.number,
    createdAt: w.createdAt.toISOString(),
    location: D.locationLabel(w),
    residence: w.residence,
    room: w.room,
    machine: w.machine,
    symptom: w.symptom,
    floorStatus: w.floorStatus as WorkOrderView["floorStatus"],
    reportedErrorCode: w.reportedErrorCode,
    safetyHazard: w.safetyHazard,
    hazardDetails: w.hazardDetails,
    intakeCount: w.intakeCount,
    repairStatus: w.repairStatus as WorkOrderView["repairStatus"],
    repairLabel: D.repairLabel(w.repairStatus, appointment, recName),
    recommendation: w.recommendation,
    staff: s
      ? {
          desk: s.desk,
          status: s.status as StaffStatus,
          priority: s.priority as "NORMAL" | "SAFETY",
          assignedTo: s.assignedTo as "STAFF" | "MANAGER",
          etaMinutes: s.etaMinutes,
          note: s.note,
          label: D.staffLabel(s),
          requestedAt: s.requestedAt.toISOString(),
          acceptedAt: iso(s.acceptedAt),
          retrievedAt: iso(s.retrievedAt),
          unavailableAt: iso(s.unavailableAt),
        }
      : null,
    contractors: w.contractorResults.map(
      (c): ContractorResultView => ({
        contractorKey: c.contractorKey,
        name: c.name,
        outcome: c.outcome as ContractorResultView["outcome"],
        scope: c.scope as ContractorResultView["scope"],
        availability: c.availability,
        priceCents: c.priceCents,
        currency: "CAD",
        priceNote: c.priceNote,
        summary: c.summary,
        simulated: true,
        recommended: c.contractorKey === w.recommendedKey,
        receivedAt: c.receivedAt.toISOString(),
      }),
    ),
    decision: w.decision
      ? {
          status: w.decision.status as "PENDING" | "APPROVED" | "DENIED",
          contractorKey: w.decision.contractorKey,
          contractorName: w.decision.contractorName,
          estimateCents: w.decision.estimateCents,
          estimateNote: w.decision.estimateNote,
          autoApproveLimitCents: w.decision.autoApproveLimitCents,
          approvedCapCents: w.decision.approvedCapCents,
          capNote: w.decision.capNote,
          decidedBy: w.decision.decidedBy,
          note: w.decision.note,
          requestedAt: w.decision.requestedAt.toISOString(),
          decidedAt: iso(w.decision.decidedAt),
        }
      : null,
    appointment,
  };
}

export async function operatorDashboard(advance: (id: string) => Promise<void>): Promise<OperatorDashboard> {
  const latest = await prisma.workOrder.findFirst({ orderBy: { createdAt: "desc" }, select: { id: true } });
  if (latest) await advance(latest.id);
  const [full, events, open] = latest
    ? await Promise.all([
        loadFull(latest.id),
        prisma.timelineEvent.findMany({ where: { workOrderId: latest.id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }),
        prisma.workOrder.count({ where: { openKey: { not: null } } }),
      ])
    : [null, [], 0];
  return {
    workOrder: full
      ? {
          ...toView(full),
          timeline: events.map(
            (e): TimelineEventView => ({
              id: e.id,
              at: e.createdAt.toISOString(),
              lane: e.lane as TimelineEventView["lane"],
              type: e.type,
              actor: e.actor,
              message: e.message,
              simulated: e.simulated,
            }),
          ),
        }
      : null,
    openWorkOrders: open,
    policy: D.policy(),
    serverTime: new Date().toISOString(),
  };
}

/** Only the work order created by this session is visible: the session id is the capability. */
export async function studentStatus(sessionId: string, advance: (id: string) => Promise<void>): Promise<StudentStatus> {
  const session = await prisma.demoSession.findUnique({ where: { id: sessionId } });
  if (!session) return { sessionValid: false, workOrder: null };
  const latest = await prisma.workOrder.findFirst({ where: { sessionId }, orderBy: { createdAt: "desc" }, select: { id: true } });
  if (!latest) return { sessionValid: true, workOrder: null };
  await advance(latest.id);
  const full = (await loadFull(latest.id))!;
  const v = toView(full);
  const events = await prisma.timelineEvent.findMany({
    where: { workOrderId: latest.id, studentMessage: { not: null } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 20,
  });
  const updates = events.map((e) => ({ at: e.createdAt.toISOString(), message: e.studentMessage! }));
  return {
    sessionValid: true,
    workOrder: {
      id: v.id,
      number: v.number,
      location: v.location,
      symptom: v.symptom,
      floorStatus: v.floorStatus,
      reportedErrorCode: v.reportedErrorCode,
      safetyHazard: v.safetyHazard,
      repairStatus: v.repairStatus,
      repairLabel: v.repairLabel,
      recommendation: v.recommendation,
      appointment: v.appointment,
      staffLabel: v.staff?.label ?? D.staffLabel(null),
      staffStatus: v.staff?.status ?? null,
      etaMinutes: v.staff?.etaMinutes ?? null,
      latest: updates[0] ?? null,
      updates,
    },
  };
}
