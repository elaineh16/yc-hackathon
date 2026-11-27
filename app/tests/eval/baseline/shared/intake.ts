// What Relay asks for each kind of problem. One definition drives the text form, the voice agent's questions and
// the server-side validation, so the three can never drift apart.
import type { Category } from "./domain";

export type Answer = string | number | boolean | null;
export type Details = Record<string, Answer>;

export type Question = {
  key: string;
  /** Shown on the form. */
  label: string;
  /** How the voice agent should ask it. */
  ask: string;
  kind: "choice" | "yesno" | "text" | "number";
  options?: readonly { value: string; label: string }[];
  /** The report cannot be saved without an answer ("Not sure" counts as an answer for yes/no questions). */
  required: boolean;
  /** A "yes" means the situation may be dangerous: Relay escalates instead of dispatching routinely. */
  safety?: boolean;
  hint?: string;
};

const opt = (pairs: readonly (readonly [string, string])[]) => pairs.map(([value, label]) => ({ value, label }));

export const QUESTIONS: Record<Category, readonly Question[]> = {
  PLUMBING: [
    {
      key: "fixture",
      label: "Where is the problem?",
      ask: "Which fixture or area is it: kitchen sink, bathroom sink, toilet, shower or tub, water heater, or a pipe in a wall or ceiling?",
      kind: "choice",
      required: true,
      options: opt([
        ["kitchen_sink", "Kitchen sink"],
        ["bathroom_sink", "Bathroom sink"],
        ["toilet", "Toilet"],
        ["shower_tub", "Shower or tub"],
        ["water_heater", "Water heater"],
        ["pipe_wall_ceiling", "Pipe, wall or ceiling"],
        ["other", "Somewhere else"],
      ]),
    },
    { key: "activeLeak", label: "Is water leaking right now?", ask: "Is water leaking right now?", kind: "yesno", required: true },
    {
      key: "spreading",
      label: "Is water spreading across the floor or into another unit?",
      ask: "Is the water spreading across the floor or getting into another unit?",
      kind: "yesno",
      required: true,
      safety: true,
    },
    {
      key: "waterNearElectrical",
      label: "Is water reaching outlets, light fittings or the electrical panel?",
      ask: "Is any water reaching outlets, light fittings or the electrical panel?",
      kind: "yesno",
      required: true,
      safety: true,
    },
    { key: "canShutOff", label: "Have you been able to turn the water off at the fixture?", ask: "Have you been able to turn the water off at the fixture?", kind: "yesno", required: false },
  ],
  APPLIANCE: [
    {
      key: "appliance",
      label: "Which appliance?",
      ask: "Which appliance is it: washer, dryer, refrigerator, stove or oven, dishwasher, or microwave?",
      kind: "choice",
      required: true,
      options: opt([
        ["washer", "Washer"],
        ["dryer", "Dryer"],
        ["refrigerator", "Refrigerator"],
        ["stove_oven", "Stove or oven"],
        ["dishwasher", "Dishwasher"],
        ["microwave", "Microwave"],
        ["other", "Another appliance"],
      ]),
    },
    {
      key: "problem",
      label: "What is it doing?",
      ask: "What is it doing: not starting, not draining, leaking, not heating or cooling, or making noise?",
      kind: "choice",
      required: true,
      options: opt([
        ["wont_start", "Won't start"],
        ["wont_drain", "Won't drain"],
        ["leaking", "Leaking"],
        ["not_heating_cooling", "Not heating or cooling"],
        ["noisy", "Making noise"],
        ["other", "Something else"],
      ]),
    },
    { key: "errorCode", label: "Error code on the display, if any", ask: "Is there an error code on the display?", kind: "text", required: false, hint: "For example OE or F21" },
    {
      key: "burningOrSparks",
      label: "Is there a burning smell, smoke or sparking?",
      ask: "Is there any burning smell, smoke or sparking?",
      kind: "yesno",
      required: true,
      safety: true,
    },
    { key: "gasSmell", label: "Do you smell gas?", ask: "Do you smell gas?", kind: "yesno", required: true, safety: true },
  ],
  HVAC: [
    {
      key: "system",
      label: "Which system?",
      ask: "Is this about heating, cooling or ventilation?",
      kind: "choice",
      required: true,
      options: opt([
        ["heating", "Heating"],
        ["cooling", "Cooling"],
        ["ventilation", "Ventilation"],
      ]),
    },
    { key: "completelyOut", label: "Is it not working at all?", ask: "Is it not working at all, or only partly?", kind: "yesno", required: true },
    { key: "indoorTempC", label: "Temperature inside, if you know it (°C)", ask: "Do you know the temperature inside right now?", kind: "number", required: false },
    { key: "thermostatMessage", label: "Anything shown on the thermostat", ask: "Is the thermostat showing a message or error?", kind: "text", required: false },
    {
      key: "burningOrGasSmell",
      label: "Is there a burning or gas smell?",
      ask: "Is there any burning or gas smell?",
      kind: "yesno",
      required: true,
      safety: true,
    },
    {
      key: "vulnerableOccupant",
      label: "Is anyone at home at particular risk from the temperature?",
      ask: "Is anyone at home at particular risk from the temperature, such as an infant, an older adult or someone unwell?",
      kind: "yesno",
      required: true,
    },
  ],
  // Anything else is saved in the resident's own words and goes to a person.
  OTHER: [],
};

