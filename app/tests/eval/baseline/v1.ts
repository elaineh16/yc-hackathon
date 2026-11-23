// BASELINE (Relay V1, commit 0298906), extracted verbatim from git HEAD by the V1.1 evaluation so the "before" numbers
// measure the code as it actually was. Do not edit: it is a fixed reference, not product code.
//   - intake system prompt and submit_report schema: app/src/server/agent/intake.ts
//   - the agent-reading policy (classifyAgent): app/src/server/cases/intake.ts
//   - the coordinator prompt: app/src/server/agent/coordinator.ts
// The V1 shared rules it depends on are in ./shared (copied from HEAD the same way).
import { CATEGORIES, CATEGORY_SHORT, type Category, type IntakeChannel, SEVERITIES, type Severity } from "./shared/domain";
import { QUESTIONS } from "./shared/intake";
import { triage } from "./shared/triage";
import { cleanFacts } from "../../../src/server/agent/loop";

export type AgentReading = { category: Category; severity: Severity; title: string; summary: string; rationale: string; needsReview: boolean; safetyConcerns: string[]; facts: Record<string, unknown> };
type Classification = { category: Category; severity: Severity; emergency: boolean; needsReview: boolean; reasons: string[]; safetyAdvice: string | null; title: string; summary: string; details: Record<string, unknown>; source: string };

export function systemPrompt(o: { name: string; unit: string; property: string; emergency: string; facts: Record<string, unknown>; now: Date }) {
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

export const SUBMIT_SCHEMA = {
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

const clean = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const RANK: Record<Severity, number> = { EMERGENCY: 0, URGENT: 1, ROUTINE: 2 };
const NOTHING = /^(none|no|n\/a|nothing|no concerns?|not applicable)\.?$/i;

/** The agent path: the agent's reading, checked and tightened by deterministic policy. */
export function classifyAgent(description: string, a: AgentReading, channel: IntakeChannel): Classification {
  const category = (CATEGORIES as readonly string[]).includes(a?.category) ? a.category : "OTHER";
  const agentSeverity = (SEVERITIES as readonly string[]).includes(a?.severity) ? a.severity : "URGENT";
  const concerns = (Array.isArray(a?.safetyConcerns) ? a.safetyConcerns : []).map((s) => clean(s, 160)).filter((s) => s && !NOTHING.test(s)).slice(0, 5);
  // The rules read the resident's own words plus anything the agent flagged.
  const rules = triage({ description: [description, ...concerns].join(". "), categoryHint: category === "OTHER" ? null : category });
  const emergency = rules.emergency || agentSeverity === "EMERGENCY" || concerns.length > 0;
  let severity: Severity = RANK[rules.severity] < RANK[agentSeverity] ? rules.severity : agentSeverity;
  if (emergency) severity = "EMERGENCY";
  const reasons = [`Relay's ${channel === "VOICE" ? "voice" : "intake"} assistant: ${clean(a?.rationale, 300) || "no reason given"}`];
  for (const r of rules.reasons) if (!/^(Reported as|Classified as)/.test(r)) reasons.push(`Safety rule: ${r}`);
  for (const c of concerns) reasons.push(`Safety concern noted: ${c}`);
  if (RANK[severity] < RANK[agentSeverity]) reasons.push(`Policy raised the severity from ${agentSeverity.toLowerCase()} to ${severity.toLowerCase()}.`);
  return {
    category,
    severity,
    emergency,
    needsReview: a?.needsReview === true || category === "OTHER",
    reasons,
    safetyAdvice: emergency ? (rules.safetyAdvice ?? "Keep away from the hazard. If anyone is in danger, call 911.") : null,
    title: clean(a?.title, 80) || rules.title,
    summary: clean(a?.summary, 500) || rules.summary,
    details: cleanFacts(a?.facts),
    source: channel === "VOICE" ? "VOICE_AGENT" : "AGENT",
  };
}

export const COORDINATOR_PROMPT_V1 = (property: string, trigger: string, autopilot: boolean) => `You are Relay's maintenance coordinator for ${property}. Something just happened on a case (${trigger.toLowerCase().replace(/_/g, " ")}). Work out the best next step and act through your tools.

Steps:
1. Call get_case to read it.
2. Decide what the case needs now. Typical needs: a vendor (when it is waiting for one), a short factual update to the resident (when something changed that affects them), escalation (when it may be dangerous), or nothing.
3. If it needs a vendor: call list_vendors and choose the best fit from what the tools return (trade, current workload, completed jobs, anyone who already declined or did not respond on this case). Use search_past_cases to see who handled similar problems here. Then call propose_vendor with a one-sentence rationale. ${autopilot ? "For routine cases the property allows Relay to send the offer automatically." : "A manager will approve your proposal before anything is sent."}
4. Always finish by calling record_assessment with two or three plain sentences: what is going on, what you did, and what happens next.

Rules:
- Use only facts from the tools. Never invent prices, availability, appointment times or causes.
- When the case is waiting for a vendor (status AWAITING_ASSIGNMENT or REOPENED) and is not an emergency, the expected next step is to propose a vendor.
- Escalate only for a danger to people or the building right now that the triage missed: gas, smoke, sparks or burning, flooding or water near electrics, no heat for someone at risk. A contained leak, a leak with the water turned off, or an ordinary breakdown is not a reason to escalate.
- Never propose a vendor for an emergency or escalated case, or one that needs human review: record an assessment for the manager instead.
- You cannot approve spending, schedule visits, close or cancel cases. Do not pretend to.
- Messages to residents must be short, factual and free of promises.`;
