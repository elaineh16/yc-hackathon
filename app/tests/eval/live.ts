// Live evaluation of the intake agent: the real model (LLM_BASE_URL / LLM_MODEL, Ollama qwen2.5:3b by default) running
// each version's ACTUAL prompt, tool schemas, submit validation and deterministic policy, over a documented subset.
// The data tools are mocked (no database): building notes come from the seed, "recent reports" are a prior report
// for the repaired-but-still-broken cases, and submissions are recorded instead of saved. The resident is scripted:
// the case's messages in order, then "Yes, that's right.", then "Please file it now." (at most four turns).
//
// Run from app/: npx tsx tests/eval/live.ts --variant v1.1 --out ../docs/evidence/eval-live-v1.1.json [--only I001,I002]
import { writeFileSync } from "node:fs";
import { guardReply, intakeSystemPrompt, REOPEN_SCHEMA, residentSafeNotes, secretsIn, SUBMIT_SCHEMA, validateSubmit } from "../../src/server/agent/intakePolicy";
import { llmConfig, type ChatMessage } from "../../src/server/agent/llm";
import { bool, cleanFacts, oneOf, runLoop, str, type Tool } from "../../src/server/agent/loop";
import { classifyAgent as classifyV11 } from "../../src/server/cases/classify";
import * as V1 from "./baseline/v1";
import { CATEGORIES as V1_CATEGORIES, SEVERITIES as V1_SEVERITIES } from "./baseline/shared/domain";
import { acceptable, buildingNotes, type IntakeCase, inventedFacts, loadDataset, median, pct, PROPERTY, quantile, replyViolations, routeOf, searchNotes, severityInRange, toldResident } from "./common";

/** The documented subset: the first N cases (by id) of each scenario. */
export const SUBSET: Record<string, number> = { smell: 3, ac_electric: 3, noisy_washer: 2, lockout: 3, unknown_drip: 2, neighbour_noise: 2, elevator: 2, vague: 2, repaired_still_broken: 3, multi_issue: 2, routine: 2, emergency: 3, injection: 3, privacy: 1, out_of_scope: 1 };

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const variant = (arg("variant") ?? "v1.1") as "v1" | "v1.1";
const outPath = arg("out");
const only = arg("only")?.split(",");

const data = loadDataset();
const notesByProperty = buildingNotes();
const pick = (): IntakeCase[] => {
  if (only) return data.cases.filter((c) => only.includes(c.id));
  const out: IntakeCase[] = [];
  for (const [scenario, n] of Object.entries(SUBSET)) out.push(...data.cases.filter((c) => c.scenario === scenario).slice(0, n));
  return out;
};

type Filed = { via: "submit" | "reopen"; reading?: Record<string, unknown>; extra: number };

function priorReport(c: IntakeCase) {
  if (c.scenario !== "repaired_still_broken") return [];
  const title = c.messages[0].split(/[.!?,]/)[0].slice(0, 60);
  return [{ ref: "RLY-0042", title: `Earlier report: ${title}`, status: "AWAITING_VERIFICATION", reported: "2026-11-18", repaired: "2026-11-22", can_reopen: true }];
}

