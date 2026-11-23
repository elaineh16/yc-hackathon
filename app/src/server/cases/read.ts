// Read side: what each role is allowed to see, shaped for the pages (src/shared/views.ts).
// Managers see everything on their properties. Residents never receive costs or management-only events.
// Contractors receive only cases their vendor is on, only their own assignment, and no other vendor's activity.
import type { Prisma } from "@prisma/client";
import { prisma } from "wasp/server";
import { type Actor, caseRef, type CaseStatus, CASE_STATUSES, CATEGORIES, type Category, HOLDERS, type Holder, type Role, SEVERITIES, type Severity, type TriageSource } from "../../shared/domain";
import { type Details, optionLabel, QUESTIONS } from "../../shared/intake";
import { canPerform } from "../../shared/machine";
import type { ActivityItem, AgentRunView, AiProposalView, AssignmentView, CaseAbilities, CaseAi, CaseDetail, CaseFilters, CaseListItem, CasePage, CommandCenter, EventView, Inbox, JobBoard, JobItem, SlotView, VendorOption } from "../../shared/views";
import { assertCaseAccess, managedPropertyIds, visibleCasesWhere } from "../access";
import { type ActorCtx, CASE_INCLUDE, fmtWindow, isUuid, liveAssignment, type LoadedAssignment, type LoadedCase, notFound, openSlots } from "./engine";

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const firstName = (name: string) => name.split(" ")[0] ?? name;

const LIST_INCLUDE = {
  property: { select: { name: true, address: true } },
  unit: { select: { label: true } },
  resident: { select: { displayName: true } },
  assignments: { where: { status: { in: ["OFFERED", "ACCEPTED", "COMPLETED"] } }, include: { vendor: { select: { name: true } } }, orderBy: { offeredAt: "asc" } },
} satisfies Prisma.CaseInclude;
type ListRow = Prisma.CaseGetPayload<{ include: typeof LIST_INCLUDE }>;

function listItem(c: ListRow | LoadedCase, viewer: Role, now: Date): CaseListItem {
  // Both shapes list assignments oldest first: the newest offered, accepted or completed one is the current vendor.
  const onJob = (c.assignments as { status: string; vendor: { name: string } }[]).filter((a) => a.status === "OFFERED" || a.status === "ACCEPTED" || a.status === "COMPLETED");
  const vendorName = onJob.at(-1)?.vendor.name ?? null;
  const open = c.status !== "RESOLVED" && c.status !== "CANCELLED";
  return {
    id: c.id,
    ref: caseRef(c.number),
    title: c.title,
    category: c.category,
    severity: c.severity,
    status: c.status,
    holder: c.holder,
    nextAction: c.nextAction,
    nextActionDueAt: iso(c.nextActionDueAt),
    overdue: open && !!c.nextActionDueAt && c.nextActionDueAt < now,
    emergency: c.emergency,
    needsReview: c.needsReview,
    propertyName: c.property.name,
    unitLabel: c.unit.label,
    residentName: viewer === "CONTRACTOR" ? firstName(c.resident.displayName) : c.resident.displayName,
    vendorName,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
    statusChangedAt: c.statusChangedAt.toISOString(),
  };
}

const slotView = (s: LoadedAssignment["slots"][number]): SlotView => ({ id: s.id, startAt: s.startAt.toISOString(), endAt: s.endAt.toISOString(), status: s.status, label: fmtWindow(s.startAt, s.endAt) });

