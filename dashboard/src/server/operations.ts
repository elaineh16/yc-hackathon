// Wasp queries and actions (declared in main.wasp). Thin wrappers: the rules live in ./relay/.
import { createHash, timingSafeEqual } from "node:crypto";
import { HttpError } from "wasp/server";
import type { OperatorDashboard, StudentStatus } from "../shared/relayTypes.js";
import { DEMO_REPORT, parseIntake } from "./relay/domain.js";
import * as svc from "./relay/service.js";
import { operatorDashboard, studentStatus } from "./relay/views.js";
import { traced } from "./tracing.js";

const advance = (id: string) => svc.advanceSimulation(id);

/** Optional OPERATOR_PIN: when set, staff/manager actions must send it. Unset = open demo dashboard. */
function requireOperator(pin: unknown) {
  const want = process.env.OPERATOR_PIN;
  if (!want) return;
  const h = (s: string) => createHash("sha256").update(s).digest();
  if (typeof pin !== "string" || !timingSafeEqual(h(pin), h(want))) throw new HttpError(401, "Operator PIN required.");
}
const workOrderId = (args: { workOrderId?: unknown }) => {
  if (typeof args?.workOrderId !== "string" || !args.workOrderId) throw new HttpError(400, "workOrderId is required.");
  return args.workOrderId;
};
type OpArgs = { workOrderId: string; operatorPin?: string };

// ---------- student ----------
export const createDemoSession = async (_args: void, _ctx: unknown) => svc.createSession();

export const getStudentStatus = async (args: { sessionId: string }, _ctx: unknown): Promise<StudentStatus> => {
  if (typeof args?.sessionId !== "string" || !args.sessionId) return { sessionValid: false, workOrder: null };
  return studentStatus(args.sessionId, advance);
};

/** No-voice fallback: records DEMO.md's report through the same intake path. Off unless ALLOW_TEST_REPORT=true. */
export const submitTestReport = async (args: { sessionId: string }, _ctx: unknown) => {
  if (process.env.ALLOW_TEST_REPORT !== "true") throw new HttpError(403, "Test reports are turned off on this server.");
  const parsed = parseIntake({ ...DEMO_REPORT, demo_session_id: args?.sessionId });
  if (!parsed.ok) throw new HttpError(400, "A session is required.");
  try {
    const r = await traced("relay.intake.tool", { demoSessionId: args.sessionId, source: "test" }, () => svc.recordIntake({ ...parsed.value, source: "test" }));
    return { workOrderId: r.workOrderId, created: r.created };
  } catch (e) {
    if (e instanceof svc.IntakeError) throw new HttpError(e.status, e.message);
    throw e;
  }
};

// ---------- operator dashboard ----------
export const getOperatorDashboard = async (_args: void, _ctx: unknown): Promise<OperatorDashboard> => operatorDashboard(advance);

const idem = (r: { idempotent: boolean }) => ({ idempotent: r.idempotent });

export const staffAccept = async (args: OpArgs & { etaMinutes?: number }, _ctx: unknown) => {
  requireOperator(args?.operatorPin);
  const id = workOrderId(args);
  return traced("relay.staff_status.update", { workOrderId: id, to: "ACCEPTED", etaMinutes: args.etaMinutes ?? 15 }, () => svc.staffAccept(id, args.etaMinutes ?? 15), idem);
};
export const staffMarkRetrieved = async (args: OpArgs, _ctx: unknown) => {
  requireOperator(args?.operatorPin);
  const id = workOrderId(args);
  return traced("relay.staff_status.update", { workOrderId: id, to: "RETRIEVED" }, () => svc.staffRetrieved(id), idem);
};
export const staffMarkUnavailable = async (args: OpArgs & { reason?: string }, _ctx: unknown) => {
  requireOperator(args?.operatorPin);
  const id = workOrderId(args);
  return traced("relay.staff_status.update", { workOrderId: id, to: "UNAVAILABLE" }, () => svc.staffUnavailable(id, args.reason), idem);
};
export const approveRepair = async (args: OpArgs & { capCents?: number; approver?: string; note?: string }, _ctx: unknown) => {
  requireOperator(args?.operatorPin);
  const id = workOrderId(args);
  const cap = args.capCents ?? 40_000;
  return traced(
    "relay.manager_decision",
    { workOrderId: id, decision: "APPROVED", capCents: cap, currency: "CAD", simulated: false },
    () => svc.approveRepair(id, cap, args.approver?.trim().slice(0, 60) || "Manager", args.note),
    idem,
  );
};
export const denyRepair = async (args: OpArgs & { approver?: string; note?: string }, _ctx: unknown) => {
  requireOperator(args?.operatorPin);
  const id = workOrderId(args);
  return traced("relay.manager_decision", { workOrderId: id, decision: "DENIED" }, () => svc.denyRepair(id, args.approver?.trim().slice(0, 60) || "Manager", args.note), idem);
};
export const simulateConfirmation = async (args: OpArgs, _ctx: unknown) => {
  requireOperator(args?.operatorPin);
  const id = workOrderId(args);
  return traced("relay.appointment.simulate_confirm", { workOrderId: id, simulated: true }, () => svc.simulateConfirmation(id), idem);
};
export const resetDemo = async (args: { operatorPin?: string } | undefined, _ctx: unknown) => {
  requireOperator(args?.operatorPin);
  return traced("relay.demo.reset", {}, () => svc.resetDemo(), (r) => ({ sessionsCleared: r.sessionsCleared }));
};
