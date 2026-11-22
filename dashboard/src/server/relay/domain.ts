// Pure Relay rules: no Wasp or Prisma imports, so they are unit-tested directly (src/server/relay/domain.test.ts).
// "Code decides, the model talks": every number and state change here is decided by code, never by the agent.
import { createHash } from "node:crypto";

// ---------- money and policy ----------
const cents = (v: string | undefined, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : fallback;
};
export function policy(env: Record<string, string | undefined> = process.env) {
  const hardCapCents = cents(env.HARD_CAP, 100_000);
  return {
    autoApproveLimitCents: Math.min(cents(env.AUTO_APPROVE_LIMIT, 25_000), hardCapCents),
    hardCapCents,
    defaultCapCents: 40_000, // DEMO.md: manager approves up to $400 CAD including taxes and fees
  };
}
export const fmtMoney = (c: number) => `$${(c / 100).toFixed(c % 100 ? 2 : 0)} CAD`;
export const needsApproval = (estimateCents: number, autoApproveLimitCents: number) =>
  estimateCents > autoApproveLimitCents;

/** The all-in cap must cover the pre-tax estimate and stay under the hard cap. */
export function validateCap(capCents: unknown, estimateCents: number, hardCapCents: number): string | null {
  if (typeof capCents !== "number" || !Number.isInteger(capCents)) return "Cap must be a whole number of cents.";
  if (capCents < estimateCents) return `Cap ${fmtMoney(capCents)} is below the ${fmtMoney(estimateCents)} estimate.`;
  if (capCents > hardCapCents) return `Cap ${fmtMoney(capCents)} is above the ${fmtMoney(hardCapCents)} hard cap.`;
  return null;
}

// ---------- intake ----------
export type FloorStatus = "DRY" | "WET" | "UNKNOWN";
export interface IntakeInput {
  sessionId: string;
  residence: string;
  room: string;
  machine: string;
  symptom: string;
  floorStatus: FloorStatus;
  reportedErrorCode: string | null;
  safetyHazard: boolean;
  hazardDetails: string | null;
  conversationId: string | null;
  source?: "voice" | "test"; // "test" = the labelled no-voice fallback button
}
/** DEMO.md's report, used by the no-voice fallback (submitTestReport). */
export const DEMO_REPORT = {
  residence: "MKV",
  room: "main laundry room",
  washer: "2",
  symptom: "Washer won't drain; clothes stuck inside",
  floor_status: "dry",
  error_code: "OE",
  safety_hazard: false,
};
export type Parsed<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const str = (v: unknown, max: number): string | null => {
  if (typeof v === "number") v = String(v);
  if (typeof v !== "string") return null;
  const s = v.replace(/\s+/g, " ").trim();
  return s && s.length <= max ? s : null;
};
const titleCase = (s: string) => s.replace(/\b\p{L}/gu, (c) => c.toUpperCase());

/** "2", 2, "washer 2", "Washer #2", "washer two" -> "Washer 2". Other machines keep their words. */
export function normalizeMachine(v: unknown): string | null {
  const s = str(v, 60);
  if (!s) return null;
  const words: Record<string, string> = { one: "1", two: "2", three: "3", four: "4", five: "5", six: "6" };
  const m = s.toLowerCase().match(/^(?:(washer|dryer|machine)\s*)?(?:#|no\.?|number)?\s*(\d+|one|two|three|four|five|six)$/);
  if (m) return `${titleCase(m[1] ?? "washer")} ${words[m[2]] ?? m[2]}`;
  return titleCase(s);
}

export function normalizeFloor(v: unknown): FloorStatus | null {
  if (typeof v === "boolean") return v ? "WET" : "DRY"; // "water_on_floor": true
  const s = str(v, 40)?.toLowerCase();
  if (!s) return null;
  if (/^(dry|no( water)?|none|inside( the)? drum|contained)$/.test(s)) return "DRY";
  if (/^(wet|leak(ing)?|water on (the )?floor|flood(ed|ing)?|yes)$/.test(s)) return "WET";
  if (/^(unknown|unsure|not sure)$/.test(s)) return "UNKNOWN";
  return null;
}

const bool = (v: unknown) => v === true || (typeof v === "string" && /^(true|yes)$/i.test(v.trim()));

/** Validates the ElevenLabs tool body. Field names are the public contract (dashboard/README.md). */
export function parseIntake(body: unknown): Parsed<IntakeInput> {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const errors: string[] = [];
  const need = <T>(name: string, v: T | null): T => {
    if (v === null) errors.push(name);
    return v as T;
  };
  const sessionId = need("demo_session_id", str(b.demo_session_id, 64));
  const residence = need("residence", str(b.residence, 80));
  const room = need("room", str(b.room, 80));
  const machine = need("washer", normalizeMachine(b.washer ?? b.machine));
  const symptom = need("symptom", str(b.symptom, 500));
  const floorStatus = need("floor_status", normalizeFloor(b.floor_status ?? b.water_on_floor));
  const rawCode = b.error_code;
  let reportedErrorCode: string | null = null;
  if (rawCode !== undefined && rawCode !== null && rawCode !== "") {
    const c = str(rawCode, 16);
    if (!c) errors.push("error_code");
    else if (!/^(none|no|n\/a|no code|blank)$/i.test(c)) reportedErrorCode = c.toUpperCase().replace(/\s+/g, "");
  }
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      sessionId,
      residence: residence.toUpperCase().length <= 5 ? residence.toUpperCase() : titleCase(residence),
      room: titleCase(room),
      machine,
      symptom,
      floorStatus,
      reportedErrorCode,
      safetyHazard: bool(b.safety_hazard),
      hazardDetails: str(b.hazard_details, 300),
      conversationId: str(b.conversation_id, 120),
    },
  };
}

