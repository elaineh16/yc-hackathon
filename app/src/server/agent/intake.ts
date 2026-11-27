// The intake agent: a resident describes a problem in their own words; the model works out what matters, asks the
// questions this particular situation needs, looks things up, and files the report with submit_report.
//
// Asynchronous by design: sending a message saves it and returns at once (the resident sees it acknowledged); the
// model runs in a background job (intakeTurnJob) and the page polls for the reply. A slow model never holds a request.
// Policy around it (see intakePolicy.ts): the report is saved only by the server, the resident's own words are kept
// verbatim, safety rules can only raise severity, codes and staff-only notes never reach a reply, and the reply after
// submission is the server's result, not the model's paraphrase.
import { randomUUID } from "node:crypto";
import { HttpError, prisma } from "wasp/server";
import { intakeTurnJob } from "wasp/server/jobs";
import { caseRef, CATEGORIES, SEVERITIES } from "../../shared/domain";
import { managedPropertyIds } from "../access";
import { createCase, type IntakeResult } from "../cases/intake";
import { type ActorCtx, faults, isUuid, managerIds } from "../cases/engine";
import { notify } from "../notify/notify";
import { reopenCase, verifyResolution } from "../cases/flow";
import { kickEmail } from "../notify/email";
import { mark, traced } from "../tracing";
import { kickCoordinator } from "./coordinator";
import { guardReply, intakeSystemPrompt, REOPEN_SCHEMA, secretsIn, SUBMIT_SCHEMA, type SubmitArgs, validateSubmit } from "./intakePolicy";
import { REVIEW_REASONS, type ReviewReason, residentWordsOf, safetyScreen } from "./intakeSafety";
import { searchKnowledge } from "./knowledge";
import { LlmUnavailable, llmConfig, type ChatMessage } from "./llm";
import { bool, cleanFacts, oneOf, runLoop, str, type Step, type Tool } from "./loop";

export type ChatTurn = { role: "resident" | "relay"; text: string; at: string };
export type FiledRef = { caseId: string; ref: string; action: "filed" | "reopened" };
export type ConversationView = {
  id: string;
  status: "OPEN" | "SUBMITTED" | "ABANDONED";
  messages: ChatTurn[];
  facts: Record<string, string | number | boolean>;
  caseId: string | null;
  caseRef: string | null;
  unitId: string;
  /** Relay is working on a reply (a background job). The page polls until this is false. */
  pending: boolean;
  pendingSince: string | null;
  /** ai_unavailable when the model could not answer; the page then offers the form with the resident's words. */
  lastError: string | null;
  /** Reports filed or reopened by this conversation. */
  filed: FiledRef[];
};

const FILED_KEY = "_filed";
const view = (c: { id: string; status: string; messages: unknown; facts: unknown; caseId: string | null; unitId: string; pendingSince: Date | null; lastError: string | null }, ref: string | null): ConversationView => {
  const raw = (c.facts && typeof c.facts === "object" ? c.facts : {}) as Record<string, unknown>;
  const { [FILED_KEY]: filed, ...facts } = raw;
  return {
    id: c.id,
    status: c.status as ConversationView["status"],
    messages: (Array.isArray(c.messages) ? c.messages : []) as ChatTurn[],
    facts: facts as ConversationView["facts"],
    caseId: c.caseId,
    caseRef: ref,
    unitId: c.unitId,
    pending: c.pendingSince !== null,
    pendingSince: c.pendingSince?.toISOString() ?? null,
    lastError: c.lastError,
    filed: Array.isArray(filed) ? (filed as FiledRef[]) : [],
  };
};

async function residencyFor(userId: number, unitId: unknown) {
  if (typeof unitId !== "string") throw new HttpError(400, "Choose your unit.");
  const r = await prisma.residency.findFirst({ where: { userId, unitId, active: true }, include: { unit: { include: { property: true } } } });
  if (!r) throw new HttpError(403, "You can only report issues for a unit you live in.");
  return r;
}

async function reload(id: string): Promise<ConversationView> {
  const c = await prisma.intakeConversation.findUniqueOrThrow({ where: { id }, include: { case: { select: { number: true } } } });
  return view(c, c.case ? caseRef(c.case.number) : null);
}

/**
 * A specific conversation of this resident's (any status, so a filed one keeps showing its result), or the open one
 * for this unit, or a new one with Relay's greeting.
 */
export async function getConversation(actor: ActorCtx, input: { unitId: string; fresh?: boolean; conversationId?: string }): Promise<ConversationView> {
  const r = await residencyFor(actor.userId!, input?.unitId);
  if (!input.fresh && typeof input.conversationId === "string") {
    const mine = await prisma.intakeConversation.findFirst({ where: { id: input.conversationId, residentId: actor.userId!, unitId: r.unitId, channel: "CHAT" }, include: { case: { select: { number: true } } } });
    if (mine) return view(mine, mine.case ? caseRef(mine.case.number) : null);
  }
  if (!input.fresh) {
    const open = await prisma.intakeConversation.findFirst({ where: { residentId: actor.userId!, unitId: r.unitId, status: "OPEN", channel: "CHAT" }, orderBy: { createdAt: "desc" } });
    if (open) return view(open, null);
  } else {
    await prisma.intakeConversation.updateMany({ where: { residentId: actor.userId!, unitId: r.unitId, status: "OPEN", channel: "CHAT" }, data: { status: "ABANDONED", pendingSince: null } });
  }
  const first = actor.name.split(" ")[0];
  const greeting: ChatTurn = {
    role: "relay",
    text: `Hi ${first}, I'm Relay, an AI assistant for ${r.unit.property.name}. Tell me what's wrong in your own words, and I'll ask anything else I need before filing it with your property manager.`,
    at: new Date().toISOString(),
  };
  const c = await prisma.intakeConversation.create({ data: { residentId: actor.userId!, unitId: r.unitId, messages: [greeting] } });
  return view(c, null);
}

