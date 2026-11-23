// The coordinator: an event-driven agent that looks after each open case.
//
// Wake-up:  a case transition sets Case.agentPending* in the same transaction (see engine.ts). After commit the
//           action calls kickCoordinator(); a pg-boss job then runs runCoordinator(). The minute sweep re-queues any
//           marker left set, so a crash or restart never loses a trigger.
// Reasoning: the model reads the case, vendors, building notes and past cases through tools, then proposes.
// Policy:   deterministic code decides what each proposal may do. Offering a ROUTINE job runs automatically only when
//           the property turned on autopilot; everything else waits for a manager. Messages to residents always wait.
//           The agent can escalate (the safer direction) but can never approve spending, schedule, close or cancel.
// Record:   every run is stored with its trigger, model, each tool call and its real result, and how it ended.
import { HttpError, prisma } from "wasp/server";
import { coordinatorJob } from "wasp/server/jobs";
import { caseRef, CATEGORY_SHORT, formatMoney } from "../../shared/domain";
import { canPerform } from "../../shared/machine";
import { assertCaseAccess } from "../access";
import { type ActorCtx, AGENT, addEvent, CASE_INCLUDE, flagForCoordinator, fmtWindow, liveAssignment, type LoadedCase, managerIds, move, notify, withCase } from "../cases/engine";
import { offerVendorTx } from "../cases/flow";
import { mark, traced } from "../tracing";
import { searchKnowledge, searchPastCases } from "./knowledge";
import { LlmUnavailable, llmConfig, llmStatus } from "./llm";
import { runLoop, type Step, str, type Tool } from "./loop";

// Debounce: one queued job per case at a time. This is an optimisation only; correctness comes from the durable
// marker on the case and the one-run-per-trigger key, and the sweep re-queues anything a restart lost.
const queuedAt = new Map<string, number>();

/** Queue a coordinator run for this case if something is pending. Safe to call after any write; never throws. */
export async function kickCoordinator(caseId: string | null | undefined) {
  if (!caseId) return;
  try {
    const c = await prisma.case.findUnique({ where: { id: caseId }, select: { agentPendingSince: true } });
    if (!c?.agentPendingSince) return;
    if (Date.now() - (queuedAt.get(caseId) ?? 0) < 120_000) return;
    queuedAt.set(caseId, Date.now());
    await coordinatorJob.submit({ caseId });
  } catch (e) {
    queuedAt.delete(caseId);
    console.warn("[coordinator] could not queue a run; the sweep will retry:", (e as Error)?.name);
  }
}

/** pg-boss entry point. */
export const coordinatorJobFn = async (args: { caseId: string }, _ctx: unknown) => runCoordinator(String(args?.caseId ?? ""));

