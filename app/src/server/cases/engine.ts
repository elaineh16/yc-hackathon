// The case engine: the only code that writes Case.status. Every action
//   1. locks the case row (SELECT ... FOR UPDATE), so two actions on one case never interleave,
//   2. checks the caller may act on this case,
//   3. validates the transition against the shared state machine,
//   4. writes the status, its owner and next action, the history event and the notifications in ONE transaction.
// If any step fails, nothing is saved.
import type { Prisma } from "@prisma/client";
import { HttpError, prisma } from "wasp/server";
import { type Actor, type CaseStatus, managerHandled } from "../../shared/domain";
import { type Action, assertTransition, ownership, TransitionError } from "../../shared/machine";
import { mark } from "../tracing";

export type Tx = Prisma.TransactionClient;

export type ActorCtx = { kind: Actor; userId: number | null; name: string; vendorId: string | null };
export const SYSTEM: ActorCtx = { kind: "SYSTEM", userId: null, name: "Relay", vendorId: null };

export const CASE_INCLUDE = {
  property: true,
  unit: true,
  resident: true,
  assignments: { include: { vendor: true, approval: true, slots: { orderBy: { startAt: "asc" } } }, orderBy: { offeredAt: "asc" } },
} satisfies Prisma.CaseInclude;
export type LoadedCase = Prisma.CaseGetPayload<{ include: typeof CASE_INCLUDE }>;
export type LoadedAssignment = LoadedCase["assignments"][number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
/** "Not found" for anything the caller may not see, so ids never leak which cases exist. */
export const notFound = () => new HttpError(404, "Case not found.");

/** Locks the case for the rest of the transaction and loads it with everything the rules need. */
export async function lockCase(tx: Tx, caseId: unknown): Promise<LoadedCase> {
  if (!isUuid(caseId)) throw notFound();
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Case" WHERE id = ${caseId} FOR UPDATE`;
  if (rows.length === 0) throw notFound();
  return tx.case.findUniqueOrThrow({ where: { id: caseId }, include: CASE_INCLUDE });
}

/** The single offer that is currently open or accepted, if any. */
export const liveAssignment = (c: LoadedCase): LoadedAssignment | null => c.assignments.find((a) => a.status === "OFFERED" || a.status === "ACCEPTED") ?? null;
export const openSlots = (a: LoadedAssignment | null) => (a ? a.slots.filter((s) => s.status === "PROPOSED" || s.status === "ACCEPTED") : []);

type EventInput = {
  type: string;
  message: string;
  fromStatus?: CaseStatus | null;
  toStatus?: CaseStatus | null;
  audience?: "EVERYONE" | "MANAGEMENT" | "VENDOR";
  vendorId?: string | null;
  data?: Prisma.InputJsonValue;
};
export const AGENT: ActorCtx = { kind: "AGENT", userId: null, name: "Relay AI", vendorId: null };

/**
 * Transitions that wake the coordinator. The marker is written in the same transaction as the event, so a crash
 * after commit cannot lose it: the minute sweep re-queues any marker a run has not cleared.
 */
const COORDINATOR_TRIGGERS: Partial<Record<Action, string>> = {
  ROUTE: "READY_FOR_VENDOR",
  ESCALATE: "ESCALATED",
  RESUME: "RESUMED",
  VENDOR_DECLINE: "VENDOR_DECLINED",
  OFFER_EXPIRED: "OFFER_EXPIRED",
  REJECT_SPEND: "ESTIMATE_REJECTED",
  REPORT_UNRESOLVED: "NOT_FIXED",
  REOPEN: "REOPENED",
};
export async function flagForCoordinator(tx: Tx, caseId: string, trigger: string, eventId: number) {
  await tx.case.update({ where: { id: caseId }, data: { agentPendingSince: new Date(), agentPendingTrigger: trigger, agentPendingEventId: eventId } });
}

export async function addEvent(tx: Tx, caseId: string, actor: ActorCtx, e: EventInput): Promise<number> {
  const row = await tx.caseEvent.create({
    data: {
      caseId,
      actorUserId: actor.userId,
      actorRole: actor.kind,
      actorName: actor.name,
      type: e.type,
      message: e.message,
      fromStatus: e.fromStatus ?? null,
      toStatus: e.toStatus ?? null,
      audience: e.audience ?? "EVERYONE",
      vendorId: e.vendorId ?? null,
      data: e.data,
    },
    select: { id: true },
  });
  return row.id;
}

type MoveOptions = EventInput & {
  /** Required only for actions with two possible targets. */
  to?: CaseStatus;
  dueAt?: Date | null;
  /** SCHEDULING is the resident's move when there are windows to choose from, otherwise the contractor's. */
  hasOpenSlots?: boolean;
  patch?: Prisma.CaseUncheckedUpdateInput;
};

/** Performs one state transition. Throws 409 for an invalid transition and 403 for the wrong kind of actor. */
export async function move(tx: Tx, c: LoadedCase, action: Action, actor: ActorCtx, o: Omit<MoveOptions, "type" | "fromStatus" | "toStatus">): Promise<CaseStatus> {
  let to: CaseStatus;
  try {
    to = assertTransition(action, c.status, actor.kind, o.to);
  } catch (e) {
    if (e instanceof TransitionError) {
      throw new HttpError(e.reason === "wrong_actor" ? 403 : 409, e.message, { code: "invalid_transition", action, from: c.status });
    }
    throw e;
  }
  const from = c.status;
  const own = ownership(to, { openSlots: o.hasOpenSlots, managerHandled: managerHandled(c.category) });
  const now = new Date();
  const eventId = await addEvent(tx, c.id, actor, { type: action, message: o.message, fromStatus: from, toStatus: to, audience: o.audience, vendorId: o.vendorId, data: o.data });
  // The coordinator never wakes itself: its own actions are not triggers.
  const trigger = actor.kind === "AGENT" ? undefined : COORDINATOR_TRIGGERS[action];
  await tx.case.update({
    where: { id: c.id },
    data: {
      ...o.patch,
      status: to,
      holder: own.holder,
      nextAction: own.nextAction,
      nextActionDueAt: o.dueAt ?? null,
      statusChangedAt: now,
      ...(trigger ? { agentPendingSince: now, agentPendingTrigger: trigger, agentPendingEventId: eventId } : {}),
    },
  });
  mark("relay.case.transition", { caseId: c.id, action, from, to, actor: actor.kind });
  c.status = to; // keep the loaded copy current so one action can chain two transitions
  return to;
}

/** Re-derives who holds the case when the status stays the same (for example new visit times were proposed). */
export async function refreshOwnership(tx: Tx, c: LoadedCase, hasOpenSlots: boolean, dueAt?: Date | null) {
  const own = ownership(c.status, { openSlots: hasOpenSlots, managerHandled: managerHandled(c.category) });
  await tx.case.update({ where: { id: c.id }, data: { holder: own.holder, nextAction: own.nextAction, ...(dueAt !== undefined ? { nextActionDueAt: dueAt } : {}) } });
}

/** One notification per recipient per event and channel (in-app always; email when warranted). See notify/notify.ts. */
export { notify, type Notice } from "../notify/notify";

export async function managerIds(tx: Tx, propertyId: string): Promise<number[]> {
  const rows = await tx.propertyMembership.findMany({ where: { propertyId, user: { role: "MANAGER" } }, select: { userId: true } });
  return rows.map((r) => r.userId);
}
export async function vendorUserIds(tx: Tx, vendorId: string): Promise<number[]> {
  const rows = await tx.user.findMany({ where: { vendorId, role: "CONTRACTOR" }, select: { id: true } });
  return rows.map((r) => r.id);
}

/** Runs fn in a transaction with the case locked. */
export function withCase<T>(caseId: unknown, fn: (tx: Tx, c: LoadedCase) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => fn(tx, await lockCase(tx, caseId)), { timeout: 15_000 });
}

// ───────── test-only fault injection (armed through /api/test/fault when RELAY_TEST_HOOKS=true) ─────────
const armed = new Map<string, number>();
export const faults = {
  arm: (point: string, times = 1) => armed.set(point, times),
  clear: () => armed.clear(),
  /** Throws once if a test armed this point. A no-op in normal operation. */
  hit(point: string) {
    const left = armed.get(point) ?? 0;
    if (left <= 0) return;
    armed.set(point, left - 1);
    throw new Error(`Injected fault at ${point}`);
  },
};

export const fmtWhen = (d: Date) =>
  new Intl.DateTimeFormat("en-CA", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: process.env.RELAY_TIMEZONE || "America/Toronto" }).format(d);
export const fmtWindow = (start: Date, end: Date) =>
  `${fmtWhen(start)} to ${new Intl.DateTimeFormat("en-CA", { hour: "numeric", minute: "2-digit", timeZone: process.env.RELAY_TIMEZONE || "America/Toronto" }).format(end)}`;