const YES = /^(true|yes|y)$/i;
const NO = /^(false|no|n)$/i;
const UNSURE = /^(unsure|not sure|unknown|don'?t know|n\/a)?$/i;

export type DetailsResult = { ok: true; details: Details } | { ok: false; missing: string[]; invalid: string[] };

/** Keeps only the answers this category asks for, in canonical types. Unknown keys are dropped. */
export function validateDetails(category: Category, raw: unknown): DetailsResult {
  const input = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const details: Details = {};
  const missing: string[] = [];
  const invalid: string[] = [];
  for (const q of QUESTIONS[category]) {
    const v = input[q.key];
    const absent = v === undefined || (typeof v === "string" && v.trim() === "" && q.kind !== "yesno");
    if (q.kind === "yesno") {
      if (v === undefined) {
        if (q.required) missing.push(q.key);
        continue;
      }
      if (v === null || (typeof v === "string" && UNSURE.test(v.trim()))) details[q.key] = null;
      else if (v === true || (typeof v === "string" && YES.test(v.trim()))) details[q.key] = true;
      else if (v === false || (typeof v === "string" && NO.test(v.trim()))) details[q.key] = false;
      else invalid.push(q.key);
      continue;
    }
    if (absent || v === null) {
      if (q.required) missing.push(q.key);
      continue;
    }
    if (q.kind === "choice") {
      const s = String(v).trim().toLowerCase().replace(/[\s-]+/g, "_");
      const hit = q.options!.find((o) => o.value === s || o.label.toLowerCase() === String(v).trim().toLowerCase());
      if (hit) details[q.key] = hit.value;
      else invalid.push(q.key);
    } else if (q.kind === "number") {
      const n = typeof v === "number" ? v : Number(String(v).replace(/[^\d.-]/g, ""));
      if (Number.isFinite(n) && n > -60 && n < 60) details[q.key] = Math.round(n * 10) / 10;
      else invalid.push(q.key);
    } else {
      const s = String(v).replace(/\s+/g, " ").trim().slice(0, 200);
      // Speech-to-text and language models say "none" when there is nothing to report.
      if (s && !/^(none|no|n\/a|nothing|no code|not applicable)\.?$/i.test(s)) details[q.key] = s;
      else if (q.required) missing.push(q.key);
    }
  }
  return missing.length || invalid.length ? { ok: false, missing, invalid } : { ok: true, details };
}

export const optionLabel = (category: Category, key: string, value: Answer): string => {
  const q = QUESTIONS[category].find((x) => x.key === key);
  if (!q) return String(value ?? "");
  if (q.kind === "yesno") return value === true ? "Yes" : value === false ? "No" : "Not sure";
  if (q.kind === "choice") return q.options?.find((o) => o.value === value)?.label ?? String(value ?? "");
  return String(value ?? "");
};