export async function runCoordinator(caseId: string): Promise<{ status: string; runId?: string }> {
  const pending = await prisma.case.findUnique({ where: { id: caseId }, select: { agentPendingSince: true, agentPendingTrigger: true, agentPendingEventId: true } });
  if (!pending?.agentPendingSince) return { status: "nothing_pending" };
  const trigger = pending.agentPendingTrigger ?? "MANUAL";
  const triggerKey = `${caseId}:${trigger}:${pending.agentPendingEventId ?? 0}`;
  const clearPending = () =>
    prisma.case.updateMany({ where: { id: caseId, agentPendingTrigger: pending.agentPendingTrigger, agentPendingEventId: pending.agentPendingEventId }, data: { agentPendingSince: null, agentPendingTrigger: null, agentPendingEventId: null } });

  // Claim the trigger: one run per (case, trigger, event), so a retried or duplicated job does nothing.
  let runId: string;
  try {
    runId = (await prisma.agentRun.create({ data: { kind: "COORDINATOR", caseId, trigger, triggerKey, model: llmConfig().model } })).id;
  } catch (e) {
    if ((e as { code?: string })?.code !== "P2002") throw e;
    const prior = await prisma.agentRun.findUnique({ where: { triggerKey } });
    if (prior && prior.status === "RUNNING" && Date.now() - prior.createdAt.getTime() > 15 * 60_000) {
      await prisma.agentRun.update({ where: { id: prior.id }, data: { status: "FAILED", error: "abandoned (server restarted mid-run)", finishedAt: new Date() } });
    }
    if (prior && prior.status !== "RUNNING") await clearPending();
    return { status: "already_claimed", runId: prior?.id };
  }

  const started = Date.now();
  const finish = async (status: "SUCCEEDED" | "FAILED" | "SKIPPED", steps: Step[], finalText: string | null, error: string | null) => {
    await prisma.agentRun.update({ where: { id: runId }, data: { status, steps: steps as object[], finalText, error, finishedAt: new Date(), durationMs: Date.now() - started } });
    await clearPending();
    // A newer trigger may have arrived while this run was thinking.
    queuedAt.delete(caseId);
    await kickCoordinator(caseId);
  };

  const model = await llmStatus();
  if (!model.available) {
    await withCase(caseId, async (tx, c) => {
      await addEvent(tx, c.id, AGENT, { type: "AI_UNAVAILABLE", audience: "MANAGEMENT", message: `Relay AI could not review this (${trigger.toLowerCase().replace(/_/g, " ")}): ${model.reason} The case continues manually.` });
    });
    await finish("SKIPPED", [], null, model.reason);
    return { status: "skipped", runId };
  }

  const steps: Step[] = [];
  try {
    const out = await traced("relay.agent.coordinator", { caseId, trigger }, () => reason(caseId, runId, trigger));
    steps.push(...out.steps);
    await finish("SUCCEEDED", steps, out.text, out.endedBy === "step_limit" ? "stopped at the step limit" : null);
    mark("relay.agent.coordinator.done", { caseId, trigger, steps: steps.length });
    return { status: "succeeded", runId };
  } catch (e) {
    const why = e instanceof LlmUnavailable ? e.reason : (e as Error)?.name || "error";
    await finish("FAILED", steps, null, why);
    if (e instanceof LlmUnavailable) return { status: "failed", runId }; // nothing to retry against: the model is gone
    throw e; // let pg-boss retry real errors
  }
}

type Snapshot = Awaited<ReturnType<typeof snapshot>>;
async function snapshot(caseId: string) {
  const c = await prisma.case.findUniqueOrThrow({ where: { id: caseId }, include: CASE_INCLUDE });
  const events = await prisma.caseEvent.findMany({ where: { caseId }, orderBy: { id: "desc" }, take: 15 });
  return { c, events: events.reverse() };
}
function describe(s: Snapshot) {
  const { c } = s;
  return {
    ref: caseRef(c.number),
    title: c.title,
    status: c.status,
    waiting_on: c.holder,
    next_action: c.nextAction,
    category: CATEGORY_SHORT[c.category],
    severity: c.severity,
    emergency: c.emergency,
    needs_human_review: c.needsReview,
    property: c.property.name,
    unit: c.unit.label,
    reported: c.createdAt.toISOString(),
    resident_words: c.description,
    summary: c.summary,
    facts: c.details,
    triage_reasons: c.triageReasons,
    permission_to_enter: c.permissionToEnter,
    vendor_history: c.assignments.map((a) => ({
      vendor: a.vendor.name,
      status: a.status,
      offered: a.offeredAt.toISOString().slice(0, 16),
      decline_reason: a.declineReason,
      estimate: a.estimateType === "FIXED" && a.estimateCents !== null ? formatMoney(a.estimateCents) : a.estimateType === "INSPECTION_REQUIRED" ? "inspection first" : null,
      approval: a.approval?.status ?? null,
      visit_windows: a.slots.map((sl) => `${fmtWindow(sl.startAt, sl.endAt)} (${sl.status.toLowerCase()})`),
    })),
    recent_history: s.events.map((e) => `${e.createdAt.toISOString().slice(0, 16)} ${e.actorName}: ${e.message}`),
  };
}