/** Saves the resident's message and queues Relay's reply. Returns at once. */
export async function sendIntakeMessage(actor: ActorCtx, input: { conversationId: string; text: string }): Promise<ConversationView> {
  const text = str(input?.text, 1500);
  if (text.length < 1) throw new HttpError(400, "Write a message first.");
  const conv = await prisma.intakeConversation.findUnique({ where: { id: String(input?.conversationId ?? "") } });
  if (!conv || conv.residentId !== actor.userId || conv.channel !== "CHAT") throw new HttpError(404, "Conversation not found.");
  if (conv.status !== "OPEN") throw new HttpError(409, "This conversation is closed. Start a new report.", { code: "conversation_closed" });
  // Every turn resends the conversation to the model, so a conversation has a length limit.
  if ((conv.messages as ChatTurn[]).filter((m) => m.role === "resident").length >= MAX_RESIDENT_MESSAGES) {
    throw new HttpError(409, "This conversation has gone on for a while. Send what you have with the form (it keeps your words), or start a new conversation.", { code: "conversation_too_long" });
  }
  await residencyFor(actor.userId!, conv.unitId);
  const history = [...(conv.messages as ChatTurn[]), { role: "resident" as const, text, at: new Date().toISOString() }];
  // Compare-and-set: one message at a time, so a double send cannot queue two replies.
  // A manager who closed an earlier review has not seen this message: a later failure puts it in front of them again.
  const reopenReview = conv.reviewOutcome === "closed" ? { reviewSince: null, reviewReason: null, reviewOutcome: null, reviewedAt: null, reviewedById: null, reviewNote: null } : {};
  const saved = await prisma.intakeConversation.updateMany({ where: { id: conv.id, status: "OPEN", pendingSince: null }, data: { messages: history, pendingSince: new Date(), pendingAttempts: 0, lastError: null, ...reopenReview } });
  if (saved.count === 0) throw new HttpError(409, "Relay is still replying to your last message.", { code: "turn_pending" });
  // The safety net, before the model: a possible emergency in the resident's own words is filed now, by the server,
  // with the same rules that classify every report. It does not wait for the model, or depend on it answering.
  if (safetyScreen(residentWordsOf(history)).emergency) {
    const filed = await fileFromChat(conv.id, { kind: "SAFETY_NET" }).catch((e) => {
      console.warn("[intake] the safety net could not file the report; the assistant will answer and a failure goes to a person:", (e as Error)?.name);
      return null;
    });
    if (filed) {
      mark("relay.intake.safety_net.filed", { conversationId: conv.id, caseId: filed.caseId });
      return reload(conv.id);
    }
  }
  await kickIntake(conv.id);
  return reload(conv.id);
}

/**
 * Files a chat or call report from the resident's own words, without the assistant: by the safety net (a possible
 * emergency) or by a manager reviewing an unfinished conversation. Idempotent: the conversation's request id returns
 * the same case.
 */
async function fileFromChat(conversationId: string, by: { kind: "SAFETY_NET" } | { kind: "MANAGER"; name: string; userId: number }) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const c = await prisma.intakeConversation.findUnique({ where: { id: conversationId }, include: { resident: { select: { displayName: true } } } });
    if (!c) return null;
    // Already filed (by the assistant, the form or a person): never a second case.
    if (c.caseId) {
      const k = await prisma.case.findUnique({ where: { id: c.caseId }, select: { number: true } });
      return { caseId: c.caseId, ref: k ? caseRef(k.number) : "", message: "", repeated: true };
    }
    const words = residentWordsOf(c.messages).trim();
    if (!words) return null;
    const voice = c.channel === "VOICE";
    const actor: ActorCtx = { kind: "RESIDENT", userId: c.residentId, name: c.resident.displayName, vendorId: null };
    const res = await createCase(actor, { unitId: c.unitId, channel: voice ? "VOICE" : "CHAT", clientRequestId: c.clientRequestId, description: words, filedBy: by.kind === "SAFETY_NET" ? { kind: "SAFETY_NET" } : { kind: "MANAGER", name: by.name } });
    const reply =
      by.kind === "SAFETY_NET"
        ? `This could be dangerous, so I've passed it to your property manager straight away instead of asking more questions. ${res.message}`
        : `${by.name} from your property's management read this conversation and filed it for you as ${res.ref}. You can follow it in Relay.`;
    const now = new Date();
    const prior = ((c.facts ?? {}) as Record<string, unknown>)[FILED_KEY];
    // Compare-and-set on the last change, so a message the resident sent meanwhile is never overwritten.
    // A call's transcript holds only what was said on the call: the resident hears the outcome from the voice agent
    // (its submit_report gets this case) and sees it on the page, so no line is added to it.
    const w = await prisma.intakeConversation.updateMany({
      where: { id: c.id, caseId: null, updatedAt: c.updatedAt },
      data: {
        status: "SUBMITTED",
        caseId: res.caseId,
        pendingSince: null,
        lastError: null,
        messages: (voice ? (c.messages as ChatTurn[]) : [...(c.messages as ChatTurn[]), { role: "relay", text: reply, at: now.toISOString() }]) as object[],
        facts: { ...((c.facts ?? {}) as object), [FILED_KEY]: [...(Array.isArray(prior) ? prior : []), { caseId: res.caseId, ref: res.ref, action: "filed" }] } as object,
        ...(c.reviewSince && !c.reviewOutcome ? { reviewOutcome: "filed", reviewedAt: now, reviewedById: by.kind === "MANAGER" ? by.userId : null } : {}),
      },
    });
    if (w.count === 1) {
      await settleReviewAlerts(c.id);
      // The resident is usually not on the chat page any more: tell them a person read it and filed it.
      if (by.kind === "MANAGER") {
        const read = voice ? "read the transcript of your call with Relay's voice assistant" : "read your conversation with Relay's assistant";
        await prisma.$transaction((tx) => notify(tx, [c.residentId], res.caseId, "chat-filed", { kind: "UPDATE", email: true, title: `Your report was filed: ${res.ref}`, body: `${by.name} ${read} and filed it as ${res.ref}. You can follow it in Relay.` }));
        kickEmail();
      }
      afterFiling([{ caseId: res.caseId, ref: res.ref, action: "filed" }]);
      return { caseId: res.caseId, ref: res.ref, message: res.message, repeated: res.duplicate };
    }
  }
  throw new Error("the conversation kept changing while it was being filed");
}

