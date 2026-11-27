// Wasp queries and actions (declared in main.wasp). Thin on purpose: each one identifies the caller, checks the
// role, and hands over to the case engine, an agent or a service, which do the object-level checks and enforce rules.
// After a write commits: the actor's open notifications on that case are acknowledged (acting is acknowledging),
// the coordinator wakes if the write left a trigger, and any email that became due is sent, all outside the transaction.
import { prisma } from "wasp/server";
import type { Category, Severity } from "../shared/domain";
import type { AiStatus, CaseFilters, Me } from "../shared/views";
import { actorOf, type Ctx, requireRole } from "./access";
import { decideProposal as decideProposalFn, kickCoordinator, requestReassessment as requestReassessmentFn } from "./agent/coordinator";
import { closeChatFiledByForm, closeUnfinishedChat as closeUnfinishedChatFn, fileUnfinishedChat as fileUnfinishedChatFn, getConversation, recordVoiceEvent as recordVoiceEventFn, sendIntakeMessage as sendIntakeMessageFn, submitVoiceReport as submitVoiceReportFn } from "./agent/intake";
import { llmStatus } from "./agent/llm";
import * as flow from "./cases/flow";
import { createCase, type IntakeInput } from "./cases/intake";
import * as read from "./cases/read";
import { emailConfig } from "./notify/config";
import { useLimit } from "./limits";
import { kickEmail } from "./notify/email";
import { acknowledgeForCase } from "./notify/notify";
import * as settings from "./settings";
import * as discovery from "./vendors/discovery";
import { voiceConfigured, voiceCredential } from "./voice";

/** Runs a write, then does the after-commit work for the case it touched. */
async function write<T extends { caseId?: string | null }>(p: Promise<T>, actorUserId?: number): Promise<T> {
  const r = await p;
  if (r?.caseId && actorUserId) await acknowledgeForCase(prisma, actorUserId, r.caseId).catch(() => undefined);
  void kickCoordinator(r?.caseId);
  kickEmail();
  return r;
}
const resumeAll = async <T extends { resumed?: string[] }>(p: Promise<T>) => {
  const r = await p;
  for (const id of r.resumed ?? []) void kickCoordinator(id);
  kickEmail();
  return r;
};

// ───────────────────────── everyone ─────────────────────────

export const getMe = async (_args: void, ctx: Ctx): Promise<Me> => {
  const actor = actorOf(ctx);
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: actor.userId },
    include: {
      vendor: { select: { id: true, name: true } },
      residencies: { where: { active: true }, include: { unit: { include: { property: true } } } },
      memberships: { include: { property: { select: { id: true, name: true } } } },
    },
  });
  const ec = emailConfig();
  return {
    id: user.id,
    name: user.displayName,
    username: ctx.user?.identities.username?.id ?? "",
    role: actor.kind,
    vendor: user.vendor,
    units: user.residencies.map((r) => ({ id: r.unit.id, label: r.unit.label, propertyId: r.unit.propertyId, propertyName: r.unit.property.name, address: r.unit.property.address })),
    properties: user.memberships.map((m) => m.property),
    voiceAvailable: actor.kind === "RESIDENT" && voiceConfigured(),
    email: user.email,
    emailNotifications: user.emailNotifications,
    emailChannel: { configured: ec.enabled, capture: ec.capture },
  };
};
export const getAiStatus = async (_args: void, ctx: Ctx): Promise<AiStatus> => {
  actorOf(ctx);
  return llmStatus();
};
export const getCase = async (args: { caseId: string }, ctx: Ctx) => read.caseDetail(actorOf(ctx), args?.caseId);
export const getNotifications = async (_args: void, ctx: Ctx) => read.inbox(actorOf(ctx));
export const markNotificationsRead = async (args: { ids?: string[] } | void, ctx: Ctx) => read.markRead(actorOf(ctx), args?.ids);
export const acknowledgeNotification = async (args: { id: string }, ctx: Ctx) => read.acknowledge(actorOf(ctx), args?.id);
export const updateMyNotifications = async (args: { email?: string | null; emailNotifications?: boolean }, ctx: Ctx) => settings.updateMyNotifications(actorOf(ctx), args ?? {});

// ───────────────────────── resident ─────────────────────────