const PROMPT = (property: string, trigger: string, autopilot: boolean) => `You are Relay's maintenance coordinator for ${property}. Something just happened on a case (${trigger.toLowerCase().replace(/_/g, " ")}). Work out the best next step and act through your tools.

Steps:
1. Call get_case to read it.
2. Decide what the case needs now. Typical needs: a vendor (when it is waiting for one), a short factual update to the resident (when something changed that affects them), escalation (when it may be dangerous), or nothing.
3. If it needs a vendor: call list_vendors and choose the best fit from what the tools return (trade, current workload, completed jobs, anyone who already declined or did not respond on this case). Use search_past_cases to see who handled similar problems here. Then call propose_vendor with a one-sentence rationale. ${autopilot ? "For routine cases the property allows Relay to send the offer automatically." : "A manager will approve your proposal before anything is sent."}
4. Always finish by calling record_assessment with two or three plain sentences: what is going on, what you did, and what happens next.

Rules:
- Use only facts from the tools. Never invent prices, availability, appointment times or causes.
- Never propose a vendor for an emergency or escalated case, or one that needs human review: record an assessment for the manager instead.
- You cannot approve spending, schedule visits, close or cancel cases. Do not pretend to.
- Messages to residents must be short, factual and free of promises.`;

async function reason(caseId: string, runId: string, trigger: string) {
  const first = await snapshot(caseId);
  const propertyId = first.c.propertyId;
  const refs = new Map<string, string>(); // "V1" -> vendor id, filled by list_vendors

  const tools: Tool<any>[] = [
    {
      name: "get_case",
      description: "Read the case: status, who it is waiting on, the resident's words, facts, vendor history and recent events.",
      parameters: { type: "object", properties: {} },
      validate: () => ({ ok: true, args: {} }),
      run: async () => ({ ok: true, case: describe(await snapshot(caseId)) }),
    },
    {
      name: "list_vendors",
      description: "Approved vendors for this case's trade, with their current workload and history. Returns refs like V1 to use in propose_vendor.",
      parameters: { type: "object", properties: {} },
      validate: () => ({ ok: true, args: {} }),
      run: async () => {
        const s = await snapshot(caseId);
        const vendors = await prisma.vendor.findMany({
          where: { approved: true, ...(s.c.category === "OTHER" ? {} : { trades: { has: s.c.category } }) },
          include: { _count: { select: { users: true } }, assignments: { select: { status: true, caseId: true } } },
          orderBy: { name: "asc" },
        });
        refs.clear();
        return {
          ok: true,
          vendors: vendors.map((v, i) => {
            refs.set(`V${i + 1}`, v.id);
            const here = v.assignments.filter((a) => a.caseId === caseId).map((a) => a.status.toLowerCase());
            return {
              ref: `V${i + 1}`,
              name: v.name,
              trades: v.trades.map((t) => CATEGORY_SHORT[t]),
              open_jobs_now: v.assignments.filter((a) => a.status === "OFFERED" || a.status === "ACCEPTED").length,
              completed_jobs: v.assignments.filter((a) => a.status === "COMPLETED").length,
              declined_or_lapsed_before: v.assignments.filter((a) => a.status === "DECLINED" || a.status === "EXPIRED").length,
              on_this_case_already: here.length ? here.join(", ") : "no",
              has_relay_login: v._count.users > 0,
            };
          }),
          note: vendors.length ? undefined : "No approved vendor covers this trade. Record an assessment asking the manager to add one.",
        };
      },
    },
    {
      name: "search_building_notes",
      description: "Search the property's own notes (equipment, shut-off valves, access rules, preferred practices).",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      validate: (a) => (str(a.query, 120) ? { ok: true, args: { query: str(a.query, 120) } } : { ok: false, error: "query is required" }),
      run: async (a: { query: string }) => searchKnowledge(propertyId, a.query),
    },
    {
      name: "search_past_cases",
      description: "Earlier cases at this property that look similar, with who handled them and how they ended.",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      validate: (a) => (str(a.query, 120) ? { ok: true, args: { query: str(a.query, 120) } } : { ok: false, error: "query is required" }),
      run: async (a: { query: string }) => searchPastCases(propertyId, a.query, caseId),
    },
    {
      name: "propose_vendor",
      description: "Propose offering the job to one vendor from list_vendors.",
      parameters: {
        type: "object",
        properties: { vendor: { type: "string", description: "The vendor's ref from list_vendors (for example V1) or exact name" }, rationale: { type: "string", description: "One sentence, based on the tool results" } },
        required: ["vendor", "rationale"],
      },
      validate: (a) => {
        const key = str(a.vendor, 80);
        const rationale = str(a.rationale, 300);
        if (!key || !rationale) return { ok: false, error: "vendor and rationale are required" };
        return { ok: true, args: { key, rationale } };
      },
      run: async (a: { key: string; rationale: string }) => proposeVendor(caseId, runId, a.key, a.rationale, refs),
    },
    {
      name: "propose_resident_update",
      description: "Draft a short factual update for the resident. A manager reviews it before it is sent.",
      parameters: { type: "object", properties: { message: { type: "string" }, rationale: { type: "string" } }, required: ["message", "rationale"] },
      validate: (a) => {
        const message = str(a.message, 400);
        if (message.length < 10) return { ok: false, error: "Write the message (at least a sentence)." };
        return { ok: true, args: { message, rationale: str(a.rationale, 300) || "Keep the resident informed." } };
      },
      run: async (a: { message: string; rationale: string }) => proposeResidentUpdate(caseId, runId, a.message, a.rationale),
    },
    {
      name: "recommend_escalation",
      description: "Escalate the case to the property manager because it may be dangerous or urgent beyond routine handling.",
      parameters: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"] },
      validate: (a) => (str(a.reason, 300).length >= 8 ? { ok: true, args: { reason: str(a.reason, 300) } } : { ok: false, error: "Give the reason in a sentence." }),
      run: async (a: { reason: string }) => escalate(caseId, runId, a.reason),
    },
    {
      name: "record_assessment",
      description: "Save your reading of the case for the manager: what is going on, what you did, what happens next.",
      parameters: { type: "object", properties: { assessment: { type: "string" } }, required: ["assessment"] },
      validate: (a) => (str(a.assessment, 600).length >= 20 ? { ok: true, args: { assessment: str(a.assessment, 600) } } : { ok: false, error: "Write two or three sentences." }),
      run: async (a: { assessment: string }) => {
        await prisma.case.update({ where: { id: caseId }, data: { aiAssessment: a.assessment, aiAssessedAt: new Date() } });
        return { ok: true, saved: true };
      },
    },
  ];
  const autopilot = first.c.property.autopilotRoutine && first.c.severity === "ROUTINE";
  return runLoop(PROMPT(first.c.property.name, trigger, autopilot), [{ role: "user", content: `Trigger: ${trigger}. Case ${caseRef(first.c.number)}. Decide the next step.` }], tools, 8);
}