/**
 * The resident filed with the form from a chat ("Use the form with my words"): that chat is closed as filed with the
 * form's case, so it does not also wait for a manager's review. Only the resident's own unfiled chat on the same unit.
 */
export async function closeChatFiledByForm(actor: ActorCtx, conversationId: unknown, filed: { caseId: string; ref: string; unitId: string }) {
  if (!isUuid(conversationId)) return false;
  for (let attempt = 0; attempt < 3; attempt++) {
    const c = await prisma.intakeConversation.findFirst({ where: { id: conversationId, residentId: actor.userId!, unitId: filed.unitId, caseId: null } });
    if (!c || c.status === "SUBMITTED") return false;
    const now = new Date();
    const prior = ((c.facts ?? {}) as Record<string, unknown>)[FILED_KEY];
    const inReview = !!c.reviewSince && !c.reviewOutcome;
    const w = await prisma.intakeConversation.updateMany({
      where: { id: c.id, caseId: null, updatedAt: c.updatedAt },
      data: {
        status: "SUBMITTED",
        caseId: filed.caseId,
        pendingSince: null,
        messages: [...(c.messages as ChatTurn[]), { role: "relay", text: `You filed this with the form as ${filed.ref}.`, at: now.toISOString() }] as object[],
        facts: { ...((c.facts ?? {}) as object), [FILED_KEY]: [...(Array.isArray(prior) ? prior : []), { caseId: filed.caseId, ref: filed.ref, action: "filed" }] } as object,
        ...(inReview ? { reviewOutcome: "filed", reviewedAt: now } : {}),
      },
    });
    if (w.count === 1) {
      if (inReview) await settleReviewAlerts(c.id);
      return true;
    }
  }
  return false;
}

/**
 * Puts an unfinished conversation in front of the property's managers: the assistant could not reply, or the resident
 * left before anything was filed. Returns whether a person now has it (true also when it was already waiting).
 */
export async function flagForReview(conversationId: string, reason: ReviewReason): Promise<boolean> {
  const flagged = await prisma.$transaction(async (tx) => {
    const c = await tx.intakeConversation.findUnique({ where: { id: conversationId }, include: { resident: { select: { displayName: true } } } });
    if (!c || c.caseId) return false;
    if (c.reviewSince && !c.reviewOutcome) return true;
    const words = residentWordsOf(c.messages).trim();
    if (!words) return false;
    const unit = await tx.unit.findUnique({ where: { id: c.unitId } });
    if (!unit) return false;
    const now = new Date();
    const won = await tx.intakeConversation.updateMany({
      where: { id: c.id, caseId: null, OR: [{ reviewSince: null }, { reviewOutcome: { not: null } }] },
      data: { reviewSince: now, reviewReason: reason, reviewOutcome: null, reviewedAt: null, reviewedById: null, reviewNote: null },
    });
    if (won.count === 0) return true;
    const urgent = safetyScreen(words).severity !== "ROUTINE";
    const voice = c.channel === "VOICE";
    await notify(tx, await managerIds(tx, unit.propertyId), null, `intake-review:${c.id}:${now.getTime()}`, {
      kind: urgent ? "REVIEW_NEEDED" : "ACTION",
      event: "intake.review",
      title: `Unfinished ${voice ? "voice" : "chat"} report${urgent ? " (urgent by the safety rules)" : ""}: ${c.resident.displayName}, unit ${unit.label}`,
      body: `${REVIEW_REASONS[reason]}. They ${voice ? "said" : "wrote"}: "${words.length > 300 ? `${words.slice(0, 297)}…` : words}" File it as a case or close it from the command center.`,
    });
    return true;
  });
  if (flagged) kickEmail();
  return flagged;
}

async function reviewable(actor: ActorCtx, conversationId: unknown) {
  if (actor.kind !== "MANAGER") throw new HttpError(403, "Your account cannot do that.");
  if (!isUuid(conversationId)) throw new HttpError(404, "Not found.");
  const c = await prisma.intakeConversation.findUnique({ where: { id: conversationId } });
  const unit = c ? await prisma.unit.findUnique({ where: { id: c.unitId } }) : null;
  if (!c || !unit || !(await managedPropertyIds(prisma, actor.userId!)).includes(unit.propertyId)) throw new HttpError(404, "Not found.");
  return c;
}

/** A manager files an unfinished chat as a case, from the resident's own words. Idempotent. */
export async function fileUnfinishedChat(actor: ActorCtx, input: { conversationId: string }) {
  const c = await reviewable(actor, input?.conversationId);
  if (c.caseId) return { ok: true, repeated: true, caseId: c.caseId };
  if (!c.reviewSince || c.reviewOutcome) throw new HttpError(409, "This conversation is not waiting for review.", { code: "not_in_review" });
  const r = await fileFromChat(c.id, { kind: "MANAGER", name: actor.name, userId: actor.userId! });
  if (!r) throw new HttpError(409, "There is nothing in this conversation to file.", { code: "nothing_to_file" });
  return { ok: true, repeated: r.repeated, caseId: r.caseId, ref: r.ref };
}