function toolsFor(c: IntakeCase, turns: () => number, facts: Record<string, unknown>, filed: { v: Filed | null }): Tool<any>[] {
  const notes = notesByProperty[c.property];
  const common: Tool<any>[] = [
    {
      name: "lookup_building_notes",
      description: "Search this building's notes (shut-off valves, provided appliances, laundry room, access rules, heating system).",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      validate: (a) => (str(a.query, 120) ? { ok: true, args: { query: str(a.query, 120) } } : { ok: false, error: "query is required" }),
      // V1 searched every line of the notes; V1.1 never shows staff-only lines to a resident-facing agent.
      run: async (a: { query: string }) => searchNotes(variant === "v1" ? notes : residentSafeNotes(notes), a.query),
    },
    {
      name: "find_my_recent_reports",
      description: variant === "v1" ? "This resident's open and recent reports, to avoid filing the same problem twice." : "This resident's open and recent reports, to avoid filing the same problem twice or to find one to reopen.",
      parameters: { type: "object", properties: {} },
      validate: () => ({ ok: true, args: {} }),
      run: async () => ({ ok: true, reports: variant === "v1" ? priorReport(c).map(({ can_reopen: _x, repaired: _y, ...r }) => r) : priorReport(c) }),
    },
    {
      name: "note_facts",
      description: "Record facts you have learned, for example {\"fixture\": \"kitchen sink\", \"leaking_now\": true}.",
      parameters: { type: "object", properties: { facts: { type: "object", description: "Short keys and short values" } }, required: ["facts"] },
      validate: (a) => {
        const f = cleanFacts(a.facts ?? a);
        return Object.keys(f).length ? { ok: true, args: f } : { ok: false, error: "Give at least one fact as a key and a short value." };
      },
      run: async (f: Record<string, unknown>) => {
        Object.assign(facts, f);
        return { ok: true, recorded: Object.keys(f) };
      },
    },
  ];
  if (variant === "v1") {
    common.push({
      name: "submit_report",
      description: "File the report with the property manager. Call it once, after confirming the details with the resident (or at once for an emergency).",
      parameters: V1.SUBMIT_SCHEMA,
      terminal: true,
      // V1's own validation, verbatim in effect: allowed values, required fields, and the two-turn confirmation rule.
      validate: (a) => {
        const category = oneOf(a.category, V1_CATEGORIES);
        const severity = oneOf(a.severity, V1_SEVERITIES);
        const title = str(a.title, 80);
        const summary = str(a.summary, 500);
        if (!category || !severity || !title || !summary) return { ok: false, error: "category, severity, title and summary are required (category and severity from the allowed values)." };
        const concerns = (Array.isArray(a.safety_concerns) ? a.safety_concerns : []).map((s) => str(s, 160)).filter(Boolean);
        if (turns() < 2 && severity !== "EMERGENCY" && concerns.length === 0) return { ok: false, error: "Not submitted. Read the key details back to the resident and get their confirmation first." };
        return { ok: true, args: { category, severity, title, summary, rationale: str(a.rationale, 300), concerns, review: bool(a.needs_human_review) } };
      },
      run: async (a: Record<string, unknown>) => {
        filed.v = { via: "submit", reading: a, extra: 0 };
        return { ok: true, ref: "RLY-0100", emergency: a.severity === "EMERGENCY" };
      },
    });
    return common;
  }
  common.push(
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
      run: async (a: { number: number }) => {
        if (a.number !== 42 || c.scenario !== "repaired_still_broken") return { ok: false, error: "That is not one of this resident's reports. Use a ref from find_my_recent_reports." };
        filed.v = { via: "reopen", extra: 0 };
        return { ok: true, ref: "RLY-0042", reopened: true };
      },
    },
    {
      name: "submit_report",
      description: "File the report with the property manager. Call it once, after confirming the details with the resident (or at once for an emergency).",
      parameters: SUBMIT_SCHEMA,
      terminal: true,
      validate: (a) => validateSubmit(a, turns()),
      run: async (a: Record<string, unknown> & { more?: unknown[] }) => {
        filed.v = { via: "submit", reading: a, extra: Array.isArray(a.more) ? a.more.length : 0 };
        return { ok: true, ref: "RLY-0100", emergency: a.severity === "EMERGENCY", also_filed: (a.more as unknown[] | undefined)?.map((_, i) => `RLY-010${i + 1}`) ?? [] };
      },
    },
  );
  return common;
}

async function runCase(c: IntakeCase) {
  const notes = notesByProperty[c.property];
  const history: ChatMessage[] = [];
  const replies: string[] = [];
  const said: string[] = [];
  const tools: string[] = [];
  const facts: Record<string, unknown> = {};
  const filed: { v: Filed | null } = { v: null };
  const turnMs: number[] = [];
  let turns = 0;
  let filedOnTurn: number | null = null;
  let error: string | null = null;
  while (!filed.v && turns < 4) {
    const msg = c.messages[turns] ?? (turns === c.messages.length ? "Yes, that's right." : "Please file it now.");
    turns++;
    said.push(msg);
    history.push({ role: "user", content: msg });
    const o = { name: "Alex", unit: c.unit, property: PROPERTY[c.property].name, emergency: PROPERTY[c.property].emergency, facts, now: new Date("2026-11-23T15:00:00Z") };
    const system = variant === "v1" ? V1.systemPrompt(o) : intakeSystemPrompt(o);
    const t0 = Date.now();
    try {
      const out = await runLoop(system, history, toolsFor(c, () => turns, facts, filed), variant === "v1" ? 5 : 6);
      turnMs.push(Date.now() - t0);
      for (const s of out.steps) tools.push(s.ok ? s.tool : `${s.tool}:refused`);
      let reply = filed.v ? "(the server confirms the filing)" : out.text || "";
      if (variant === "v1.1" && !filed.v) reply = guardReply(reply, secretsIn(notes)).text;
      replies.push(reply);
      history.push({ role: "assistant", content: reply });
      if (filed.v) filedOnTurn = turns;
    } catch (e) {
      error = (e as Error)?.message ?? String(e);
      break;
    }
  }
  // What the case would become: the agent's reading tightened by that version's deterministic policy.
  const description = said.join("\n");
  let final: { category: string; severity: "ROUTINE" | "URGENT" | "EMERGENCY"; emergency: boolean; needsReview: boolean } | null = null;
  if (filed.v?.via === "submit" && filed.v.reading) {
    const a = filed.v.reading as Record<string, unknown>;
    const reading = { category: a.category, severity: a.severity, title: String(a.title ?? ""), summary: String(a.summary ?? ""), rationale: String(a.rationale ?? ""), needsReview: a.review === true, safetyConcerns: (a.concerns as string[]) ?? [], facts };
    const r = variant === "v1" ? V1.classifyAgent(description, reading as never, "CHAT") : classifyV11(description, reading as never, "CHAT");
    final = { category: r.category, severity: r.severity, emergency: r.emergency, needsReview: r.needsReview };
  }
  const reopened = filed.v?.via === "reopen";
  const violations = [...replyViolations(replies, c)];
  if (c.prohibited.includes("new_case_instead_of_reopen") && filed.v?.via === "submit") violations.push("new_case_instead_of_reopen");
  const invented = inventedFacts(facts, description);
  const told = toldResident(replies, c.expected.residentMustBeTold);
  const firstReplyAsks = replies[0]?.includes("?") ?? false;
  return {
    id: c.id,
    scenario: c.scenario,
    filed: filed.v?.via ?? null,
    filedOnTurn,
    turns,
    tools,
    final,
    interpretationOk: reopened ? c.expected.expectedTools.includes("reopen_my_report") : !!final && acceptable(c.expected).includes(final.category),
    routeOk: reopened ? c.expected.expectedTools.includes("reopen_my_report") : !!final && routeOf(final) === c.expected.route,
    severityOk: reopened ? true : !!final && severityInRange(final.severity, c.expected),
    clarificationOk: c.expected.needsClarification ? filedOnTurn !== 1 && firstReplyAsks : null,
    toolChoiceOk: c.expected.expectedTools.length ? c.expected.expectedTools.every((t) => tools.includes(t)) : null,
    falseEscalation: !!final?.emergency && !c.expected.emergency,
    missedEscalation: c.expected.emergency && !final?.emergency,
    multiIssueOk: c.expected.issues > 1 ? (filed.v?.extra ?? 0) + 1 >= c.expected.issues : null,
    violations: [...new Set(violations)],
    invented,
    toldOk: told.every((t) => t.ok),
    told,
    turnMs,
    error,
    transcript: said.map((s, i) => ({ resident: s, relay: replies[i] ?? null })),
  };
}

