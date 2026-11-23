// Deterministic triage. No model is involved: every classification can be explained by the rule that produced it,
// and anything the rules cannot place confidently goes to a person. Conservative by design: a possible hazard is
// escalated to a manager, never dispatched as routine work.
import { CATEGORY_SHORT, type Category, type Severity } from "./domain";
import { type Details, optionLabel, QUESTIONS } from "./intake";

export type TriageInput = {
  description: string;
  /** The category the resident (or the voice agent) chose, if any. */
  categoryHint?: Category | null;
  details?: Details;
  title?: string | null;
};
export type TriageResult = {
  category: Category;
  severity: Severity;
  emergency: boolean;
  /** A person must look at it: unsupported category, uncertain classification, or an unanswered safety question. */
  needsReview: boolean;
  /** Plain-language reasons, shown to the manager. */
  reasons: string[];
  /** What the resident is told to do right now, when there may be danger. */
  safetyAdvice: string | null;
  title: string;
  summary: string;
};

const HAZARDS: { pattern: RegExp; reason: string; advice: string }[] = [
  {
    pattern: /\b(smell(s|ing)?( of| like)? gas|gas (smell|leak|odou?r)|rotten eggs?)\b/i,
    reason: "The report mentions a gas smell.",
    advice: "Leave the unit now. Do not use switches or flames. Call your gas utility's emergency line or 911 from outside.",
  },
  {
    pattern: /\b(fire|flames?|smoke|smoking|smoulder\w*|smolder\w*|sparks?|sparking|burning smell|smells? (like )?burning)\b/i,
    reason: "The report mentions fire, smoke, sparks or a burning smell.",
    advice: "If there is fire or smoke, get everyone out and call 911. Do not use the appliance or the outlet.",
  },
  {
    pattern: /\b(carbon monoxide|co (alarm|detector))\b/i,
    reason: "The report mentions carbon monoxide.",
    advice: "Get everyone into fresh air now and call 911.",
  },
  {
    pattern: /\b(electric(al)? shock|got shocked|shocked me|electrocut\w*)\b/i,
    reason: "The report mentions an electric shock.",
    advice: "Stay away from the fixture and anything wet near it. Call 911 if anyone is hurt.",
  },
  {
    pattern: /\b(flood(s|ed|ing)?|burst pipe|pipe (has |just )?burst|water (is )?(pouring|gushing)|sewage|ceiling (is )?(collapsing|caving|sagging))\b/i,
    reason: "The report describes major water or structural damage.",
    advice: "If it is safe, turn the water off at the shut-off valve and keep away from water near outlets.",
  },
];
// "no smoke", "not flooding", "isn't sparking": a negated mention is not a hazard report.
const NEGATED = /\b(no|not|isn'?t|aren'?t|wasn'?t|without|never|don'?t|doesn'?t|didn'?t)\b[\w\s']{0,24}$/i;

const KEYWORDS: Record<Exclude<Category, "OTHER">, RegExp> = {
  PLUMBING: /\b(sink|faucet|tap|toilet|drain(s|ing|ed)?|clog(s|ged)?|pipe|pipes|leak(s|ing|ed|y)?|drip(s|ping)?|shower|bath ?tub|tub|water heater|hot water|water pressure|plumb\w*|sewer|garbage disposal)\b/gi,
  APPLIANCE: /\b(washer|washing machine|dryer|fridge|refrigerator|freezer|stove|oven|range|cooktop|dishwasher|microwave|laundry|appliance)\b/gi,
  HVAC: /\b(heat(ing|er)?|furnace|radiator|thermostat|boiler|a\/?c|air[- ]?con(ditioning|ditioner)?|cooling|hvac|vent(s|ilation)?|baseboard)\b/gi,
};

const sentence = (s: string) => {
  const first = s.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s/)[0] ?? "";
  const cut = first.length > 80 ? `${first.slice(0, 77).trimEnd()}…` : first;
  return cut.replace(/[.!?]+$/, "");
};

function ruleCategory(description: string): { category: Category; hits: number; runnerUp: number } {
  // "water heater" is plumbing even though it contains "heater".
  const text = description.replace(/water heater/gi, "water-heater-unit");
  const score = (re: RegExp) => new Set((text.match(re) ?? []).map((m) => m.toLowerCase())).size;
  const scores: [Category, number][] = [
    ["PLUMBING", score(KEYWORDS.PLUMBING) + (/water-heater-unit/.test(text) ? 2 : 0)],
    ["APPLIANCE", score(KEYWORDS.APPLIANCE)],
    ["HVAC", score(KEYWORDS.HVAC)],
  ];
  scores.sort((a, b) => b[1] - a[1]);
  return scores[0][1] === 0 ? { category: "OTHER", hits: 0, runnerUp: 0 } : { category: scores[0][0], hits: scores[0][1], runnerUp: scores[1][1] };
}

