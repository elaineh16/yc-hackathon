// The agent path's policy, kept pure (no database, no Wasp) so the evaluation harness scores exactly what production
// does: the agent's reading of a report, checked and tightened by the deterministic safety rules. The rules read the
// resident's own words (never the agent's assumptions); they can only raise the severity; any safety concern escalates;
// lockouts and elevators that stopped always go to a person.
import { type Category, CATEGORIES, type IntakeChannel, type Severity, SEVERITIES } from "../../shared/domain";
import { triage } from "../../shared/triage";
import { cleanFacts } from "../agent/loop";

export type AgentReading = {
  category: Category;
  severity: Severity;
  title: string;
  summary: string;
  rationale: string;
  needsReview: boolean;
  safetyConcerns: string[];
  facts: Record<string, unknown>;
  /** What the resident said they saw or experienced, in short phrases. */
  observations?: string[];
  /** What the agent inferred but nobody confirmed. Kept apart from observations and never read by the safety rules. */
  assumptions?: string[];
  /** What is still unknown and matters. */
  openQuestions?: string[];
};

export const clean = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const RANK: Record<Severity, number> = { EMERGENCY: 0, URGENT: 1, ROUTINE: 2 };
export const NOTHING = /^(none|no|n\/a|nothing|no concerns?|not applicable)\.?$/i;

export type Classification = {
  category: Category;
  severity: Severity;
  emergency: boolean;
  needsReview: boolean;
  reasons: string[];
  safetyAdvice: string | null;
  title: string;
  summary: string;
  details: Record<string, unknown>;
  source: string;
  observations: string[];
  assumptions: string[];
  openQuestions: string[];
};
const phrases = (v: unknown, n = 6) => (Array.isArray(v) ? v.map((x) => clean(x, 200)).filter((x) => x && !NOTHING.test(x)).slice(0, n) : []);

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
  // Category policy applies whoever classified it: lockouts and elevators that stopped go to a person.
  const policyReview = rules.needsReview && (category === "ACCESS" || category === "ELEVATOR");
  if (policyReview) for (const r of rules.reasons) if (/^(Lockouts|An elevator)/.test(r)) reasons.push(`Policy: ${r}`);
  return {
    category,
    severity,
    emergency,
    needsReview: a?.needsReview === true || category === "OTHER" || policyReview,
    reasons,
    safetyAdvice: emergency ? (rules.safetyAdvice ?? "Keep away from the hazard. If anyone is in danger, call 911.") : null,
    title: clean(a?.title, 80) || rules.title,
    summary: clean(a?.summary, 500) || rules.summary,
    details: cleanFacts(a?.facts),
    source: channel === "VOICE" ? "VOICE_AGENT" : "AGENT",
    observations: phrases(a?.observations),
    assumptions: phrases(a?.assumptions),
    openQuestions: phrases(a?.openQuestions, 4),
  };
}
