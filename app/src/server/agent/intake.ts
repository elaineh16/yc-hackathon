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
import { createCase, type IntakeResult } from "../cases/intake";
import { type ActorCtx, faults } from "../cases/engine";
import { reopenCase, verifyResolution } from "../cases/flow";
import { kickEmail } from "../notify/email";
import { mark, traced } from "../tracing";
import { kickCoordinator } from "./coordinator";
import { guardReply, intakeSystemPrompt, REOPEN_SCHEMA, secretsIn, SUBMIT_SCHEMA, type SubmitArgs, validateSubmit } from "./intakePolicy";
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
    const mine = await prisma.intakeConversation.findFirst({ where: { id: input.conversationId, residentId: actor.userId!, unitId: r.unitId }, include: { case: { select: { number: true } } } });
    if (mine) return view(mine, mine.case ? caseRef(mine.case.number) : null);
  }
  if (!input.fresh) {
    const open = await prisma.intakeConversation.findFirst({ where: { residentId: actor.userId!, unitId: r.unitId, status: "OPEN" }, orderBy: { createdAt: "desc" } });
    if (open) return view(open, null);
  } else {
    await prisma.intakeConversation.updateMany({ where: { residentId: actor.userId!, unitId: r.unitId, status: "OPEN" }, data: { status: "ABANDONED", pendingSince: null } });
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
  if (!conv || conv.residentId !== actor.userId) throw new HttpError(404, "Conversation not found.");
  if (conv.status !== "OPEN") throw new HttpError(409, "This conversation is closed. Start a new report.", { code: "conversation_closed" });
  // Every turn resends the conversation to the model, so a conversation has a length limit.
  if ((conv.messages as ChatTurn[]).filter((m) => m.role === "resident").length >= MAX_RESIDENT_MESSAGES) {
    throw new HttpError(409, "This conversation has gone on for a while. Send what you have with the form (it keeps your words), or start a new conversation.", { code: "conversation_too_long" });
  }
  await residencyFor(actor.userId!, conv.unitId);
  const history = [...(conv.messages as ChatTurn[]), { role: "resident" as const, text, at: new Date().toISOString() }];
  // Compare-and-set: one message at a time, so a double send cannot queue two replies.
  const saved = await prisma.intakeConversation.updateMany({ where: { id: conv.id, status: "OPEN", pendingSince: null }, data: { messages: history, pendingSince: new Date(), pendingAttempts: 0, lastError: null } });
  if (saved.count === 0) throw new HttpError(409, "Relay is still replying to your last message.", { code: "turn_pending" });
  await kickIntake(conv.id);
  return reload(conv.id);
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
      await prisma.intakeConversation.updateMany({
        where: { id: conv.id, pendingSince: conv.pendingSince },
        data: answered ? { pendingSince: null } : { pendingSince: null, lastError: "error", messages: [...history, { role: "relay", text: SORRY_REPLY, at: new Date().toISOString() }] as object[] },
      });
      return { status: answered ? "already_done" : "failed" };
    } else {
      // Still running: taken over only once it is past any turn's deadline (the server stopped mid-run).
      const takeover = await prisma.agentRun.updateMany({ where: { id: prior.id, status: "RUNNING", createdAt: { lt: new Date(Date.now() - STALE_TURN_MS) } }, data: { createdAt: new Date(), error: "taken over after an interrupted run" } });
      if (takeover.count === 0) return { status: "already_running" };
      runId = prior.id;
    }
  }
  await prisma.intakeConversation.update({ where: { id: conv.id }, data: { pendingAttempts: { increment: 1 } } });

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
        facts: { ...facts, [FILED_KEY]: [...(Array.isArray(prior) ? prior : []), ...filed] } as object,
        messages: [...history, { role: "relay", text: reply, at: new Date().toISOString() }] as object[],
      },
    });
    if (w.count === 0) mark("relay.agent.intake.superseded", { conversationId: conv.id });
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
      await finishConversation(unavailable ? OFFLINE_REPLY : SORRY_REPLY, "OPEN", unavailable ? "ai_unavailable" : "error");
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

/** The voice agent's submit_report (an ElevenLabs client tool) arrives here from the resident's browser session. */
export async function submitVoiceReport(actor: ActorCtx, input: Record<string, unknown>) {
  const unitId = str(input?.unitId, 60);
  const category = oneOf(input?.category, CATEGORIES) ?? "OTHER";
  const severity = oneOf(input?.severity, SEVERITIES) ?? "URGENT";
  const description = str(input?.description, 2000);
  if (description.length < 8) throw new HttpError(400, "The description is missing.", { code: "invalid_report" });
  return createCase(actor, {
    unitId,
    channel: "VOICE",
    clientRequestId: str(input?.clientRequestId, 80) || randomUUID(),
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
}
