// Wasp queries and actions (declared in main.wasp). Thin on purpose: each one identifies the caller, checks the
// role, and hands over to the case engine or an agent, which do the object-level checks and enforce the rules.
// After a write commits, kickCoordinator() wakes the coordinator if the write left a trigger for it.
import { prisma } from "wasp/server";
import type { Category, Severity } from "../shared/domain";
import type { AiStatus, CaseFilters, Me } from "../shared/views";
import { actorOf, type Ctx, requireRole } from "./access";
import { decideProposal as decideProposalFn, kickCoordinator, requestReassessment as requestReassessmentFn } from "./agent/coordinator";
import { getConversation, sendIntakeMessage as sendIntakeMessageFn, submitVoiceReport as submitVoiceReportFn } from "./agent/intake";
import { llmStatus } from "./agent/llm";
import * as flow from "./cases/flow";
import { createCase, type IntakeInput } from "./cases/intake";
import * as read from "./cases/read";
import * as settings from "./settings";
import { voiceConfigured, voiceCredential } from "./voice";

/** Runs a write, then wakes the coordinator for the case it touched. */
async function write<T extends { caseId?: string | null }>(p: Promise<T>): Promise<T> {
  const r = await p;
  void kickCoordinator(r?.caseId);
  return r;
}

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
  return {
    id: user.id,
    name: user.displayName,
    username: ctx.user?.identities.username?.id ?? "",
    role: actor.kind,
    vendor: user.vendor,
    units: user.residencies.map((r) => ({ id: r.unit.id, label: r.unit.label, propertyId: r.unit.propertyId, propertyName: r.unit.property.name, address: r.unit.property.address })),
    properties: user.memberships.map((m) => m.property),
    voiceAvailable: actor.kind === "RESIDENT" && voiceConfigured(),
  };
};
export const getAiStatus = async (_args: void, ctx: Ctx): Promise<AiStatus> => {
  actorOf(ctx);
  return llmStatus();
};
export const getCase = async (args: { caseId: string }, ctx: Ctx) => read.caseDetail(actorOf(ctx), args?.caseId);
export const getNotifications = async (_args: void, ctx: Ctx) => read.inbox(actorOf(ctx));
export const markNotificationsRead = async (args: { ids?: string[] } | void, ctx: Ctx) => read.markRead(actorOf(ctx), args?.ids);

// ───────────────────────── resident ─────────────────────────

/** The fallback form: works with no AI at all. */
export const reportIssue = async (args: IntakeInput, ctx: Ctx) => write(createCase(requireRole(ctx, "RESIDENT"), { ...args, channel: "TEXT", agent: undefined }));
export const getIntakeConversation = async (args: { unitId: string; fresh?: boolean }, ctx: Ctx) => getConversation(requireRole(ctx, "RESIDENT"), args);
export const sendIntakeMessage = async (args: { conversationId: string; text: string }, ctx: Ctx) => write(sendIntakeMessageFn(requireRole(ctx, "RESIDENT"), args));
export const submitVoiceReport = async (args: Record<string, unknown>, ctx: Ctx) => write(submitVoiceReportFn(requireRole(ctx, "RESIDENT"), args));
export const startVoiceIntake = async (_args: void, ctx: Ctx) => voiceCredential(requireRole(ctx, "RESIDENT"));
export const getMyCases = async (_args: void, ctx: Ctx) => (await read.listCases(requireRole(ctx, "RESIDENT"), { pageSize: 100, sort: "updated" })).items;
export const chooseVisitTime = async (args: { slotId: string }, ctx: Ctx) => write(flow.answerSlot(requireRole(ctx, "RESIDENT"), args));
export const declineVisitTimes = async (args: { caseId: string; note?: string }, ctx: Ctx) => write(flow.declineSlots(requireRole(ctx, "RESIDENT"), args));
export const confirmResolution = async (args: { caseId: string; resolved: boolean; note?: string }, ctx: Ctx) => write(flow.verifyResolution(requireRole(ctx, "RESIDENT"), args));

// ───────────────────────── resident or manager ─────────────────────────

export const reopenCase = async (args: { caseId: string; reason: string }, ctx: Ctx) => write(flow.reopenCase(requireRole(ctx, "RESIDENT", "MANAGER"), args));
export const cancelCase = async (args: { caseId: string; reason?: string }, ctx: Ctx) => write(flow.cancelCase(requireRole(ctx, "RESIDENT", "MANAGER"), args));
export const cancelVisit = async (args: { caseId: string; reason: string }, ctx: Ctx) => write(flow.cancelAppointment(actorOf(ctx), args));