export function triage(input: TriageInput): TriageResult {
  const description = input.description.replace(/\s+/g, " ").trim();
  const details = input.details ?? {};
  const reasons: string[] = [];
  let needsReview = false;

  // 1. Category: the resident's choice wins; the rules fill in when there is none and flag disagreements.
  const ruled = ruleCategory(description);
  let category: Category;
  if (input.categoryHint && input.categoryHint !== "OTHER") {
    category = input.categoryHint;
    reasons.push(`Reported as ${CATEGORY_SHORT[category].toLowerCase()}.`);
    if (ruled.category !== "OTHER" && ruled.category !== category && ruled.hits >= 2) {
      needsReview = true;
      reasons.push(`The description reads more like ${CATEGORY_SHORT[ruled.category].toLowerCase()}: please check the category.`);
    }
  } else if (ruled.category !== "OTHER" && ruled.hits > ruled.runnerUp) {
    category = ruled.category;
    reasons.push(`Classified as ${CATEGORY_SHORT[category].toLowerCase()} from the wording of the report.`);
  } else {
    category = "OTHER";
    needsReview = true;
    reasons.push(ruled.hits === 0 ? "Relay has no playbook for this kind of problem, so a person needs to route it." : "The description fits more than one category, so a person needs to classify it.");
  }

  // 2. Hazards: from the resident's words and from the safety questions.
  let emergency = false;
  let safetyAdvice: string | null = null;
  for (const h of HAZARDS) {
    const m = h.pattern.exec(description);
    if (m && !NEGATED.test(description.slice(0, m.index))) {
      emergency = true;
      reasons.push(h.reason);
      safetyAdvice ??= h.advice;
    }
  }
  for (const q of QUESTIONS[category]) {
    if (!q.safety) continue;
    if (details[q.key] === true) {
      emergency = true;
      reasons.push(`Answered yes to "${q.label}"`);
      safetyAdvice ??=
        q.key === "gasSmell" || q.key === "burningOrGasSmell"
          ? "If you smell gas, leave the unit and call your gas utility's emergency line or 911 from outside. If something is burning, get out and call 911."
          : q.key === "burningOrSparks"
            ? "Stop using the appliance and unplug it only if that is safe. If there is fire or smoke, get out and call 911."
            : "Keep away from the water, especially near outlets. If it is safe, turn the water off at the shut-off valve.";
    } else if (details[q.key] === null) {
      needsReview = true;
      reasons.push(`Not sure about "${q.label}"`);
    }
  }
  if (category === "HVAC" && details.completelyOut === true && details.vulnerableOccupant === true) {
    emergency = true;
    reasons.push("No heating or cooling at all, with someone at particular risk at home.");
    safetyAdvice ??= "If anyone is unwell from the heat or cold, call 911. Otherwise keep them as comfortable as you can; the property manager has been alerted.";
  }

  // 3. Severity.
  let severity: Severity = "ROUTINE";
  if (emergency) severity = "EMERGENCY";
  else if (
    details.activeLeak === true ||
    details.completelyOut === true ||
    (category === "APPLIANCE" && details.appliance === "refrigerator" && details.problem === "not_heating_cooling") ||
    (category === "PLUMBING" && details.fixture === "toilet") ||
    needsReview
  ) {
    severity = "URGENT";
    if (details.activeLeak === true) reasons.push("Water is leaking now.");
    if (details.completelyOut === true) reasons.push("The system is not working at all.");
  }

  // 4. Title and summary, built only from what was actually reported.
  const label = (key: string) => optionLabel(category, key, details[key] ?? null).toLowerCase();
  let title = input.title?.replace(/\s+/g, " ").trim().slice(0, 80) || "";
  if (!title) {
    if (category === "PLUMBING" && details.fixture) title = `${details.activeLeak === true ? "Leak" : "Problem"} at the ${label("fixture")}`;
    else if (category === "APPLIANCE" && details.appliance) title = `${optionLabel(category, "appliance", details.appliance)}: ${label("problem") || "not working"}`;
    else if (category === "HVAC" && details.system) title = `${optionLabel(category, "system", details.system)} ${details.completelyOut === true ? "not working" : "problem"}`;
    else title = sentence(description) || "Maintenance request";
  }
  const facts = QUESTIONS[category]
    .filter((q) => details[q.key] !== undefined)
    .map((q) => `${q.label.replace(/\?$/, "")}: ${optionLabel(category, q.key, details[q.key])}`);
  const summary = [`${CATEGORY_SHORT[category]} report`, ...facts].join(". ") + ".";

  return { category, severity, emergency, needsReview, reasons, safetyAdvice, title, summary };
}

/** A fixed estimate at or under the property's threshold is approved by policy. Anything else needs a manager. */
export function approvalRequired(estimateType: "FIXED" | "INSPECTION_REQUIRED", estimateCents: number | null, thresholdCents: number): boolean {
  if (estimateType !== "FIXED" || estimateCents === null) return true;
  return estimateCents > thresholdCents;
}

/** Two half-open time ranges [start, end) overlap. */
export const overlaps = (aStart: Date, aEnd: Date, bStart: Date, bEnd: Date) => aStart < bEnd && bStart < aEnd;