/** Water on the floor or any reported hazard stops the normal flow (PRD: direct to residence staff). */
export const isHazard = (v: Pick<IntakeInput, "safetyHazard" | "floorStatus">) => v.safetyHazard || v.floorStatus === "WET";

export const openKeyFor = (v: Pick<IntakeInput, "residence" | "room" | "machine">) =>
  [v.residence, v.room, v.machine].map((s) => s.toLowerCase()).join("|");

/** Same report twice (an agent retry) is a no-op; a changed report updates the order. */
export const fingerprint = (v: IntakeInput) =>
  createHash("sha256")
    .update(JSON.stringify([v.residence, v.room, v.machine, v.symptom, v.floorStatus, v.reportedErrorCode, v.safetyHazard, v.hazardDetails]))
    .digest("hex")
    .slice(0, 32);

export const locationLabel = (w: { residence: string; room: string; machine: string }) =>
  `${w.residence} · ${w.room} · ${w.machine}`;
export const deskFor = (residence: string) => `${residence} front desk`;

// ---------- seeded, simulated contractor outreach ----------
export type Outcome = "QUOTED" | "DIAGNOSTIC_ONLY" | "VOICEMAIL";
export type Scope = "REPAIR" | "DIAGNOSTIC" | "UNKNOWN";
export interface SeededResult {
  contractorKey: string;
  name: string;
  outcome: Outcome;
  scope: Scope;
  availability: string | null;
  availabilityRank: number | null; // lower = sooner; null = unknown
  priceCents: number | null;
  priceNote: string | null;
  summary: string;
  revealStep: number; // appears after revealStep * SIM_STEP_MS
}
export const SEEDED_RESULTS: SeededResult[] = [
  {
    contractorKey: "quickfix",
    name: "QuickFix",
    outcome: "DIAGNOSTIC_ONLY",
    scope: "DIAGNOSTIC",
    availability: "Today",
    availabilityRank: 0,
    priceCents: 9_900,
    priceNote: "diagnostic visit only; repair extra",
    summary: "Available today. $99 CAD for a diagnostic visit, with repair extra.",
    revealStep: 1,
  },
  {
    contractorKey: "bluejay",
    name: "Bluejay",
    outcome: "QUOTED",
    scope: "REPAIR",
    availability: "Tomorrow",
    availabilityRank: 1,
    priceCents: 32_900,
    priceNote: "pre-tax drain-pump repair estimate, conditional on diagnosis",
    summary: "Available tomorrow. $329 CAD pre-tax drain-pump repair estimate, conditional on diagnosis.",
    revealStep: 2,
  },
  {
    contractorKey: "metro",
    name: "Metro",
    outcome: "VOICEMAIL",
    scope: "UNKNOWN",
    availability: null,
    availabilityRank: null,
    priceCents: null,
    priceNote: null,
    summary: "Voicemail. Availability and price are unknown.",
    revealStep: 3,
  },
];
export const RECOMMEND_STEP = 4;
export const simStepMs = (env: Record<string, string | undefined> = process.env) => {
  const n = Number(env.SIM_STEP_MS);
  return Number.isFinite(n) && n >= 0 ? n : 3000;
};

export interface ResultLike {
  contractorKey: string;
  name: string;
  scope: string;
  availability: string | null;
  priceCents: number | null;
}
/**
 * Only complete repair offers with a known price are comparable. A diagnostic-only visit is not a repair quote,
 * and a voicemail is unknown. Among comparable offers, prefer the sooner slot, then the lower price.
 */