/** The fallback form: works with no AI at all. */
// Only the form's own fields are taken from the client: internal ones (the agent's reading, who filed a chat, a
// multi-issue group) are set by the server alone.
export const reportIssue = async (args: IntakeInput & { fromConversationId?: string }, ctx: Ctx) => {
  const a = requireRole(ctx, "RESIDENT");
  useLimit("reports", a.userId);
  const { unitId, description, clientRequestId, categoryHint, details, title, permissionToEnter, accessNotes } = args ?? ({} as typeof args);
  const res = await write(createCase(a, { unitId, description, clientRequestId, channel: "TEXT", categoryHint, details, title, permissionToEnter, accessNotes }));
  // Filed from a chat with the resident's words: that chat is closed with this case instead of waiting for review.
  if (args?.fromConversationId) await closeChatFiledByForm(a, args.fromConversationId, { caseId: res.caseId, ref: res.ref, unitId: String(unitId) }).catch(() => false);
  return res;
};
export const getIntakeConversation = async (args: { unitId: string; fresh?: boolean; conversationId?: string }, ctx: Ctx) => getConversation(requireRole(ctx, "RESIDENT"), args);
/** Saves the message and returns at once; Relay's reply is produced by a background job. */
export const sendIntakeMessage = async (args: { conversationId: string; text: string }, ctx: Ctx) => {
  const a = requireRole(ctx, "RESIDENT");
  useLimit("chat", a.userId);
  return sendIntakeMessageFn(a, args);
};
export const submitVoiceReport = async (args: Record<string, unknown>, ctx: Ctx) => {
  const a = requireRole(ctx, "RESIDENT");
  useLimit("reports", a.userId);
  return write(submitVoiceReportFn(a, args));
};
/**
 * The resident's browser forwards each event of a voice call (connected, a line of the transcript, ended), so what the
 * resident said is kept and screened by the safety net even if the call drops before the agent files anything.
 */
export const recordVoiceEvent = async (args: { unitId: string; attemptId: string; kind: string; text?: string; callId?: string }, ctx: Ctx) => {
  const a = requireRole(ctx, "RESIDENT");
  useLimit("voiceEvents", a.userId);
  return recordVoiceEventFn(a, args); // a filing here does its own after-commit work (coordinator, email)
};
/** Each call opens a billable voice session, so it is limited per resident. */
export const startVoiceIntake = async (args: { unitId?: string } | void, ctx: Ctx) => {
  const a = requireRole(ctx, "RESIDENT");
  useLimit("voice", a.userId);
  return voiceCredential(a, args?.unitId);
};
export const getMyCases = async (_args: void, ctx: Ctx) => (await read.listCases(requireRole(ctx, "RESIDENT"), { pageSize: 100, sort: "updated" })).items;
export const chooseVisitTime = async (args: { slotId: string }, ctx: Ctx) => {
  const a = requireRole(ctx, "RESIDENT");
  return write(flow.answerSlot(a, args), a.userId);
};
export const declineVisitTimes = async (args: { caseId: string; note?: string }, ctx: Ctx) => {
  const a = requireRole(ctx, "RESIDENT");
  return write(flow.declineSlots(a, args), a.userId);
};
export const confirmResolution = async (args: { caseId: string; resolved: boolean; note?: string }, ctx: Ctx) => {
  const a = requireRole(ctx, "RESIDENT");
  return write(flow.verifyResolution(a, args), a.userId);
};

// ───────────────────────── resident or manager ─────────────────────────

export const reopenCase = async (args: { caseId: string; reason: string }, ctx: Ctx) => {
  const a = requireRole(ctx, "RESIDENT", "MANAGER");
  return write(flow.reopenCase(a, args), a.userId);
};
export const cancelCase = async (args: { caseId: string; reason?: string }, ctx: Ctx) => {
  const a = requireRole(ctx, "RESIDENT", "MANAGER");
  return write(flow.cancelCase(a, args), a.userId);
};
export const cancelVisit = async (args: { caseId: string; reason: string }, ctx: Ctx) => {
  const a = actorOf(ctx);
  return write(flow.cancelAppointment(a, args), a.userId);
};

// ───────────────────────── manager ─────────────────────────