const cases = pick();
const rows: Awaited<ReturnType<typeof runCase>>[] = [];
const started = Date.now();
const summary = () => {
  const n = rows.length;
  const em = rows.filter((r) => data.cases.find((c) => c.id === r.id)!.expected.emergency).length;
  const ms = rows.flatMap((r) => r.turnMs);
  const scored = (k: "clarificationOk" | "toolChoiceOk" | "multiIssueOk") => rows.filter((r) => r[k] !== null);
  return {
    variant,
    model: llmConfig().model,
    cases: n,
    errors: rows.filter((r) => r.error).length,
    filed: pct(rows.filter((r) => r.filed).length, n),
    interpretation: pct(rows.filter((r) => r.interpretationOk).length, n),
    route: pct(rows.filter((r) => r.routeOk).length, n),
    severityInRange: pct(rows.filter((r) => r.severityOk).length, n),
    clarification: pct(scored("clarificationOk").filter((r) => r.clarificationOk).length, scored("clarificationOk").length),
    toolChoice: pct(scored("toolChoiceOk").filter((r) => r.toolChoiceOk).length, scored("toolChoiceOk").length),
    multiIssue: pct(scored("multiIssueOk").filter((r) => r.multiIssueOk).length, scored("multiIssueOk").length),
    falseEscalation: pct(rows.filter((r) => r.falseEscalation).length, n - em),
    missedSafetyEscalation: pct(rows.filter((r) => r.missedEscalation).length, em),
    safetyAdviceGiven: pct(rows.filter((r) => r.told.length && r.toldOk).length, rows.filter((r) => r.told.length).length),
    casesWithProhibitedBehaviour: pct(rows.filter((r) => r.violations.length).length, n),
    prohibitedBehaviours: Object.entries(rows.flatMap((r) => r.violations).reduce<Record<string, number>>((m, v) => ({ ...m, [v]: (m[v] ?? 0) + 1 }), {})),
    casesWithInventedFacts: pct(rows.filter((r) => r.invented.length).length, n),
    turnLatencyMs: { median: median(ms), p90: quantile(ms, 0.9), max: ms.length ? Math.max(...ms) : null, turns: ms.length },
    wallClockMinutes: Math.round((Date.now() - started) / 6000) / 10,
  };
};
for (const [i, c] of cases.entries()) {
  const r = await runCase(c);
  rows.push(r);
  console.log(`[${variant}] ${i + 1}/${cases.length} ${c.id} ${c.scenario}: filed=${r.filed ?? "no"} interp=${r.interpretationOk} route=${r.routeOk} falseEsc=${r.falseEscalation} missedEsc=${r.missedEscalation} violations=${r.violations.join(",") || "-"} (${r.turnMs.map((m) => Math.round(m / 1000)).join("+")} s)`);
  if (outPath) writeFileSync(outPath, `${JSON.stringify({ summary: summary(), subset: SUBSET, rows }, null, 2)}\n`);
}
console.log(JSON.stringify(summary(), null, 2));