// ───────────────────────── manager ─────────────────────────

export const getCommandCenter = async (_args: void, ctx: Ctx) => read.commandCenter(requireRole(ctx, "MANAGER"));
export const searchCases = async (args: CaseFilters | void, ctx: Ctx) => read.listCases(requireRole(ctx, "MANAGER"), args ?? undefined);
export const getEligibleVendors = async (args: { caseId: string }, ctx: Ctx) => read.eligibleVendors(requireRole(ctx, "MANAGER"), args?.caseId);
export const reviewTriage = async (args: { caseId: string; category: Category; severity: Severity; note?: string }, ctx: Ctx) => write(flow.reviewTriage(requireRole(ctx, "MANAGER"), args));
export const assignVendor = async (args: { caseId: string; vendorId: string; note?: string }, ctx: Ctx) => write(flow.assignVendor(requireRole(ctx, "MANAGER"), args));
export const withdrawOffer = async (args: { caseId: string; reason?: string }, ctx: Ctx) => write(flow.withdrawOffer(requireRole(ctx, "MANAGER"), args));
export const decideSpend = async (args: { caseId: string; approve: boolean; capCents?: number; note?: string }, ctx: Ctx) => write(flow.decideSpend(requireRole(ctx, "MANAGER"), args));
export const escalateCase = async (args: { caseId: string; reason: string }, ctx: Ctx) => write(flow.escalateCase(requireRole(ctx, "MANAGER"), args));
export const resumeCase = async (args: { caseId: string; note: string; severity?: Severity }, ctx: Ctx) => write(flow.resumeCase(requireRole(ctx, "MANAGER"), args));
export const markHandledOutside = async (args: { caseId: string; note: string }, ctx: Ctx) => write(flow.markHandledOutside(requireRole(ctx, "MANAGER"), args));
export const closeUnverified = async (args: { caseId: string; note?: string }, ctx: Ctx) => write(flow.closeUnverified(requireRole(ctx, "MANAGER"), args));
export const decideSuggestion = async (args: { proposalId: string; accept: boolean; message?: string; note?: string }, ctx: Ctx) => decideProposalFn(requireRole(ctx, "MANAGER"), args);
export const askRelayToReassess = async (args: { caseId: string }, ctx: Ctx) => requestReassessmentFn(requireRole(ctx, "MANAGER"), args);
export const getSettings = async (_args: void, ctx: Ctx) => settings.getSettings(requireRole(ctx, "MANAGER"));
export const updateProperty = async (args: settings.PropertyUpdate, ctx: Ctx) => settings.updateProperty(requireRole(ctx, "MANAGER"), args);
export const addUnit = async (args: { propertyId: string; label: string }, ctx: Ctx) => settings.addUnit(requireRole(ctx, "MANAGER"), args);
export const saveVendor = async (args: settings.VendorInput, ctx: Ctx) => settings.saveVendor(requireRole(ctx, "MANAGER"), args);
export const setVendorApproved = async (args: { vendorId: string; approved: boolean }, ctx: Ctx) => settings.setVendorApproved(requireRole(ctx, "MANAGER"), args);

// ───────────────────────── contractor ─────────────────────────

export const getMyJobs = async (_args: void, ctx: Ctx) => read.jobBoard(requireRole(ctx, "CONTRACTOR"));
export const respondToOffer = async (args: flow.OfferResponse, ctx: Ctx) => write(flow.respondToOffer(requireRole(ctx, "CONTRACTOR"), args));
export const proposeVisitTimes = async (args: { caseId: string; slots: flow.SlotInput[] }, ctx: Ctx) => write(flow.proposeSlots(requireRole(ctx, "CONTRACTOR"), args));
export const startWork = async (args: { caseId: string }, ctx: Ctx) => write(flow.startWork(requireRole(ctx, "CONTRACTOR"), args));
export const addProgressNote = async (args: { caseId: string; note: string }, ctx: Ctx) => write(flow.addProgressNote(requireRole(ctx, "CONTRACTOR"), args));
export const completeWork = async (args: { caseId: string; notes: string; finalCostCents?: number | null }, ctx: Ctx) => write(flow.completeWork(requireRole(ctx, "CONTRACTOR"), args));