function assignmentView(a: LoadedAssignment, viewer: Role): AssignmentView {
  const money = viewer !== "RESIDENT";
  return {
    id: a.id,
    vendorId: a.vendorId,
    vendorName: a.vendor.name,
    vendorPhone: a.vendor.phone,
    status: a.status,
    offeredAt: a.offeredAt.toISOString(),
    respondByAt: a.respondByAt.toISOString(),
    respondedAt: iso(a.respondedAt),
    noteToVendor: viewer === "RESIDENT" ? null : a.noteToVendor,
    declineReason: viewer === "RESIDENT" ? null : a.declineReason,
    estimateType: money ? a.estimateType : null,
    estimateCents: money ? a.estimateCents : null,
    estimateNotes: money ? a.estimateNotes : null,
    finalCostCents: money ? a.finalCostCents : null,
    startedAt: iso(a.startedAt),
    completedAt: iso(a.completedAt),
    completionNotes: a.completionNotes,
    approval:
      money && a.approval
        ? {
            id: a.approval.id,
            status: a.approval.status,
            amountCents: a.approval.amountCents,
            thresholdCents: a.approval.thresholdCents,
            capCents: a.approval.capCents,
            requestedAt: a.approval.requestedAt.toISOString(),
            decidedAt: iso(a.approval.decidedAt),
            note: a.approval.note,
          }
        : null,
    slots: a.slots.map(slotView),
  };
}

function abilities(c: LoadedCase, actor: ActorCtx, now: Date): CaseAbilities {
  const role = actor.kind as Role;
  const live = liveAssignment(c);
  const mine = role === "CONTRACTOR" && live?.vendorId === actor.vendorId ? live : null;
  const open = openSlots(live);
  const can = (action: Parameters<typeof canPerform>[0]) => canPerform(action, c.status, role);
  const closeAt = c.verificationRequestedAt ? new Date(c.verificationRequestedAt.getTime() + c.property.verificationCloseAfterMinutes * 60_000) : null;
  return {
    reviewTriage: role === "MANAGER" && ["TRIAGED", "AWAITING_ASSIGNMENT", "REOPENED"].includes(c.status),
    assignVendor: can("ASSIGN_VENDOR"),
    withdrawOffer: can("WITHDRAW_OFFER"),
    decideSpend: can("APPROVE_SPEND") && live?.approval?.status === "PENDING",
    escalate: role === "MANAGER" && can("ESCALATE"),
    resume: can("RESUME"),
    markHandledOutside: can("HANDLED_OUTSIDE"),
    closeUnverified: can("CLOSE_UNVERIFIED") && !!closeAt && now >= closeAt,
    respondToOffer: !!mine && mine.status === "OFFERED" && now <= mine.respondByAt,
    proposeSlots: !!mine && mine.status === "ACCEPTED" && (c.status === "SCHEDULING" || c.status === "AWAITING_APPROVAL"),
    startWork: !!mine && can("START_WORK"),
    addProgressNote: !!mine && (c.status === "SCHEDULED" || c.status === "IN_PROGRESS"),
    completeWork: !!mine && can("COMPLETE_WORK"),
    answerSlots: role === "RESIDENT" && open.length > 0 && (c.status === "SCHEDULING" || c.status === "AWAITING_APPROVAL"),
    verify: can("VERIFY_RESOLVED"),
    reopen: can("REOPEN"),
    cancel: (role === "RESIDENT" || role === "MANAGER") && can("CANCEL"),
    cancelAppointment: can("CANCEL_APPOINTMENT") && (role !== "CONTRACTOR" || !!mine),
  };
}

function visibleEvent(e: { audience: string; vendorId: string | null }, actor: ActorCtx): boolean {
  if (actor.kind === "MANAGER") return true;
  if (actor.kind === "RESIDENT") return e.audience === "EVERYONE";
  // Contractors: shared events that are not about another vendor, plus their own vendor's events.
  if (e.audience === "EVERYONE") return e.vendorId === null || e.vendorId === actor.vendorId;
  return e.audience === "VENDOR" && e.vendorId === actor.vendorId;
}