const manager = (ctx: Ctx) => requireRole(ctx, "MANAGER");
export const getCommandCenter = async (_args: void, ctx: Ctx) => read.commandCenter(manager(ctx));
/** The intake safety net: a manager files a chat the assistant did not finish as a case, or closes it with a reason. */
export const fileUnfinishedChat = async (args: { conversationId: string }, ctx: Ctx) => write(fileUnfinishedChatFn(manager(ctx), args), manager(ctx).userId);
export const closeUnfinishedChat = async (args: { conversationId: string; note: string }, ctx: Ctx) => closeUnfinishedChatFn(manager(ctx), args);
export const searchCases = async (args: CaseFilters | void, ctx: Ctx) => read.listCases(manager(ctx), args ?? undefined);
export const getEligibleVendors = async (args: { caseId: string }, ctx: Ctx) => read.eligibleVendors(manager(ctx), args?.caseId);
export const reviewTriage = async (args: { caseId: string; category: Category; severity: Severity; note?: string }, ctx: Ctx) => write(flow.reviewTriage(manager(ctx), args), manager(ctx).userId);
export const assignVendor = async (args: { caseId: string; vendorId: string; note?: string }, ctx: Ctx) => write(flow.assignVendor(manager(ctx), args), manager(ctx).userId);
export const withdrawOffer = async (args: { caseId: string; reason?: string }, ctx: Ctx) => write(flow.withdrawOffer(manager(ctx), args), manager(ctx).userId);
export const decideSpend = async (args: { caseId: string; approve: boolean; capCents?: number; note?: string }, ctx: Ctx) => write(flow.decideSpend(manager(ctx), args), manager(ctx).userId);
export const decideBudgetRequest = async (args: { caseId: string; approve: boolean; note?: string }, ctx: Ctx) => write(flow.decideBudgetRequest(manager(ctx), args), manager(ctx).userId);
export const escalateCase = async (args: { caseId: string; reason: string }, ctx: Ctx) => write(flow.escalateCase(manager(ctx), args), manager(ctx).userId);
export const resumeCase = async (args: { caseId: string; note: string; severity?: Severity }, ctx: Ctx) => write(flow.resumeCase(manager(ctx), args), manager(ctx).userId);
export const markHandledOutside = async (args: { caseId: string; note: string }, ctx: Ctx) => write(flow.markHandledOutside(manager(ctx), args), manager(ctx).userId);
export const closeUnverified = async (args: { caseId: string; note?: string }, ctx: Ctx) => write(flow.closeUnverified(manager(ctx), args), manager(ctx).userId);
export const decideSuggestion = async (args: { proposalId: string; accept: boolean; message?: string; note?: string }, ctx: Ctx) => decideProposalFn(manager(ctx), args);
export const askRelayToReassess = async (args: { caseId: string }, ctx: Ctx) => requestReassessmentFn(manager(ctx), args);
export const getSettings = async (_args: void, ctx: Ctx) => settings.getSettings(manager(ctx));
export const updateProperty = async (args: settings.PropertyUpdate, ctx: Ctx) => settings.updateProperty(manager(ctx), args);
export const addUnit = async (args: { propertyId: string; label: string }, ctx: Ctx) => settings.addUnit(manager(ctx), args);
export const saveVendor = async (args: settings.VendorInput, ctx: Ctx) => resumeAll(settings.saveVendor(manager(ctx), args));
export const setVendorApproved = async (args: { vendorId: string; approved: boolean; propertyId?: string }, ctx: Ctx) => resumeAll(settings.setVendorApproved(manager(ctx), args));

// Vendor discovery (Fiber AI). Discovery never authorizes anything: only onboarding a verified business does.
export const getDiscoveryPanel = async (args: { caseId: string }, ctx: Ctx) => discovery.discoveryPanel(manager(ctx), args?.caseId);
export const getFiberStatus = async (_args: void, ctx: Ctx) => discovery.fiberStatus(manager(ctx));
export const requestVendorDiscovery = async (args: { caseId: string; force?: boolean }, ctx: Ctx) => {
  const r = await discovery.requestDiscovery(manager(ctx), args);
  kickEmail();
  return r;
};
export const reviewCandidate = async (args: { candidateId: string; decision: "SHORTLIST" | "VERIFY" | "REJECT" | "REOPEN"; note?: string }, ctx: Ctx) => discovery.reviewCandidate(manager(ctx), args);
export const onboardCandidate = async (args: { candidateId: string; phone?: string; email?: string; note?: string }, ctx: Ctx) => {
  const r = await discovery.onboardCandidate(manager(ctx), args);
  for (const id of r.resumedCaseIds ?? []) void kickCoordinator(id);
  kickEmail();
  return { ok: r.ok, repeated: r.repeated, vendorId: r.vendorId, resumed: r.resumed };
};

// ───────────────────────── contractor ─────────────────────────

const contractor = (ctx: Ctx) => requireRole(ctx, "CONTRACTOR");
export const getMyJobs = async (_args: void, ctx: Ctx) => read.jobBoard(contractor(ctx));
export const respondToOffer = async (args: flow.OfferResponse, ctx: Ctx) => write(flow.respondToOffer(contractor(ctx), args), contractor(ctx).userId);
export const proposeVisitTimes = async (args: { caseId: string; slots: flow.SlotInput[] }, ctx: Ctx) => write(flow.proposeSlots(contractor(ctx), args), contractor(ctx).userId);
export const startWork = async (args: { caseId: string }, ctx: Ctx) => write(flow.startWork(contractor(ctx), args), contractor(ctx).userId);
export const addProgressNote = async (args: { caseId: string; note: string }, ctx: Ctx) => write(flow.addProgressNote(contractor(ctx), args), contractor(ctx).userId);
export const completeWork = async (args: { caseId: string; notes: string; finalCostCents?: number | null }, ctx: Ctx) => write(flow.completeWork(contractor(ctx), args), contractor(ctx).userId);
export const requestMoreBudget = async (args: { caseId: string; additionalCents: number; reason: string }, ctx: Ctx) => write(flow.requestMoreBudget(contractor(ctx), args), contractor(ctx).userId);