// ───────────────────────── policy ─────────────────────────

/** Why a vendor proposal cannot apply to the case as it stands, or null when it can. */
function vendorBlocker(c: LoadedCase): string | null {
  if (c.emergency || c.status === "ESCALATED") return "The case is an emergency or escalated: a manager handles it first.";
  if (c.needsReview) return "The case needs a person to review it first.";
  if (!["AWAITING_ASSIGNMENT", "REOPENED"].includes(c.status)) return `The case is not waiting for a vendor (it is ${c.status}).`;
  if (liveAssignment(c)) return "A vendor offer is already in progress.";
  return null;
}

async function proposeVendor(caseId: string, runId: string, key: string, rationale: string, refs: Map<string, string>) {
  const vendorId = refs.get(key.toUpperCase()) ?? (await prisma.vendor.findFirst({ where: { name: { equals: key, mode: "insensitive" } }, select: { id: true } }))?.id;
  if (!vendorId) return { ok: false, error: `No vendor matches "${key}". Use a ref from list_vendors.` };
  return withCase(caseId, async (tx, c) => {
    const blocked = vendorBlocker(c);
    if (blocked) return { ok: false, error: blocked };
    const vendor = await tx.vendor.findUnique({ where: { id: vendorId }, include: { _count: { select: { users: true } } } });
    if (!vendor || !vendor.approved) return { ok: false, error: "That vendor is not approved." };
    if (c.category !== "OTHER" && !vendor.trades.includes(c.category)) return { ok: false, error: `${vendor.name} does not cover ${CATEGORY_SHORT[c.category].toLowerCase()} work.` };
    const before = c.assignments.find((a) => a.vendorId === vendorId && ["DECLINED", "EXPIRED", "REJECTED", "WITHDRAWN"].includes(a.status));
    if (before) return { ok: false, error: `${vendor.name} already ${before.status.toLowerCase()} this case. Choose someone else.` };
    await tx.agentProposal.updateMany({ where: { caseId, kind: "ASSIGN_VENDOR", status: "PENDING" }, data: { status: "SUPERSEDED", outcome: "Replaced by a newer proposal." } });

    const auto = c.property.autopilotRoutine && c.severity === "ROUTINE" && vendor._count.users > 0;
    const policyNote = auto
      ? "Autopilot is on for routine cases at this property and the vendor has a Relay login, so the offer was sent automatically."
      : c.property.autopilotRoutine
        ? c.severity !== "ROUTINE"
          ? "Autopilot only covers routine cases; this one is not routine, so a manager decides."
          : "The vendor has no Relay login, so a manager decides how to reach them."
        : "Autopilot is off at this property, so a manager approves every offer.";
    const proposal = await tx.agentProposal.create({ data: { caseId, runId, kind: "ASSIGN_VENDOR", payload: { vendorId, vendorName: vendor.name }, rationale, policyNote, status: "PENDING" } });
    if (auto) {
      await offerVendorTx(tx, c, AGENT, vendorId, `Chosen by Relay AI: ${rationale}`);
      await tx.agentProposal.update({ where: { id: proposal.id }, data: { status: "EXECUTED", outcome: `Offer sent to ${vendor.name}.`, decidedAt: new Date() } });
      return { ok: true, executed: true, message: `Offer sent to ${vendor.name} under the property's autopilot policy.` };
    }
    await addEvent(tx, c.id, AGENT, { type: "AI_PROPOSAL", audience: "MANAGEMENT", message: `Relay AI suggests offering the job to ${vendor.name}: ${rationale}` });
    await notify(tx, await managerIds(tx, c.propertyId), c.id, `proposal:${proposal.id}`, { kind: "ACTION", title: `Relay suggests ${vendor.name} for ${caseRef(c.number)}`, body: rationale });
    return { ok: true, executed: false, message: `Proposal saved. A manager will approve or reject offering the job to ${vendor.name}.` };
  });
}