/** A manager closes an unfinished chat without a case, saying why (for example: called the resident, a duplicate). */
export async function closeUnfinishedChat(actor: ActorCtx, input: { conversationId: string; note: string }) {
  const c = await reviewable(actor, input?.conversationId);
  const note = typeof input.note === "string" ? input.note.replace(/\s+/g, " ").trim().slice(0, 300) : "";
  if (note.length < 3) throw new HttpError(400, "Say briefly why no report is needed.", { code: "note_required" });
  if (c.caseId) throw new HttpError(409, "It was already filed as a case.", { code: "already_filed" });
  if (c.reviewOutcome === "closed") return { ok: true, repeated: true };
  const w = await prisma.intakeConversation.updateMany({ where: { id: c.id, caseId: null, reviewSince: { not: null }, reviewOutcome: null }, data: { reviewOutcome: "closed", reviewedAt: new Date(), reviewedById: actor.userId, reviewNote: note } });
  if (w.count === 0) throw new HttpError(409, "This conversation is not waiting for review.", { code: "not_in_review" });
  await settleReviewAlerts(c.id);
  return { ok: true, repeated: false };
}

/** Once a person has dealt with an unfinished chat, its alerts are acknowledged: they never show as overdue. */
async function settleReviewAlerts(conversationId: string) {
  const now = new Date();
  await prisma.notification.updateMany({ where: { dedupeKey: { startsWith: `none:intake-review:${conversationId}:` }, channel: "IN_APP", acknowledgedAt: null }, data: { acknowledgedAt: now } });
}

/** Queue a reply job. Never throws: the minute sweep re-queues any turn left pending. */
export async function kickIntake(conversationId: string) {
  try {
    await intakeTurnJob.submit({ conversationId });
  } catch (e) {
    console.warn("[intake] could not queue the reply; the sweep will retry:", (e as Error)?.name);
  }
}

/** pg-boss entry point. */
export const intakeTurnJobFn = async (args: { conversationId: string }, _ctx: unknown) => runIntakeTurn(String(args?.conversationId ?? ""));

const OFFLINE_REPLY =
  "I can't reply right now: Relay's AI assistant is offline. Your message is saved. You can send this report with the form instead, which works without the assistant, and a person will read it.";
const SORRY_REPLY = "Sorry, something went wrong on our side and I could not reply. Your message is saved. You can try again, or send it with the form.";
// Said only once the conversation is in front of the property's managers (flagForReview returned true).
const OFFLINE_REPLY_PASSED =
  "I can't reply right now: Relay's AI assistant is offline. Your message is saved, and I've passed it to your property manager so a person reads it. You can also send the report with the form, which works without the assistant.";
const SORRY_REPLY_PASSED = "Sorry, something went wrong on our side and I could not reply. Your message is saved, and I've passed it to your property manager so a person reads it. You can try again, or send it with the form.";
const failureReply = async (conversationId: string, unavailable: boolean) => {
  const passed = await flagForReview(conversationId, "assistant_failed").catch(() => false);
  return unavailable ? (passed ? OFFLINE_REPLY_PASSED : OFFLINE_REPLY) : passed ? SORRY_REPLY_PASSED : SORRY_REPLY;
};
/** A whole turn (every model call in it) must finish within this. A run still marked running well after it was interrupted. */
const TURN_BUDGET_MS = Number(process.env.INTAKE_TURN_BUDGET_MS) || 180_000;
const STALE_TURN_MS = TURN_BUDGET_MS + 60_000;
const MAX_TURN_ATTEMPTS = 2;
const MAX_RESIDENT_MESSAGES = 20;