export function recommend(results: ResultLike[]): { contractorKey: string; name: string; priceCents: number; text: string } | null {
  const rank = (r: ResultLike) => SEEDED_RESULTS.find((s) => s.contractorKey === r.contractorKey)?.availabilityRank ?? 99;
  const comparable = results
    .filter((r) => r.scope === "REPAIR" && r.priceCents !== null)
    .sort((a, b) => rank(a) - rank(b) || a.priceCents! - b.priceCents!);
  const pick = comparable[0];
  if (!pick) return null;
  const others = results.filter((r) => r !== pick).map((r) =>
    r.scope === "DIAGNOSTIC"
      ? `${r.name} can come ${r.availability?.toLowerCase() ?? "soon"}, but only for a ${fmtMoney(r.priceCents ?? 0)} diagnostic with the repair extra, so it is not a comparable repair price.`
      : r.scope === "UNKNOWN"
        ? `${r.name} went to voicemail, so its price and availability are unknown.`
        : `${r.name} quoted ${r.priceCents === null ? "no price" : fmtMoney(r.priceCents)}.`,
  );
  const text =
    `Relay recommends ${pick.name}: the only complete repair offer with a known price ` +
    `(${fmtMoney(pick.priceCents!)} before tax, conditional on diagnosis) and a ${pick.availability?.toLowerCase()} slot. ` +
    others.join(" ");
  return { contractorKey: pick.contractorKey, name: pick.name, priceCents: pick.priceCents!, text };
}

/** Seeded Bluejay confirmation: tomorrow 9:00–11:00 AM, Toronto time. */
export function arrivalWindow(now = new Date()) {
  const day = new Date(now);
  day.setUTCDate(day.getUTCDate() + 1);
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit" }).format(day);
  const offset = torontoOffset(day); // e.g. "-05:00"
  const start = new Date(`${ymd}T09:00:00${offset}`);
  const end = new Date(`${ymd}T11:00:00${offset}`);
  const label = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", weekday: "long", month: "short", day: "numeric" }).format(start);
  return { start, end, label: `Tomorrow (${label}), 9:00–11:00 AM` };
}
function torontoOffset(d: Date): string {
  const part = new Intl.DateTimeFormat("en-US", { timeZone: "America/Toronto", timeZoneName: "longOffset" })
    .formatToParts(d)
    .find((p) => p.type === "timeZoneName")?.value; // "GMT-05:00"
  return part && part !== "GMT" ? part.replace("GMT", "") : "+00:00";
}

// ---------- state machines ----------
export const STAFF = { REQUESTED: "REQUESTED", ACCEPTED: "ACCEPTED", RETRIEVED: "RETRIEVED", UNAVAILABLE: "UNAVAILABLE" } as const;
export const REPAIR = {
  OPTIONS_PENDING: "OPTIONS_PENDING",
  RECOMMENDED: "RECOMMENDED",
  PENDING_APPROVAL: "PENDING_APPROVAL",
  CONFIRMATION_PENDING: "CONFIRMATION_PENDING",
  CONFIRMED: "CONFIRMED",
  DENIED: "DENIED",
  ESCALATED: "ESCALATED",
} as const;

/** What the student's page says. Plain language; simulated steps say so. */
export function staffLabel(s: { status: string; etaMinutes: number | null; assignedTo: string; priority: string } | null) {
  if (!s) return "Waiting for residence staff";
  switch (s.status) {
    case STAFF.ACCEPTED:
      return `Staff on the way · ${s.etaMinutes ?? 15} minutes`;
    case STAFF.RETRIEVED:
      return "Clothes retrieved";
    case STAFF.UNAVAILABLE:
      return "Staff can't help right now. The manager is arranging retrieval.";
    default:
      return s.priority === "SAFETY" ? "Residence staff alerted (safety)" : "Residence staff have been asked to help";
  }
}
export function repairLabel(status: string, appointment: { contractorName: string; arrivalWindow: string } | null, recName?: string | null) {
  switch (status) {
    case REPAIR.OPTIONS_PENDING:
      return "Getting repair options (simulated)";
    case REPAIR.RECOMMENDED:
    case REPAIR.PENDING_APPROVAL:
      return `Relay recommends ${recName ?? "a contractor"}. Waiting for manager approval.`;
    case REPAIR.CONFIRMATION_PENDING:
      return `Approved. Waiting for ${recName ?? "the contractor"} to confirm (simulated).`;
    case REPAIR.CONFIRMED:
      return appointment ? `${appointment.contractorName} arriving ${appointment.arrivalWindow} (simulated)` : "Repair confirmed";
    case REPAIR.DENIED:
      return "Repair not approved yet. The manager will follow up.";
    case REPAIR.ESCALATED:
      return "Safety issue reported. Residence staff are handling it; stay away from the machine.";
    default:
      return status;
  }
}

/** What the agent is told after the tool runs. It must not say "saved" unless ok is true. */
export function agentMessage(hazard: boolean, created: boolean) {
  if (hazard)
    return "The report is saved and residence staff have been alerted to a safety issue. Tell the student to stay away from the machine, not to open it, and to contact the residence front desk in person if they feel unsafe. Tell them to check this page for updates. Do not discuss repairs.";
  return (
    (created ? "The report is saved." : "The report is updated on the existing work order.") +
    " Tell the student to leave the washer door closed, that you have asked residence staff to help, and to check this page for their update. Then end the call."
  );
}