async function proposeResidentUpdate(caseId: string, runId: string, message: string, rationale: string) {
  return withCase(caseId, async (tx, c) => {
    if (c.status === "RESOLVED" || c.status === "CANCELLED") return { ok: false, error: "The case is closed." };
    await tx.agentProposal.updateMany({ where: { caseId, kind: "MESSAGE_RESIDENT", status: "PENDING" }, data: { status: "SUPERSEDED", outcome: "Replaced by a newer draft." } });
    await tx.agentProposal.create({ data: { caseId, runId, kind: "MESSAGE_RESIDENT", payload: { message }, rationale, policyNote: "Messages to residents are always reviewed by a manager before they are sent.", status: "PENDING" } });
    await addEvent(tx, c.id, AGENT, { type: "AI_PROPOSAL", audience: "MANAGEMENT", message: `Relay AI drafted an update for the resident: "${message}"` });
    return { ok: true, executed: false, message: "Draft saved for a manager to review." };
  });
}

async function escalate(caseId: string, runId: string, why: string) {
  return withCase(caseId, async (tx, c) => {
    if (c.status === "ESCALATED") return { ok: true, executed: false, message: "Already escalated." };
    if (!canPerform("ESCALATE", c.status, "AGENT")) return { ok: false, error: `It cannot be escalated while ${c.status}.` };
    await move(tx, c, "ESCALATE", AGENT, { message: `Relay AI escalated this: ${why}` });
    await tx.agentProposal.create({ data: { caseId, runId, kind: "ESCALATE", payload: { reason: why }, rationale: why, policyNote: "Relay AI may always escalate (the safer direction). Only a manager can resume a case.", status: "EXECUTED", decidedAt: new Date(), outcome: "Escalated." } });
    await notify(tx, await managerIds(tx, c.propertyId), c.id, `ai-escalated:${runId}`, { kind: "EMERGENCY", title: `Relay AI escalated ${caseRef(c.number)}`, body: why });
    return { ok: true, executed: true, message: "Escalated to the property manager." };
  });
}