export async function runIntakeTurn(conversationId: string): Promise<{ status: string }> {
  const conv = await prisma.intakeConversation.findUnique({ where: { id: conversationId } });
  if (!conv || conv.status !== "OPEN" || !conv.pendingSince) return { status: "nothing_pending" };
  const history = conv.messages as ChatTurn[];
  const residentTurns = history.filter((m) => m.role === "resident").length;
  // Claim the turn: one run per (conversation, resident message). A duplicated or retried job does nothing, unless the
  // earlier run died (stale), in which case it is taken over.
  const triggerKey = `${conv.id}:turn:${residentTurns}`;
  let runId: string;
  try {
    runId = (await prisma.agentRun.create({ data: { kind: "INTAKE", conversationId: conv.id, trigger: "RESIDENT_MESSAGE", triggerKey, model: llmConfig().model } })).id;
  } catch (e) {
    if ((e as { code?: string })?.code !== "P2002") throw e;
    const prior = await prisma.agentRun.findUnique({ where: { triggerKey } });
    if (!prior) return { status: "already_claimed" };
    if (prior.status === "FAILED" && (conv.pendingAttempts ?? 0) < MAX_TURN_ATTEMPTS) {
      // The last attempt failed and left the turn unanswered: this retry takes it over.
      const retake = await prisma.agentRun.updateMany({ where: { id: prior.id, status: "FAILED" }, data: { status: "RUNNING", createdAt: new Date(), finishedAt: null, error: `retrying after: ${prior.error ?? "an error"}`.slice(0, 200) } });
      if (retake.count === 0) return { status: "already_running" };
      runId = prior.id;
    } else if (prior.status !== "RUNNING") {
      // Answered already (the marker was left behind), or out of attempts: either way the resident has a reply.
      const answered = prior.status === "SUCCEEDED";
      const sorry = answered ? "" : await failureReply(conv.id, false);
      await prisma.intakeConversation.updateMany({
        where: { id: conv.id, pendingSince: conv.pendingSince },
        data: answered ? { pendingSince: null } : { pendingSince: null, lastError: "error", messages: [...history, { role: "relay", text: sorry, at: new Date().toISOString() }] as object[] },
      });
      return { status: answered ? "already_done" : "failed" };
    } else {
      // Still running: taken over only once it is past any turn's deadline (the server stopped mid-run), and only within
      // the attempt limit: a turn interrupted on every attempt (one that crashes the process) goes to a person instead.
      if ((conv.pendingAttempts ?? 0) >= MAX_TURN_ATTEMPTS) {
        const gaveUp = await prisma.agentRun.updateMany({ where: { id: prior.id, status: "RUNNING", createdAt: { lt: new Date(Date.now() - STALE_TURN_MS) } }, data: { status: "FAILED", error: "interrupted on every attempt", finishedAt: new Date() } });
        if (gaveUp.count === 0) return { status: "already_running" };
        const sorry = await failureReply(conv.id, false);
        await prisma.intakeConversation.updateMany({ where: { id: conv.id, pendingSince: conv.pendingSince }, data: { pendingSince: null, lastError: "error", messages: [...history, { role: "relay", text: sorry, at: new Date().toISOString() }] as object[] } });
        return { status: "failed" };
      }
      const takeover = await prisma.agentRun.updateMany({ where: { id: prior.id, status: "RUNNING", createdAt: { lt: new Date(Date.now() - STALE_TURN_MS) } }, data: { createdAt: new Date(), error: "taken over after an interrupted run" } });
      if (takeover.count === 0) return { status: "already_running" };
      runId = prior.id;
    }
  }
  await prisma.intakeConversation.update({ where: { id: conv.id }, data: { pendingAttempts: { increment: 1 } } });
  // test-only: the server dies mid-turn, leaving the run RUNNING and the turn pending, as a crash or a deploy would.
  if (faults.take("intake.crash")) return { status: "crashed (test)" };

  const r = await prisma.residency.findFirst({ where: { userId: conv.residentId, unitId: conv.unitId, active: true }, include: { unit: { include: { property: true } }, user: true } });
  if (!r) {
    await prisma.agentRun.update({ where: { id: runId }, data: { status: "FAILED", error: "no active residency", finishedAt: new Date() } });
    await prisma.intakeConversation.update({ where: { id: conv.id }, data: { pendingSince: null, lastError: "no_residency" } });
    return { status: "failed" };
  }
  const actor: ActorCtx = { kind: "RESIDENT", userId: conv.residentId, name: r.user.displayName, vendorId: null };
  const facts: Record<string, string | number | boolean> = Object.fromEntries(Object.entries((conv.facts ?? {}) as Record<string, unknown>).filter(([k]) => k !== FILED_KEY)) as Record<string, string | number | boolean>;
  const residentWords = history.filter((m) => m.role === "resident").map((m) => m.text).join("\n");
  const secrets = secretsIn(r.unit.property.knowledge);
  let outcome: { message: string; filed: FiledRef[]; primary: IntakeResult | null } | null = null;

  const tools: Tool<any>[] = [
    {
      name: "lookup_building_notes",
      description: "Search this building's notes (shut-off valves, provided appliances, laundry room, access rules, heating system).",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      validate: (a) => (str(a.query, 120) ? { ok: true, args: { query: str(a.query, 120) } } : { ok: false, error: "query is required" }),
      run: async (a: { query: string }) => searchKnowledge(r.unit.propertyId, a.query, { residentFacing: true }),
    },
    {
      name: "find_my_recent_reports",
      description: "This resident's open and recent reports, to avoid filing the same problem twice or to find one to reopen.",
      parameters: { type: "object", properties: {} },
      validate: () => ({ ok: true, args: {} }),
      run: async () => {
        const rows = await prisma.case.findMany({
          where: { residentId: conv.residentId },
          orderBy: { createdAt: "desc" },
          take: 5,
          select: { number: true, title: true, status: true, createdAt: true, resolvedAt: true, assignments: { where: { status: "COMPLETED" }, select: { vendor: { select: { name: true } }, completedAt: true }, take: 1, orderBy: { completedAt: "desc" } } },
        });
        return {
          ok: true,
          reports: rows.map((c) => ({
            ref: caseRef(c.number),
            title: c.title,
            status: c.status,
            reported: c.createdAt.toISOString().slice(0, 10),
            repaired: c.assignments[0]?.completedAt?.toISOString().slice(0, 10) ?? null,
            can_reopen: c.status === "AWAITING_VERIFICATION" || (c.status === "RESOLVED" && !!c.resolvedAt && Date.now() - c.resolvedAt.getTime() < 30 * 86_400_000),
          })),
        };
      },
    },
    {
      name: "note_facts",
      description: "Record facts you have learned, for example {\"fixture\": \"kitchen sink\", \"leaking_now\": true}.",
      parameters: { type: "object", properties: { facts: { type: "object", description: "Short keys and short values" } }, required: ["facts"] },
      validate: (a) => {
        const f = cleanFacts(a.facts ?? a);
        return Object.keys(f).length ? { ok: true, args: f } : { ok: false, error: "Give at least one fact as a key and a short value." };
      },
      run: async (f: Record<string, string | number | boolean>) => {
        Object.assign(facts, f);
        return { ok: true, recorded: Object.keys(f) };
      },
    },
    {
      name: "reopen_my_report",
      description: "The resident says an earlier repair did not fix the problem: reopen that report instead of filing a new one.",
      parameters: REOPEN_SCHEMA,
      terminal: true,
      validate: (a) => {
        const m = /(\d{1,9})/.exec(str(a.ref, 20));
        const what = str(a.what_is_wrong, 500);
        return m && what.length >= 3 ? { ok: true, args: { number: Number(m[1]), what } } : { ok: false, error: "ref (for example RLY-0042) and what_is_wrong are required." };
      },
      run: async (a: { number: number; what: string }) => {
        const c = await prisma.case.findFirst({ where: { number: a.number, residentId: conv.residentId } });
        if (!c) return { ok: false, error: "That is not one of this resident's reports. Use a ref from find_my_recent_reports." };
        if (c.status === "AWAITING_VERIFICATION") await verifyResolution(actor, { caseId: c.id, resolved: false, note: a.what });
        else if (c.status === "RESOLVED" && c.resolvedAt && Date.now() - c.resolvedAt.getTime() < 30 * 86_400_000) await reopenCase(actor, { caseId: c.id, reason: a.what });
        else if (c.status === "REOPENED") {
          /* already reopened: nothing to change */
        } else return { ok: false, error: `${caseRef(c.number)} is ${c.status.toLowerCase().replace(/_/g, " ")}; it cannot be reopened. File a new report instead.` };
        const ref = caseRef(c.number);
        outcome = { message: `I've reopened ${ref} and told your property manager it is still not fixed: "${a.what}". You can follow it on this page.`, filed: [{ caseId: c.id, ref, action: "reopened" }], primary: null };
        return { ok: true, ref, reopened: true };
      },
    },
    {
      name: "submit_report",
      description: "File the report with the property manager. Call it once, after confirming the details with the resident (or at once for an emergency).",
      parameters: SUBMIT_SCHEMA,
      terminal: true,
      validate: (a) => validateSubmit(a, residentTurns),
      run: async (a: SubmitArgs) => {
        const group = a.more.length ? conv.id : null;
        const reading = (i: { category: SubmitArgs["category"]; severity: SubmitArgs["severity"]; title: string; summary: string }, primary: boolean) => ({
          category: i.category,
          severity: i.severity,
          title: i.title,
          summary: i.summary,
          rationale: a.rationale,
          needsReview: a.review,
          safetyConcerns: primary ? a.concerns : [],
          facts,
          observations: a.observations,
          assumptions: a.assumptions,
          openQuestions: a.openQuestions,
        });
        const primary = await createCase(actor, { unitId: r.unitId, channel: "CHAT", clientRequestId: conv.clientRequestId, description: residentWords, permissionToEnter: a.enter, accessNotes: a.access || null, intakeGroup: group, agent: reading(a, true) });
        const filed: FiledRef[] = [{ caseId: primary.caseId, ref: primary.ref, action: "filed" }];
        for (const [i, extra] of a.more.entries()) {
          const r2 = await createCase(actor, { unitId: r.unitId, channel: "CHAT", clientRequestId: `${conv.clientRequestId}:${i + 1}`, description: residentWords, permissionToEnter: a.enter, accessNotes: a.access || null, intakeGroup: group, agent: reading(extra, false) });
          filed.push({ caseId: r2.caseId, ref: r2.ref, action: "filed" });
        }
        const message = filed.length > 1 ? `${primary.message} The other problem${filed.length > 2 ? "s are" : " is"} saved separately as ${filed.slice(1).map((f) => f.ref).join(" and ")}.` : primary.message;
        outcome = { message, filed, primary };
        return { ok: true, ref: primary.ref, emergency: primary.emergency, message: primary.message, also_filed: filed.slice(1).map((f) => f.ref) };
      },
    },
  ];

  const started = Date.now();
  let steps: Step[] = [];
  // Written only while this turn is still the pending one: a run that was taken over can never overwrite the reply, or a
  // message the resident sent after it.
  const finishConversation = async (reply: string, status: "OPEN" | "SUBMITTED", lastError: string | null, filed: FiledRef[] = [], caseId: string | null = null) => {
    const prior = ((conv.facts ?? {}) as Record<string, unknown>)[FILED_KEY];
    const w = await prisma.intakeConversation.updateMany({
      where: { id: conv.id, pendingSince: conv.pendingSince },
      data: {
        status,
        pendingSince: null,
        lastError,
        ...(caseId ? { caseId } : {}),
        ...(status === "SUBMITTED" && conv.reviewSince && !conv.reviewOutcome ? { reviewOutcome: "filed", reviewedAt: new Date() } : {}),
        facts: { ...facts, [FILED_KEY]: [...(Array.isArray(prior) ? prior : []), ...filed] } as object,
        messages: [...history, { role: "relay", text: reply, at: new Date().toISOString() }] as object[],
      },
    });
    if (w.count === 0) mark("relay.agent.intake.superseded", { conversationId: conv.id });
    else if (status === "SUBMITTED" && conv.reviewSince && !conv.reviewOutcome) await settleReviewAlerts(conv.id);
  };
  try {
    faults.hit("intake.turn"); // test-only: a failure that is not the model's (the retry must still answer)
    const out = await traced("relay.agent.intake", { conversationId: conv.id, turn: residentTurns }, () =>
      runLoop(
        intakeSystemPrompt({ name: actor.name.split(" ")[0], unit: r.unit.label, property: r.unit.property.name, emergency: r.unit.property.emergencyInstructions, facts, now: new Date() }),
        history.map((m): ChatMessage => (m.role === "resident" ? { role: "user", content: m.text } : { role: "assistant", content: m.text })),
        tools,
        6,
        { deadlineAt: started + TURN_BUDGET_MS },
      ),
    );
    steps = out.steps;
    const done = outcome as { message: string; filed: FiledRef[]; primary: IntakeResult | null } | null;
    // After a submission the resident hears the server's result, never the model's wording.
    const raw = done ? done.message : out.text || "Sorry, I lost my train of thought. Could you say that again?";
    const guarded = done ? { text: raw, redacted: [] as string[] } : guardReply(raw, secrets);
    if (guarded.redacted.length) mark("relay.agent.intake.redacted", { conversationId: conv.id, count: guarded.redacted.length });
    await prisma.agentRun.update({
      where: { id: runId },
      data: { status: "SUCCEEDED", steps: steps as object[], finalText: `${guarded.text}${guarded.redacted.length ? ` [guard removed ${guarded.redacted.length} code-like value(s)]` : ""}`, finishedAt: new Date(), durationMs: Date.now() - started, caseId: done?.filed[0]?.caseId ?? null },
    });
    if (done) {
      await finishConversation(guarded.text, "SUBMITTED", null, done.filed, done.primary?.caseId ?? null);
      afterFiling(done.filed);
    } else await finishConversation(guarded.text, "OPEN", null);
    return { status: done ? "submitted" : "replied" };
  } catch (e) {
    const unavailable = e instanceof LlmUnavailable;
    await prisma.agentRun.update({ where: { id: runId }, data: { status: "FAILED", error: unavailable ? e.reason : (e as Error)?.name || "error", steps: steps as object[], finishedAt: new Date(), durationMs: Date.now() - started } });
    const done = outcome as { message: string; filed: FiledRef[]; primary: IntakeResult | null } | null;
    // If the report was already saved before the failure, the resident must still be told.
    if (done) {
      await finishConversation(done.message, "SUBMITTED", null, done.filed, done.primary?.caseId ?? null);
      afterFiling(done.filed);
      return { status: "submitted" };
    }
    if (unavailable || (conv.pendingAttempts ?? 0) + 1 >= MAX_TURN_ATTEMPTS) {
      await finishConversation(await failureReply(conv.id, unavailable), "OPEN", unavailable ? "ai_unavailable" : "error");
      return { status: "failed" };
    }
    throw e; // pg-boss retries once, and the retry takes this failed run over; the marker stays set, so the sweep recovers it too
  }
}

