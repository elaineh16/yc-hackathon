// The intake agent: a resident describes a problem in their own words; the model works out what matters, asks the
// questions this particular situation needs, looks things up, and files the report with submit_report.
// Policy around it: the report is saved only by the server, the resident's own words are kept verbatim, and the
// reply after submission is the server's result, not the model's paraphrase.
import { randomUUID } from "node:crypto";
import { HttpError, prisma } from "wasp/server";
import { caseRef, CATEGORIES, CATEGORY_SHORT, type Category, SEVERITIES, type Severity } from "../../shared/domain";
import { QUESTIONS } from "../../shared/intake";
import { createCase, type IntakeResult } from "../cases/intake";
import type { ActorCtx } from "../cases/engine";
import { traced } from "../tracing";
import { searchKnowledge, searchPastCases } from "./knowledge";
import { LlmUnavailable, llmConfig, type ChatMessage } from "./llm";
import { bool, cleanFacts, oneOf, runLoop, str, type Step, type Tool } from "./loop";

export type ChatTurn = { role: "resident" | "relay"; text: string; at: string };
export type ConversationView = {
  id: string;
  status: "OPEN" | "SUBMITTED" | "ABANDONED";
  messages: ChatTurn[];
  facts: Record<string, string | number | boolean>;
  caseId: string | null;
  caseRef: string | null;
  unitId: string;
};

const view = (c: { id: string; status: string; messages: unknown; facts: unknown; caseId: string | null; unitId: string }, ref: string | null): ConversationView => ({
  id: c.id,
  status: c.status as ConversationView["status"],
  messages: (Array.isArray(c.messages) ? c.messages : []) as ChatTurn[],
  facts: (c.facts && typeof c.facts === "object" ? c.facts : {}) as ConversationView["facts"],
  caseId: c.caseId,
  caseRef: ref,
  unitId: c.unitId,
});

async function residencyFor(actor: ActorCtx, unitId: unknown) {
  if (typeof unitId !== "string") throw new HttpError(400, "Choose your unit.");
  const r = await prisma.residency.findFirst({ where: { userId: actor.userId!, unitId, active: true }, include: { unit: { include: { property: true } } } });
  if (!r) throw new HttpError(403, "You can only report issues for a unit you live in.");
  return r;
}