export async function caseDetail(actor: ActorCtx, caseId: unknown): Promise<CaseDetail> {
  if (!isUuid(caseId)) throw notFound();
  const c = await prisma.case.findUnique({ where: { id: caseId }, include: CASE_INCLUDE });
  if (!c) throw notFound();
  await assertCaseAccess(prisma, actor, c);
  const role = actor.kind as Role;
  const now = new Date();
  const events = await prisma.caseEvent.findMany({ where: { caseId: c.id }, orderBy: { id: "asc" } });
  const details = (c.details ?? {}) as Details;
  const live = liveAssignment(c);
  const relevant =
    role === "CONTRACTOR"
      ? (c.assignments.filter((a) => a.vendorId === actor.vendorId && ["OFFERED", "ACCEPTED", "COMPLETED"].includes(a.status)).at(-1) ?? null)
      : (live ?? c.assignments.filter((a) => a.status === "COMPLETED").at(-1) ?? null);
  const confirmed = relevant?.slots.find((s) => s.status === "CONFIRMED") ?? null;
  const closeAt = c.verificationRequestedAt ? new Date(c.verificationRequestedAt.getTime() + c.property.verificationCloseAfterMinutes * 60_000) : null;
  return {
    ...listItem(c, role, now),
    viewerRole: role,
    channel: c.channel,
    description: c.description,
    summary: c.summary,
    triageSource: c.triageSource as TriageSource,
    triageReasons: role === "MANAGER" ? c.triageReasons : [],
    answers: QUESTIONS[c.category]
      .filter((q) => details[q.key] !== undefined)
      .map((q) => ({ key: q.key, question: q.label, answer: optionLabel(c.category, q.key, details[q.key]), safety: !!q.safety })),
    permissionToEnter: c.permissionToEnter,
    accessNotes: c.accessNotes,
    propertyAddress: c.property.address,
    emergencyInstructions: c.property.emergencyInstructions,
    assignment: relevant ? assignmentView(relevant, role) : null,
    previousAssignments: role === "MANAGER" ? c.assignments.filter((a) => a.id !== relevant?.id).map((a) => assignmentView(a, role)) : [],
    appointment: confirmed ? slotView(confirmed) : null,
    events: events
      .filter((e) => visibleEvent(e, actor))
      .map((e): EventView => ({ id: e.id, at: e.createdAt.toISOString(), actorRole: e.actorRole as Actor, actorName: e.actorName, type: e.type, message: e.message, fromStatus: e.fromStatus, toStatus: e.toStatus, audience: e.audience })),
    resolution: c.resolution,
    resolvedAt: iso(c.resolvedAt),
    cancelledAt: iso(c.cancelledAt),
    cancelReason: c.cancelReason,
    verification: { requestedAt: iso(c.verificationRequestedAt), reminders: c.verificationReminders, managerMayCloseAt: role === "MANAGER" ? iso(closeAt) : null },
    policy: { approvalThresholdCents: role === "RESIDENT" ? 0 : c.property.approvalThresholdCents },
    can: abilities(c, actor, now),
    ai: role === "MANAGER" ? await caseAi(c) : null,
  };
}

// ───────── AI layer (managers) ─────────
type ProposalRow = { id: string; kind: string; status: string; payload: unknown; rationale: string; policyNote: string; outcome: string | null; createdAt: Date; decidedAt: Date | null };
export function proposalView(p: ProposalRow): AiProposalView {
  const payload = (p.payload ?? {}) as { vendorName?: string; message?: string; reason?: string };
  const summary =
    p.kind === "ASSIGN_VENDOR" ? `Offer the job to ${payload.vendorName ?? "a vendor"}` : p.kind === "MESSAGE_RESIDENT" ? "Send the resident an update" : `Escalate: ${payload.reason ?? ""}`;
  return {
    id: p.id,
    kind: p.kind as AiProposalView["kind"],
    status: p.status as AiProposalView["status"],
    summary,
    vendorName: payload.vendorName ?? null,
    message: payload.message ?? null,
    rationale: p.rationale,
    policyNote: p.policyNote,
    outcome: p.outcome,
    createdAt: p.createdAt.toISOString(),
    decidedAt: iso(p.decidedAt),
  };
}