/** A filed or reopened case may wake the coordinator and send emails; both run after the commit, outside this job. */
function afterFiling(filed: FiledRef[]) {
  for (const f of filed) void kickCoordinator(f.caseId);
  kickEmail();
}

// ───────────────────────── voice calls ─────────────────────────
//
// A call runs between the resident's browser and the voice provider (ElevenLabs), not through this server. So the
// browser forwards the call as it happens (recordVoiceEvent), and the same safety net as a chat applies to it:
//   - every line the resident says is kept, in their words, before anything else happens to it;
//   - a possible emergency in those words is filed at once by the rules, whatever the voice agent does;
//   - a call that ends with nothing filed goes to the property's managers at once (a call cannot be resumed the way
//     a chat can), and a call that went silent without ending (a closed tab, a crash) goes to them from the sweep;
//   - when the voice agent files (submit_report), the call's record is closed with that case: one case either way.

const MAX_VOICE_LINES = 160;
const VOICE_EVENTS = ["connected", "resident", "relay", "ended"] as const;
export type VoiceEventResult = {
  conversationId: string;
  /** The call's report, once filed (by the safety rules on this event, or earlier by anyone). */
  filed: { caseId: string; ref: string; message: string } | null;
  /** The call ended with nothing filed, and a person now has what the resident said. */
  passed: boolean;
};

