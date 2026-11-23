// Grounding checks for text an AI agent writes for people: a resident update drafted by the coordinator, or a note on
// a discovered business. Deterministic and pure (shared with the evaluation harness). The check is deliberately
// strict: an amount, a time, a number or a company name in the draft must appear in the facts the agent was given,
// promises are not allowed, and claims about licences, insurance, availability or price need a source.
// A draft that fails is not saved; the agent gets the reason back and can rewrite it.

const MONEY = /\$\s?\d[\d,]*(?:\.\d{1,2})?/g;
const CLOCK = /\b\d{1,2}(?::\d{2})?\s?(?:a\.?m\.?|p\.?m\.?)(?=\W|$)/gi;
const WEEKDAY = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)\b/gi;
const MONTH_DAY = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+\d{1,2}\b/gi;
const RELATIVE = /\b(today|tonight|tomorrow|this (?:morning|afternoon|evening|week|weekend)|next (?:week|monday|tuesday|wednesday|thursday|friday)|within (?:the hour|\d+ (?:minutes|hours|days))|in (?:an|\d+) hours?|right away|asap|shortly)\b/gi;
const PROMISE = /\b(guarantee\w*|promise\w*|will (?:definitely|certainly|surely)|for sure|no charge|free of charge|won'?t cost|at no cost|100%)\b/gi;
const NUMBER = /\b\d{2,}\b/g;
const COMPANY = /\b(?:[A-Z][\w'&.-]*\s){0,3}[A-Z][\w'&.-]*\s(?:Plumbing|Electric(?:al)?|Heating|Cooling|HVAC|Repair|Repairs|Services?|Contractors?|Locksmiths?|Elevator|Appliance|Mechanical|Co\.|Inc\.?|Ltd\.?)\b/g;
const CLAIMS = /\b(licen[cs]ed|licen[cs]e|insured|insurance|bonded|certified|available|availability|24\/7|open now|cheap|affordable|lowest price|best price|discount)\b/gi;
const HEDGE = /\b(not|no|un\w*|unknown|verify|confirm|check|ask|whether|if)\b[^.!?]{0,30}$/i;

const normMoney = (s: string) => s.replace(/[^\d.]/g, "").replace(/\.0+$/, "").replace(/\.(\d)$/, ".$10");
const lower = (s: string) => s.toLowerCase();

export type Grounding = { ok: boolean; problems: string[] };

/** Checks `text` against `sources` (everything the agent was allowed to know). */
export function checkGrounding(text: string, sources: string[], o: { allowRelativeTime?: boolean } = {}): Grounding {
  const src = sources.filter(Boolean).join("\n");
  const srcLow = lower(src);
  const srcMoney = new Set((src.match(MONEY) ?? []).map(normMoney));
  const srcDigits = new Set((src.replace(/RLY-?\d+/gi, " ").match(NUMBER) ?? []).map((n) => String(Number(n))));
  const problems: string[] = [];
  const add = (p: string) => problems.includes(p) || problems.push(p);

  for (const m of text.match(MONEY) ?? []) if (!srcMoney.has(normMoney(m))) add(`mentions ${m}, which is not in the case`);
  for (const m of text.match(CLOCK) ?? []) if (!srcLow.includes(lower(m).replace(/\s/g, "")) && !srcLow.includes(lower(m))) add(`mentions the time "${m}", which is not in the case`);
  for (const m of text.match(WEEKDAY) ?? []) if (!new RegExp(`\\b${m.slice(0, 3)}`, "i").test(src)) add(`mentions ${m}, which is not in the case`);
  for (const m of text.match(MONTH_DAY) ?? []) if (!srcLow.includes(lower(m).replace(/\.\s*/, " "))) add(`mentions the date "${m}", which is not in the case`);
  if (!o.allowRelativeTime) for (const m of text.match(RELATIVE) ?? []) add(`promises timing ("${m}") that nobody confirmed`);
  for (const m of text.match(PROMISE) ?? []) add(`makes a promise ("${m}")`);
  for (const m of text.replace(MONEY, " ").replace(/RLY-?\d+/gi, " ").replace(CLOCK, " ").replace(MONTH_DAY, " ").match(NUMBER) ?? []) {
    if (!srcDigits.has(String(Number(m)))) add(`mentions the number ${m}, which is not in the case`);
  }
  for (const m of text.match(COMPANY) ?? []) {
    const name = m.trim();
    if (!srcLow.includes(lower(name))) add(`names "${name}", which is not in the case`);
  }
  for (const m of text.matchAll(CLAIMS)) {
    const before = text.slice(Math.max(0, (m.index ?? 0) - 40), m.index ?? 0);
    if (HEDGE.test(before)) continue;
    if (!srcLow.includes(lower(m[0]))) add(`claims "${m[0]}" without a source`);
  }
  return { ok: problems.length === 0, problems };
}
