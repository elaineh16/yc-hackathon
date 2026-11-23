// Builds the evaluation summary from the saved runs, scoring V1 and V1.1 identically.
// The live intake rows are re-scored with the current checks: the resident's view includes the server's confirmation
// (which carries the safety advice for emergencies), and the facts check ignores labels and placeholders. Both only
// remove false flags, so re-scoring stored rows is exact.
// Run from app/: npx tsx tests/eval/report.ts   -> ../docs/evidence/eval-summary.json and a markdown table on stdout
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { triage as triageV11 } from "../../src/shared/triage";
import { triage as triageV1 } from "./baseline/shared/triage";
import { APP, loadDataset, median, pct, quantile, stillInvented, toldResident } from "./common";

const EV = join(APP, "..", "docs", "evidence");
const read = (f: string) => (existsSync(join(EV, f)) ? JSON.parse(readFileSync(join(EV, f), "utf-8")) : null);
const data = loadDataset();
const byId = new Map(data.cases.map((c) => [c.id, c]));

type LiveRow = {
  id: string;
  scenario: string;
  filed: string | null;
  final: { category: string; severity: string; emergency: boolean; needsReview: boolean } | null;
  interpretationOk: boolean;
  routeOk: boolean;
  severityOk: boolean;
  clarificationOk: boolean | null;
  toolChoiceOk: boolean | null;
  multiIssueOk: boolean | null;
  falseEscalation: boolean;
  missedEscalation: boolean;
  violations: string[];
  invented: string[];
  turnMs: number[];
  error: string | null;
  transcript: { resident: string; relay: string | null }[];
};

function rescore(variant: "v1" | "v1.1", rows: LiveRow[]) {
  return rows.map((r) => {
    const c = byId.get(r.id)!;
    const said = r.transcript.map((t) => t.resident).join("\n");
    const replies = r.transcript.map((t) => t.relay).filter((x): x is string => !!x && !x.startsWith("(the server"));
    if (r.filed === "submit" && r.final?.emergency) {
      // What production shows after an emergency submission (resultMessage): the rules' advice, or the 911 fallback.
      const advice = (variant === "v1" ? triageV1({ description: said }) : triageV11({ description: said })).safetyAdvice ?? "Keep away from the hazard. If anyone is in danger, call 911.";
      replies.push(`Your report is saved as RLY-0100. ${advice} The property manager has been alerted in Relay. It is being handled as an emergency, not as a routine repair.`);
    }
    const told = toldResident(replies, c.expected.residentMustBeTold);
    return { ...r, told, toldOk: told.every((x) => x.ok), invented: r.invented.filter((e) => stillInvented(e, said)) };
  });
}

function summarize(variant: string, rows: ReturnType<typeof rescore>) {
  const n = rows.length;
  const em = rows.filter((r) => byId.get(r.id)!.expected.emergency).length;
  const scored = (k: "clarificationOk" | "toolChoiceOk" | "multiIssueOk") => rows.filter((r) => r[k] !== null);
  const ms = rows.flatMap((r) => r.turnMs);
  const told = rows.filter((r) => r.told.length);
  return {
    variant,
    cases: n,
    errors: rows.filter((r) => r.error).length,
    interpretation: pct(rows.filter((r) => r.interpretationOk).length, n),
    route: pct(rows.filter((r) => r.routeOk).length, n),
    clarification: pct(scored("clarificationOk").filter((r) => r.clarificationOk).length, scored("clarificationOk").length),
    toolChoice: pct(scored("toolChoiceOk").filter((r) => r.toolChoiceOk).length, scored("toolChoiceOk").length),
    multiIssue: pct(scored("multiIssueOk").filter((r) => r.multiIssueOk).length, scored("multiIssueOk").length),
    falseEscalation: pct(rows.filter((r) => r.falseEscalation).length, n - em),
    missedSafetyEscalation: pct(rows.filter((r) => r.missedEscalation).length, em),
    safetyAdviceGiven: pct(told.filter((r) => r.toldOk).length, told.length),
    prohibitedBehaviour: pct(rows.filter((r) => r.violations.length).length, n),
    prohibitedKinds: Object.fromEntries(Object.entries(rows.flatMap((r) => r.violations).reduce<Record<string, number>>((m, v) => ({ ...m, [v]: (m[v] ?? 0) + 1 }), {}))),
    inventedFacts: pct(rows.filter((r) => r.invented.length).length, n),
    turnLatencyMs: { median: median(ms), p90: quantile(ms, 0.9), max: ms.length ? Math.max(...ms) : null },
    missedIds: rows.filter((r) => r.missedEscalation).map((r) => r.id),
    falseIds: rows.filter((r) => r.falseEscalation).map((r) => r.id),
  };
}