async function filedOf(caseId: string | null): Promise<VoiceEventResult["filed"]> {
  if (!caseId) return null;
  const k = await prisma.case.findUnique({ where: { id: caseId }, select: { number: true } });
  return k ? { caseId, ref: caseRef(k.number), message: `Your report is saved as ${caseRef(k.number)}.` } : null;
}

/**
 * One event of a resident's voice call, from their browser: the call connected (with the provider's id for it), a line
 * of the transcript (resident or relay), or the call ended. The call's record is keyed by the browser's id for the call
 * attempt (`attemptId`), which its submit_report also sends as the request id.
 */
export async function recordVoiceEvent(actor: ActorCtx, input: { unitId: string; attemptId: string; kind: string; text?: string; callId?: string }): Promise<VoiceEventResult> {
  const kind = VOICE_EVENTS.find((k) => k === input?.kind);
  if (!kind) throw new HttpError(400, "Unknown voice event.", { code: "invalid_event" });
  const attemptId = str(input?.attemptId, 80);
  if (attemptId.length < 8) throw new HttpError(400, "The call has no id.", { code: "invalid_event" });
  const line = kind === "resident" || kind === "relay" ? str(input?.text, 1500) : "";
  if ((kind === "resident" || kind === "relay") && !line) throw new HttpError(400, "The line is empty.", { code: "invalid_event" });
  const callId = str(input?.callId, 120) || null;
  const r = await residencyFor(actor.userId!, input?.unitId);
  const key = { residentId_clientRequestId: { residentId: actor.userId!, clientRequestId: attemptId } };

  for (let attempt = 0; attempt < 4; attempt++) {
    let c = await prisma.intakeConversation.findUnique({ where: key });
    if (!c) {
      try {
        c = await prisma.intakeConversation.create({ data: { residentId: actor.userId!, unitId: r.unitId, channel: "VOICE", clientRequestId: attemptId, externalId: callId } });
      } catch (e) {
        if ((e as { code?: string })?.code === "P2002") continue; // a concurrent event created it: read it again
        throw e;
      }
    }
    if (c.channel !== "VOICE" || c.unitId !== r.unitId) throw new HttpError(409, "That id belongs to another report.", { code: "invalid_event" });
    const done = { conversationId: c.id, passed: false };

    if (kind === "connected") {
      if (callId && c.externalId !== callId) await prisma.intakeConversation.update({ where: { id: c.id }, data: { externalId: callId } });
      return { ...done, filed: await filedOf(c.caseId) };
    }
    if (kind === "ended") {
      if (c.caseId) return { ...done, filed: await filedOf(c.caseId) };
      // A manager already read and closed it, and the resident has said nothing since (new words reopen it).
      if (c.reviewOutcome === "closed") return { ...done, filed: null, passed: true };
      // With nothing the resident said there is nothing for a person to read: the sweep closes the empty record.
      return { ...done, filed: null, passed: await flagForReview(c.id, "call_ended").catch(() => false) };
    }

    const lines = (Array.isArray(c.messages) ? c.messages : []) as ChatTurn[];
    if (lines.length >= MAX_VOICE_LINES) return { ...done, filed: await filedOf(c.caseId) };
    const role = kind === "resident" ? "resident" : "relay";
    const next: ChatTurn[] = [...lines, { role, text: line, at: new Date().toISOString() }];
    // A manager who closed an earlier review of this call has not heard this: a later end puts it in front of them again.
    const reopenReview = role === "resident" && c.reviewOutcome === "closed" ? { reviewSince: null, reviewReason: null, reviewOutcome: null, reviewedAt: null, reviewedById: null, reviewNote: null } : {};
    // Compare-and-set on the last change: two events never overwrite each other's line.
    const w = await prisma.intakeConversation.updateMany({
      where: { id: c.id, updatedAt: c.updatedAt },
      data: { messages: next as object[], ...(c.status === "ABANDONED" ? { status: "OPEN" as const } : {}), ...reopenReview },
    });
    if (w.count === 0) continue;
    if (role === "relay") return { ...done, filed: await filedOf(c.caseId) };

    const words = residentWordsOf(next);
    const screen = safetyScreen(words);
    if (!screen.emergency) return { ...done, filed: await filedOf(c.caseId) };
    if (c.caseId) {
      await warnFiledCase(c.id, c.caseId, words, screen.reasons).catch((e) => console.warn("[voice] could not warn the managers:", (e as Error)?.name));
      return { ...done, filed: await filedOf(c.caseId) };
    }
    const f = await fileFromChat(c.id, { kind: "SAFETY_NET" }).catch((e) => {
      console.warn("[voice] the safety net could not file the report; the call's end or the sweep passes it to a person:", (e as Error)?.name);
      return null;
    });
    if (f) {
      mark("relay.intake.safety_net.filed", { conversationId: c.id, caseId: f.caseId, channel: "VOICE" });
      return { ...done, filed: { caseId: f.caseId, ref: f.ref, message: f.message || `Your report is saved as ${f.ref}.` } };
    }
    return { ...done, filed: null };
  }
  throw new HttpError(409, "The call's record kept changing. Try again.", { code: "voice_event_conflict" });
}