function stepSummary(s: { tool: string; args?: unknown; ok: boolean; result?: unknown }): string {
  const args = (s.args && typeof s.args === "object" ? s.args : {}) as Record<string, unknown>;
  const r = (s.result && typeof s.result === "object" ? s.result : {}) as Record<string, unknown>;
  const q = typeof args.query === "string" ? `"${args.query.slice(0, 60)}"` : "";
  if (!s.ok) return `${s.tool}: ${String(r.error ?? "failed").slice(0, 160)}`;
  switch (s.tool) {
    case "get_case":
      return "Read the case";
    case "list_vendors":
      return `Listed ${Array.isArray(r.vendors) ? r.vendors.length : 0} eligible vendors`;
    case "search_building_notes":
    case "lookup_building_notes":
      return `Searched the building notes for ${q} (${Array.isArray(r.notes) ? r.notes.length : 0} found)`;
    case "search_past_cases":
      return `Searched past cases for ${q} (${Array.isArray(r.cases) ? r.cases.length : 0} found)`;
    case "find_my_recent_reports":
      return `Checked the resident's recent reports (${Array.isArray(r.reports) ? r.reports.length : 0})`;
    case "note_facts":
      return `Noted: ${Array.isArray(r.recorded) ? r.recorded.join(", ") : "facts"}`;
    case "record_assessment":
      return "Recorded an assessment";
    case "submit_report":
      return `Submitted the report as ${String(r.ref ?? "")}`;
    default:
      return String(r.message ?? s.tool).slice(0, 160);
  }
}

async function caseAi(c: LoadedCase): Promise<CaseAi> {
  const [proposals, runs] = await Promise.all([
    prisma.agentProposal.findMany({ where: { caseId: c.id }, orderBy: { createdAt: "desc" }, take: 12 }),
    prisma.agentRun.findMany({ where: { caseId: c.id }, orderBy: { createdAt: "desc" }, take: 6 }),
  ]);
  return {
    assessment: c.aiAssessment,
    assessedAt: iso(c.aiAssessedAt),
    pending: c.agentPendingSince !== null || runs.some((r) => r.status === "RUNNING"),
    proposals: proposals.map(proposalView),
    runs: runs.map(
      (r): AgentRunView => ({
        id: r.id,
        trigger: r.trigger,
        status: r.status,
        model: r.model,
        createdAt: r.createdAt.toISOString(),
        durationMs: r.durationMs,
        error: r.error,
        finalText: r.finalText,
        steps: (Array.isArray(r.steps) ? (r.steps as { tool: string; args?: unknown; ok: boolean; result?: unknown }[]) : []).map((s) => ({ tool: s.tool, ok: s.ok, summary: stepSummary(s) })),
      }),
    ),
  };
}

const pick = <T extends string>(values: unknown, allowed: readonly T[]): T[] => (Array.isArray(values) ? (values.filter((v) => (allowed as readonly unknown[]).includes(v)) as T[]) : []);

export async function listCases(actor: ActorCtx, raw: CaseFilters | undefined): Promise<CasePage> {
  const f = raw ?? {};
  const now = new Date();
  const where: Prisma.CaseWhereInput = { AND: [await visibleCasesWhere(prisma, actor)] };
  const and = where.AND as Prisma.CaseWhereInput[];
  const status = pick<CaseStatus>(f.status, CASE_STATUSES);
  const category = pick<Category>(f.category, CATEGORIES);
  const severity = pick<Severity>(f.severity, SEVERITIES);
  const holder = pick<Holder>(f.holder, HOLDERS);
  if (status.length) and.push({ status: { in: status } });
  if (category.length) and.push({ category: { in: category } });
  if (severity.length) and.push({ severity: { in: severity } });
  if (holder.length) and.push({ holder: { in: holder } });
  if (f.open === true) and.push({ status: { notIn: ["RESOLVED", "CANCELLED"] } });
  if (f.open === false) and.push({ status: { in: ["RESOLVED", "CANCELLED"] } });
  const q = typeof f.q === "string" ? f.q.trim().slice(0, 80) : "";
  if (q) {
    const number = /^(?:rly-?)?0*(\d{1,9})$/i.exec(q)?.[1];
    and.push({
      OR: [
        ...(number ? [{ number: Number(number) }] : []),
        { title: { contains: q, mode: "insensitive" } },
        { description: { contains: q, mode: "insensitive" } },
        { unit: { label: { contains: q, mode: "insensitive" } } },
        { resident: { displayName: { contains: q, mode: "insensitive" } } },
        { assignments: { some: { vendor: { name: { contains: q, mode: "insensitive" } } } } },
      ],
    });
  }
  const pageSize = Math.min(Math.max(Number(f.pageSize) || 25, 1), 100);
  const page = Math.max(Number(f.page) || 1, 1);
  const orderBy: Prisma.CaseOrderByWithRelationInput[] =
    f.sort === "created" ? [{ createdAt: "desc" }] : f.sort === "severity" ? [{ severity: "asc" }, { statusChangedAt: "asc" }] : f.sort === "due" ? [{ nextActionDueAt: { sort: "asc", nulls: "last" } }] : [{ updatedAt: "desc" }];
  const [rows, total] = await Promise.all([prisma.case.findMany({ where, include: LIST_INCLUDE, orderBy, skip: (page - 1) * pageSize, take: pageSize }), prisma.case.count({ where })]);
  return { items: rows.map((r) => listItem(r, actor.kind as Role, now)), total, page, pageSize };
}