// ───────────────────────── manager decisions ─────────────────────────

export async function decideProposal(actor: ActorCtx, input: { proposalId: string; accept: boolean; message?: string; note?: string }) {
  if (actor.kind !== "MANAGER") throw new HttpError(403, "Your account cannot do that.");
  const p = await prisma.agentProposal.findUnique({ where: { id: String(input?.proposalId ?? "") } });
  if (!p) throw new HttpError(404, "Proposal not found.");
  const c = await prisma.case.findUniqueOrThrow({ where: { id: p.caseId }, include: CASE_INCLUDE });
  await assertCaseAccess(prisma, actor, c);
  if (p.status !== "PENDING") {
    if ((input.accept && p.status === "EXECUTED") || (!input.accept && p.status === "REJECTED")) return { ok: true, repeated: true };
    throw new HttpError(409, `This suggestion is already ${p.status.toLowerCase()}.`, { code: "proposal_closed" });
  }
  const note = str(input.note, 300);
  if (!input.accept) {
    await withCase(p.caseId, async (tx, cc) => {
      await tx.agentProposal.update({ where: { id: p.id }, data: { status: "REJECTED", decidedById: actor.userId, decidedAt: new Date(), outcome: note || null } });
      await addEvent(tx, cc.id, actor, { type: "AI_PROPOSAL_REJECTED", audience: "MANAGEMENT", message: `${actor.name} rejected Relay AI's suggestion${note ? `: ${note}` : "."}` });
    });
    return { ok: true, repeated: false };
  }
  try {
    await withCase(p.caseId, async (tx, cc) => {
      const payload = p.payload as { vendorId?: string; vendorName?: string; message?: string };
      if (p.kind === "ASSIGN_VENDOR") {
        await offerVendorTx(tx, cc, actor, String(payload.vendorId), note || `Suggested by Relay AI: ${p.rationale}`);
        await tx.agentProposal.update({ where: { id: p.id }, data: { status: "EXECUTED", decidedById: actor.userId, decidedAt: new Date(), outcome: `Offer sent to ${payload.vendorName}.` } });
      } else if (p.kind === "MESSAGE_RESIDENT") {
        const text = str(input.message, 400) || String(payload.message ?? "");
        if (text.length < 10) throw new HttpError(400, "The message is empty.");
        await addEvent(tx, cc.id, { ...AGENT, name: `Relay (sent by ${actor.name})` }, { type: "MESSAGE_TO_RESIDENT", message: text });
        await notify(tx, [cc.residentId], cc.id, `msg:${p.id}`, { kind: "UPDATE", title: `Update on ${cc.title}`, body: text });
        await tx.agentProposal.update({ where: { id: p.id }, data: { status: "EXECUTED", decidedById: actor.userId, decidedAt: new Date(), outcome: text === payload.message ? "Sent as drafted." : "Sent after editing." } });
      } else {
        throw new HttpError(409, "This kind of suggestion has nothing to approve.");
      }
    });
  } catch (e) {
    // The case moved on since the suggestion was made: record that, then report it.
    const message = e instanceof HttpError ? e.message : "The suggestion could not be carried out.";
    await prisma.agentProposal.update({ where: { id: p.id }, data: { status: "FAILED", decidedById: actor.userId, decidedAt: new Date(), outcome: message } });
    throw e;
  }
  return { ok: true, repeated: false };
}

/** A manager asks the coordinator to look again (for example after the model came back online). */
export async function requestReassessment(actor: ActorCtx, input: { caseId: string }) {
  if (actor.kind !== "MANAGER") throw new HttpError(403, "Your account cannot do that.");
  await withCase(input?.caseId, async (tx, c) => {
    await assertCaseAccess(tx, actor, c);
    if (c.status === "RESOLVED" || c.status === "CANCELLED") throw new HttpError(409, "The case is closed.");
    const eventId = await addEvent(tx, c.id, actor, { type: "AI_REASSESS_REQUESTED", audience: "MANAGEMENT", message: `${actor.name} asked Relay AI to review the case again.` });
    await flagForCoordinator(tx, c.id, "MANUAL_REVIEW", eventId);
  });
  await kickCoordinator(input.caseId);
  return { ok: true };
}