/**
 * The call's report was filed as something other than an emergency (by the voice agent, from its own summary), but
 * the resident's own words on the call read as a possible emergency to the rules: the property's managers are told
 * at once, on that case, once per call. A person decides; nothing on the case changes by itself.
 */
async function warnFiledCase(conversationId: string, caseId: string, words: string, reasons: string[]) {
  const k = await prisma.case.findUnique({ where: { id: caseId }, include: { unit: true, resident: { select: { displayName: true } } } });
  if (!k || k.emergency) return;
  const ref = caseRef(k.number);
  const said = words.length > 300 ? `…${words.slice(-297)}` : words;
  await prisma.$transaction(async (tx) =>
    notify(tx, await managerIds(tx, k.propertyId), k.id, `voice-danger:${conversationId}`, {
      kind: "EMERGENCY",
      event: "intake.safety_net",
      title: `Possible emergency on ${ref}: what the resident said on the call`,
      body: `${k.resident.displayName}, unit ${k.unit.label}, said on the voice call: "${said}" The safety rules read this as a possible emergency (${reasons.join(" ")}), but ${ref} was filed as ${k.severity.toLowerCase()}. Check it now.`,
    }),
  );
  kickEmail();
  mark("relay.intake.safety_net.warned", { conversationId, caseId });
}

/** The voice agent filed the call's report: the call's record is closed with that case, and any review of it settled. */
async function closeCallWithCase(actor: ActorCtx, attemptId: string, filed: { caseId: string; ref: string }) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const c = await prisma.intakeConversation.findUnique({ where: { residentId_clientRequestId: { residentId: actor.userId!, clientRequestId: attemptId } } });
    if (!c || c.channel !== "VOICE" || c.caseId) return false;
    const now = new Date();
    const prior = ((c.facts ?? {}) as Record<string, unknown>)[FILED_KEY];
    const inReview = !!c.reviewSince && !c.reviewOutcome;
    const w = await prisma.intakeConversation.updateMany({
      where: { id: c.id, caseId: null, updatedAt: c.updatedAt },
      data: {
        status: "SUBMITTED",
        caseId: filed.caseId,
        facts: { ...((c.facts ?? {}) as object), [FILED_KEY]: [...(Array.isArray(prior) ? prior : []), { caseId: filed.caseId, ref: filed.ref, action: "filed" }] } as object,
        ...(inReview ? { reviewOutcome: "filed", reviewedAt: now } : {}),
      },
    });
    if (w.count === 1) {
      if (inReview) await settleReviewAlerts(c.id);
      return true;
    }
  }
  return false;
}

/** The voice agent's submit_report (an ElevenLabs client tool) arrives here from the resident's browser session. */
export async function submitVoiceReport(actor: ActorCtx, input: Record<string, unknown>) {
  const unitId = str(input?.unitId, 60);
  const category = oneOf(input?.category, CATEGORIES) ?? "OTHER";
  const severity = oneOf(input?.severity, SEVERITIES) ?? "URGENT";
  const description = str(input?.description, 2000);
  if (description.length < 8) throw new HttpError(400, "The description is missing.", { code: "invalid_report" });
  // The call's id: if the safety rules already filed this call, the same id returns that case instead of a second one.
  const clientRequestId = str(input?.clientRequestId, 80) || randomUUID();
  const res = await createCase(actor, {
    unitId,
    channel: "VOICE",
    clientRequestId,
    description,
    permissionToEnter: bool(input?.permission_to_enter),
    accessNotes: str(input?.access_notes, 300) || null,
    agent: {
      category,
      severity,
      title: str(input?.title, 80),
      summary: str(input?.summary, 500),
      rationale: str(input?.rationale, 300),
      needsReview: bool(input?.needs_human_review),
      safetyConcerns: (Array.isArray(input?.safety_concerns) ? input.safety_concerns : typeof input?.safety_concerns === "string" ? [input.safety_concerns] : []).map((s) => str(s, 160)),
      facts: (input?.facts as Record<string, unknown>) ?? {},
    },
  });
  await closeCallWithCase(actor, clientRequestId, res).catch((e) => console.warn("[voice] could not close the call's record:", (e as Error)?.name));
  return res;
}