const det = read("eval-deterministic.json");
const l1 = read("eval-live-v1.json");
const l11 = read("eval-live-v1.1.json");
const c1 = read("eval-live-coordinator-v1.json");
const c11 = read("eval-live-coordinator-v1.1.json");
const firstHeldout = read("eval-deterministic-heldout-v1-first-scoring.json");
const live = l1 && l11 ? { v1: summarize("v1", rescore("v1", l1.rows)), v11: summarize("v1.1", rescore("v1.1", l11.rows)), subset: l1.subset, sameCases: JSON.stringify(l1.rows.map((r: LiveRow) => r.id)) === JSON.stringify(l11.rows.map((r: LiveRow) => r.id)) } : null;
const out = { generatedFrom: ["eval-deterministic.json", "eval-live-v1.json", "eval-live-v1.1.json", "eval-live-coordinator-v1.json", "eval-live-coordinator-v1.1.json"], deterministic: det ? { rules: det.rules, heldoutV1FirstScoring: firstHeldout?.heldout ?? null, heldoutV1Now: det.heldout, heldoutV2: det.heldoutV2 ?? null, policy: det.policy } : null, liveIntake: live, liveCoordinator: c1 && c11 ? { v1: c1.summary, v11: c11.summary } : null };
writeFileSync(join(EV, "eval-summary.json"), `${JSON.stringify(out, null, 2)}\n`);

const row = (label: string, a: unknown, b: unknown) => `| ${label} | ${a ?? "–"} | ${b ?? "–"} |`;
const lines: string[] = [];
if (det) {
  lines.push("### Rules layer, all 99 cases (deterministic, in-sample)", "", "| Metric | V1 | V1.1 |", "| --- | --- | --- |");
  for (const k of ["interpretation", "route", "severityInRange", "falseEscalation", "missedSafetyEscalation"]) lines.push(row(k, det.rules.v1[k], det.rules.v11[k]));
  const metrics = ["interpretation", "route", "severityInRange", "falseEscalation", "missedSafetyEscalation"];
  if (firstHeldout?.heldout) {
    lines.push("", `### Rules layer, held-out v1 (${firstHeldout.heldout.cases} cases), first and only out-of-sample scoring`, "", "| Metric | V1 | V1.1 |", "| --- | --- | --- |");
    for (const k of metrics) lines.push(row(k, firstHeldout.heldout.v1[k], firstHeldout.heldout.v11[k]));
  }
  if (det.heldout) {
    lines.push("", "### Rules layer, held-out v1 after the fixes it prompted (in-sample now)", "", "| Metric | V1 | V1.1 |", "| --- | --- | --- |");
    for (const k of metrics) lines.push(row(k, det.heldout.v1[k], det.heldout.v11[k]));
  }
  if (det.heldoutV2) {
    lines.push("", `### Rules layer, held-out v2 (${det.heldoutV2.cases} cases, written after the fixes, scored once)`, "", "| Metric | V1 | V1.1 |", "| --- | --- | --- |");
    for (const k of metrics) lines.push(row(k, det.heldoutV2.v1[k], det.heldoutV2.v11[k]));
  }
}
if (live) {
  lines.push("", `### Intake agent, live model (${live.v1.cases} cases, same subset for both: ${live.sameCases})`, "", "| Metric | V1 | V1.1 |", "| --- | --- | --- |");
  for (const k of ["interpretation", "route", "clarification", "toolChoice", "multiIssue", "falseEscalation", "missedSafetyEscalation", "safetyAdviceGiven", "prohibitedBehaviour", "inventedFacts"] as const) lines.push(row(k, live.v1[k], live.v11[k]));
  lines.push(row("turn latency median / p90 (s)", `${Math.round((live.v1.turnLatencyMs.median ?? 0) / 1000)} / ${Math.round((live.v1.turnLatencyMs.p90 ?? 0) / 1000)}`, `${Math.round((live.v11.turnLatencyMs.median ?? 0) / 1000)} / ${Math.round((live.v11.turnLatencyMs.p90 ?? 0) / 1000)}`));
}
if (c1 && c11) {
  lines.push("", `### Coordinator, live model (${c1.summary.cases} cases)`, "", "| Metric | V1 | V1.1 |", "| --- | --- | --- |");
  for (const k of ["casesWithUnauthorizedAttempt", "unauthorizedExecuted", "falseEscalationAttempted", "falseEscalationExecuted", "missedHazard", "draftsWithInventedFactsWritten", "draftsWithInventedFactsSaved", "usedDiscoveryWhenNoVendor", "proposedAVendorWhenExpected"]) lines.push(row(k, c1.summary[k], c11.summary[k]));
  lines.push(row("run latency median / p90 (s)", `${Math.round((c1.summary.runLatencyMs.median ?? 0) / 1000)} / ${Math.round((c1.summary.runLatencyMs.p90 ?? 0) / 1000)}`, `${Math.round((c11.summary.runLatencyMs.median ?? 0) / 1000)} / ${Math.round((c11.summary.runLatencyMs.p90 ?? 0) / 1000)}`));
}
console.log(lines.join("\n"));
if (live) console.log(`\nlive intake missed escalations: v1 ${live.v1.missedIds.join(",") || "none"}; v1.1 ${live.v11.missedIds.join(",") || "none"}. false: v1 ${live.v1.falseIds.join(",") || "none"}; v1.1 ${live.v11.falseIds.join(",") || "none"}`);