/** The open conversation for this resident and unit, or a new one with Relay's greeting. */
export async function getConversation(actor: ActorCtx, input: { unitId: string; fresh?: boolean }): Promise<ConversationView> {
  const r = await residencyFor(actor, input?.unitId);
  if (!input.fresh) {
    const open = await prisma.intakeConversation.findFirst({ where: { residentId: actor.userId!, unitId: r.unitId, status: "OPEN" }, orderBy: { createdAt: "desc" } });
    if (open) return view(open, null);
  } else {
    await prisma.intakeConversation.updateMany({ where: { residentId: actor.userId!, unitId: r.unitId, status: "OPEN" }, data: { status: "ABANDONED" } });
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

function systemPrompt(o: { name: string; unit: string; property: string; emergency: string; facts: Record<string, unknown>; now: Date }) {
  const checklist = (Object.keys(QUESTIONS) as Category[])
    .filter((k) => QUESTIONS[k].length)
    .map((k) => `- ${CATEGORY_SHORT[k]}: ${QUESTIONS[k].map((q) => q.label.replace(/\?$/, "").toLowerCase()).join("; ")}`)
    .join("\n");
  return `You are Relay, an AI assistant that helps residents of ${o.property} report maintenance problems. You are talking with ${o.name} in unit ${o.unit}. It is ${o.now.toISOString().slice(0, 16).replace("T", " ")} UTC.

Your job: understand the problem well enough that a property manager can act on it, then file it with submit_report.

How to work:
- Read what the resident wrote and decide what is still unknown. Ask one or two short questions at a time, only about things that matter for this problem. Do not run through a fixed list.
- Things that often matter (a guide, not a script):
${checklist}
- Always find out whether anything is dangerous right now: gas smell, smoke, sparks, burning, water near electrics, flooding, no heat in freezing weather for someone at risk. If something is dangerous, tell them what to do now (the property's emergency instructions: "${o.emergency}") and submit straight away with the concern listed in safety_concerns.
- Use lookup_building_notes when the building's own information would help (shut-off valves, which appliances are provided, access rules). Use find_my_recent_reports if this might already be reported.
- Record what you learn with note_facts as you go (short keys, short values).
- Before submitting, read the key details back in one sentence and get the resident's confirmation, unless it is an emergency.
- Never diagnose the cause, never promise a time, price or vendor, and never say the report is saved: the system confirms that.
- Keep each message to two or three short sentences. Plain, friendly language.

Facts recorded so far: ${JSON.stringify(o.facts)}`;
}

const SUBMIT_SCHEMA = {
  type: "object",
  properties: {
    category: { type: "string", enum: [...CATEGORIES], description: "PLUMBING, APPLIANCE, HVAC, or OTHER if it fits none of them" },
    severity: { type: "string", enum: [...SEVERITIES], description: "EMERGENCY if anyone or the building is in danger now; URGENT if it gets worse or blocks daily life; otherwise ROUTINE" },
    title: { type: "string", description: "A short title, at most 8 words" },
    summary: { type: "string", description: "Two or three sentences with everything you learned" },
    rationale: { type: "string", description: "One sentence: why this category and severity" },
    safety_concerns: { type: "array", items: { type: "string" }, description: "Each danger the resident mentioned; empty if none" },
    needs_human_review: { type: "boolean", description: "true if you are unsure what this is or who should handle it" },
    permission_to_enter: { type: "boolean", description: "Whether the resident allows entry when they are out" },
    access_notes: { type: "string", description: "Pets, times to avoid, entry instructions; empty if none" },
  },
  required: ["category", "severity", "title", "summary", "rationale"],
};

export async function sendIntakeMessage(actor: ActorCtx, input: { conversationId: string; text: string }) {
  const text = str(input?.text, 1500);
  if (text.length < 1) throw new HttpError(400, "Write a message first.");
  const conv = await prisma.intakeConversation.findUnique({ where: { id: String(input?.conversationId ?? "") } });
  if (!conv || conv.residentId !== actor.userId) throw new HttpError(404, "Conversation not found.");
  if (conv.status !== "OPEN") throw new HttpError(409, "This conversation is closed. Start a new report.", { code: "conversation_closed" });
  const r = await residencyFor(actor, conv.unitId);

  // Save the resident's message before anything else can fail.
  const history = [...(conv.messages as ChatTurn[]), { role: "resident" as const, text, at: new Date().toISOString() }];
  await prisma.intakeConversation.update({ where: { id: conv.id }, data: { messages: history } });

  const facts: Record<string, string | number | boolean> = { ...(conv.facts as Record<string, string | number | boolean>) };
  let submitted: IntakeResult | null = null;
  const residentTurns = history.filter((m) => m.role === "resident").length;
  const residentWords = history.filter((m) => m.role === "resident").map((m) => m.text).join("\n");

  const tools: Tool<any>[] = [
    {
      name: "lookup_building_notes",
      description: "Search this building's notes (shut-off valves, provided appliances, laundry room, access rules, heating system).",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      validate: (a) => (str(a.query, 120) ? { ok: true, args: { query: str(a.query, 120) } } : { ok: false, error: "query is required" }),
      run: async (a: { query: string }) => searchKnowledge(r.unit.propertyId, a.query),
    },
    {
      name: "find_my_recent_reports",
      description: "This resident's open and recent reports, to avoid filing the same problem twice.",
      parameters: { type: "object", properties: {} },
      validate: () => ({ ok: true, args: {} }),
      run: async () => {
        const rows = await prisma.case.findMany({ where: { residentId: actor.userId! }, orderBy: { createdAt: "desc" }, take: 5, select: { number: true, title: true, status: true, createdAt: true } });
        return { ok: true, reports: rows.map((c) => ({ ref: caseRef(c.number), title: c.title, status: c.status, reported: c.createdAt.toISOString().slice(0, 10) })) };
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
      name: "submit_report",
      description: "File the report with the property manager. Call it once, after confirming the details with the resident (or at once for an emergency).",
      parameters: SUBMIT_SCHEMA,
      terminal: true,
      validate: (a) => {
        const category = oneOf(a.category, CATEGORIES);
        const severity = oneOf(a.severity, SEVERITIES);
        const title = str(a.title, 80);
        const summary = str(a.summary, 500);
        if (!category || !severity || !title || !summary) return { ok: false, error: "category, severity, title and summary are required (category and severity from the allowed values)." };
        const concerns = (Array.isArray(a.safety_concerns) ? a.safety_concerns : []).map((s) => str(s, 160)).filter(Boolean);
        if (residentTurns < 2 && severity !== "EMERGENCY" && concerns.length === 0) {
          return { ok: false, error: "Not submitted. Read the key details back to the resident and get their confirmation first." };
        }
        return {
          ok: true,
          args: { category, severity, title, summary, rationale: str(a.rationale, 300), concerns, review: bool(a.needs_human_review), enter: bool(a.permission_to_enter), access: str(a.access_notes, 300) },
        };
      },
      run: async (a: { category: Category; severity: Severity; title: string; summary: string; rationale: string; concerns: string[]; review: boolean; enter: boolean; access: string }) => {
        submitted = await createCase(actor, {
          unitId: r.unitId,
          channel: "CHAT",
          clientRequestId: conv.clientRequestId,
          description: residentWords,
          permissionToEnter: a.enter,
          accessNotes: a.access || null,
          agent: { category: a.category, severity: a.severity, title: a.title, summary: a.summary, rationale: a.rationale, needsReview: a.review, safetyConcerns: a.concerns, facts },
        });
        return { ok: true, ref: submitted.ref, emergency: submitted.emergency, message: submitted.message };
      },
    },
  ];

  const started = Date.now();
  const run = await prisma.agentRun.create({ data: { kind: "INTAKE", conversationId: conv.id, trigger: "RESIDENT_MESSAGE", model: llmConfig().model } });
  let steps: Step[] = [];
  let reply: string;
  try {
    const out = await traced("relay.agent.intake", { conversationId: conv.id, turn: residentTurns }, () =>
      runLoop(
        systemPrompt({ name: actor.name.split(" ")[0], unit: r.unit.label, property: r.unit.property.name, emergency: r.unit.property.emergencyInstructions, facts, now: new Date() }),
        history.map((m): ChatMessage => (m.role === "resident" ? { role: "user", content: m.text } : { role: "assistant", content: m.text })),
        tools,
        5,
      ),
    );
    steps = out.steps;
    const saved = submitted as IntakeResult | null;
    reply = saved ? saved.message : out.text || "Sorry, I lost my train of thought. Could you say that again?";
  } catch (e) {
    const unavailable = e instanceof LlmUnavailable;
    await prisma.agentRun.update({ where: { id: run.id }, data: { status: "FAILED", error: unavailable ? e.reason : "error", steps: steps as object[], finishedAt: new Date(), durationMs: Date.now() - started } });
    // If the report was already saved before the failure, the resident must still be told.
    const saved = submitted as IntakeResult | null;
    if (saved) {
      await finishConversation(conv.id, history, facts, saved);
      return { ...(await reload(conv.id)), notice: null };
    }
    throw new HttpError(503, "Relay's assistant is not available right now. Your message is kept; you can use the form instead.", { code: "ai_unavailable" });
  }
  await prisma.agentRun.update({ where: { id: run.id }, data: { status: "SUCCEEDED", steps: steps as object[], finalText: reply, finishedAt: new Date(), durationMs: Date.now() - started, caseId: (submitted as IntakeResult | null)?.caseId ?? null } });
  const saved = submitted as IntakeResult | null;
  if (saved) await finishConversation(conv.id, history, facts, saved);
  else await prisma.intakeConversation.update({ where: { id: conv.id }, data: { messages: [...history, { role: "relay", text: reply, at: new Date().toISOString() }], facts } });
  return { ...(await reload(conv.id)), notice: null };
}

async function finishConversation(id: string, history: ChatTurn[], facts: object, result: IntakeResult) {
  await prisma.intakeConversation.update({
    where: { id },
    data: { status: "SUBMITTED", caseId: result.caseId, facts, messages: [...history, { role: "relay", text: result.message, at: new Date().toISOString() }] },
  });
}

async function reload(id: string): Promise<ConversationView> {
  const c = await prisma.intakeConversation.findUniqueOrThrow({ where: { id }, include: { case: { select: { number: true } } } });
  return view(c, c.case ? caseRef(c.case.number) : null);
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