export async function commandCenter(actor: ActorCtx): Promise<CommandCenter> {
  const now = new Date();
  const propertyIds = await managedPropertyIds(prisma, actor.userId!);
  const mine: Prisma.CaseWhereInput = { propertyId: { in: propertyIds } };
  const open: Prisma.CaseWhereInput = { ...mine, status: { notIn: ["RESOLVED", "CANCELLED"] } };
  const pressing: Prisma.CaseWhereInput = { ...open, OR: [{ status: "ESCALATED" }, { severity: "EMERGENCY" }, { nextActionDueAt: { lt: now } }] };
  const order: Prisma.CaseOrderByWithRelationInput[] = [{ severity: "asc" }, { statusChangedAt: "asc" }];
  const by = (holder: Holder) => prisma.case.findMany({ where: { ...open, holder }, include: LIST_INCLUDE, orderBy: order, take: 8 });
  const [openCount, emergencies, overdue, resolvedThisWeek, nManager, nContractor, nResident, attention, onManager, onContractors, onResidents, events, suggestions] = await Promise.all([
    prisma.case.count({ where: open }),
    prisma.case.count({ where: { ...open, OR: [{ status: "ESCALATED" }, { severity: "EMERGENCY" }] } }),
    prisma.case.count({ where: { ...open, nextActionDueAt: { lt: now } } }),
    prisma.case.count({ where: { ...mine, status: "RESOLVED", resolvedAt: { gte: new Date(now.getTime() - 7 * 24 * 3600_000) } } }),
    prisma.case.count({ where: { ...open, holder: "MANAGER" } }),
    prisma.case.count({ where: { ...open, holder: "CONTRACTOR" } }),
    prisma.case.count({ where: { ...open, holder: "RESIDENT" } }),
    prisma.case.findMany({ where: pressing, include: LIST_INCLUDE, orderBy: order, take: 8 }),
    by("MANAGER"),
    by("CONTRACTOR"),
    by("RESIDENT"),
    prisma.caseEvent.findMany({ where: { case: mine }, orderBy: { id: "desc" }, take: 14, include: { case: { select: { number: true, title: true } } } }),
    prisma.agentProposal.findMany({ where: { status: "PENDING", case: open }, orderBy: { createdAt: "desc" }, take: 10, include: { case: { select: { number: true, title: true } } } }),
  ]);
  const item = (r: ListRow) => listItem(r, "MANAGER", now);
  return {
    counts: { open: openCount, emergencies, waitingOnManager: nManager, waitingOnContractors: nContractor, waitingOnResidents: nResident, overdue, resolvedThisWeek, suggestions: suggestions.length },
    suggestions: suggestions.map((p) => ({ ...proposalView(p), caseId: p.caseId, caseRef: caseRef(p.case.number), caseTitle: p.case.title })),
    attention: attention.map(item),
    waitingOnManager: onManager.map(item),
    waitingOnContractors: onContractors.map(item),
    waitingOnResidents: onResidents.map(item),
    recent: events.map(
      (e): ActivityItem => ({
        id: e.id,
        at: e.createdAt.toISOString(),
        actorRole: e.actorRole as Actor,
        actorName: e.actorName,
        type: e.type,
        message: e.message,
        fromStatus: e.fromStatus,
        toStatus: e.toStatus,
        audience: e.audience,
        caseId: e.caseId,
        caseRef: caseRef(e.case.number),
        caseTitle: e.case.title,
      }),
    ),
    generatedAt: now.toISOString(),
  };
}

