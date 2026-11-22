// Wasp queries and actions (declared in main.wasp). Thin wrappers: the rules live in ./relay/.
import { createHash, timingSafeEqual } from "node:crypto";
import { HttpError } from "wasp/server";
import type { OperatorDashboard, StudentStatus } from "../shared/relayTypes.js";
import * as svc from "./relay/service.js";
import { operatorDashboard, studentStatus } from "./relay/views.js";

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

// ---------- operator dashboard ----------
export const getOperatorDashboard = async (_args: void, _ctx: unknown): Promise<OperatorDashboard> => operatorDashboard(advance);

export const staffAccept = async (args: OpArgs & { etaMinutes?: number }, _ctx: unknown) => {
  requireOperator(args?.operatorPin);
  return svc.staffAccept(workOrderId(args), args.etaMinutes ?? 15);
};
export const staffMarkRetrieved = async (args: OpArgs, _ctx: unknown) => {
  requireOperator(args?.operatorPin);
  return svc.staffRetrieved(workOrderId(args));
};
export const staffMarkUnavailable = async (args: OpArgs & { reason?: string }, _ctx: unknown) => {
  requireOperator(args?.operatorPin);
  return svc.staffUnavailable(workOrderId(args), args.reason);
};
export const approveRepair = async (args: OpArgs & { capCents?: number; approver?: string; note?: string }, _ctx: unknown) => {
  requireOperator(args?.operatorPin);
  return svc.approveRepair(workOrderId(args), args.capCents ?? 40_000, args.approver?.trim().slice(0, 60) || "Manager", args.note);
};
export const denyRepair = async (args: OpArgs & { approver?: string; note?: string }, _ctx: unknown) => {
  requireOperator(args?.operatorPin);
  return svc.denyRepair(workOrderId(args), args.approver?.trim().slice(0, 60) || "Manager", args.note);
};
export const simulateConfirmation = async (args: OpArgs, _ctx: unknown) => {
  requireOperator(args?.operatorPin);
  return svc.simulateConfirmation(workOrderId(args));
};
export const resetDemo = async (args: { operatorPin?: string } | undefined, _ctx: unknown) => {
  requireOperator(args?.operatorPin);
  return svc.resetDemo();
};