/** Approved vendors for this case's trade, with enough context for the manager to choose. */
export async function eligibleVendors(actor: ActorCtx, caseId: unknown): Promise<VendorOption[]> {
  if (!isUuid(caseId)) throw notFound();
  const c = await prisma.case.findUnique({ where: { id: caseId }, include: CASE_INCLUDE });
  if (!c) throw notFound();
  await assertCaseAccess(prisma, actor, c);
  const vendors = await prisma.vendor.findMany({
    where: { approved: true, ...(c.category === "OTHER" ? {} : { trades: { has: c.category } }) },
    include: { _count: { select: { users: true } }, assignments: { where: { status: { in: ["OFFERED", "ACCEPTED"] } }, select: { id: true } } },
    orderBy: { name: "asc" },
  });
  const before = new Set(c.assignments.filter((a) => ["DECLINED", "EXPIRED", "WITHDRAWN", "REJECTED"].includes(a.status)).map((a) => a.vendorId));
  return vendors.map((v) => ({ id: v.id, name: v.name, trades: v.trades, phone: v.phone, openJobs: v.assignments.length, hasLogin: v._count.users > 0, previouslyOnCase: before.has(v.id) }));
}

export async function jobBoard(actor: ActorCtx): Promise<JobBoard> {
  const board: JobBoard = { offers: [], active: [], done: [] };
  if (!actor.vendorId) return board;
  const now = new Date();
  const rows = await prisma.vendorAssignment.findMany({
    where: { vendorId: actor.vendorId, status: { in: ["OFFERED", "ACCEPTED", "COMPLETED"] } },
    include: { approval: true, slots: { orderBy: { startAt: "asc" } }, case: { include: LIST_INCLUDE } },
    orderBy: { offeredAt: "desc" },
    take: 100,
  });
  for (const a of rows) {
    const confirmed = a.slots.find((s) => s.status === "CONFIRMED");
    const job: JobItem = {
      ...listItem(a.case, "CONTRACTOR", now),
      assignmentId: a.id,
      assignmentStatus: a.status,
      respondByAt: a.respondByAt.toISOString(),
      estimateCents: a.estimateCents,
      approvalStatus: a.approval?.status ?? null,
      appointment: confirmed ? slotView(confirmed) : null,
      propertyAddress: a.case.property.address,
    };
    if (a.status === "OFFERED") board.offers.push(job);
    else if (a.status === "ACCEPTED") board.active.push(job);
    else board.done.push(job);
  }
  return board;
}

export async function inbox(actor: ActorCtx): Promise<Inbox> {
  const [rows, unread] = await Promise.all([
    prisma.notification.findMany({ where: { userId: actor.userId! }, orderBy: { createdAt: "desc" }, take: 30 }),
    prisma.notification.count({ where: { userId: actor.userId!, readAt: null } }),
  ]);
  return { items: rows.map((n) => ({ id: n.id, at: n.createdAt.toISOString(), kind: n.kind, title: n.title, body: n.body, caseId: n.caseId, read: n.readAt !== null })), unread };
}

export async function markRead(actor: ActorCtx, ids?: string[]) {
  const where = { userId: actor.userId!, readAt: null, ...(Array.isArray(ids) && ids.length ? { id: { in: ids.filter(isUuid) } } : {}) };
  const r = await prisma.notification.updateMany({ where, data: { readAt: new Date() } });
  return { marked: r.count };
}
