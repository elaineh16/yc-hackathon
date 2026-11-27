// Replaces rows of a live run that failed for infrastructure reasons (the model timed out because the machine was busy)
// with a rerun of exactly those cases, and records which rows were rerun and why. Rows that completed are never
// replaced, so a rerun cannot improve a result the model actually produced.
// Run from app/: npx tsx tests/eval/merge-rerun.ts <run.json> <rerun.json> "<reason>"
import { readFileSync, writeFileSync } from "node:fs";

type Row = { id: string; error?: string | null };
const [runPath, rerunPath, reason] = process.argv.slice(2);
if (!runPath || !rerunPath || !reason) throw new Error("usage: merge-rerun.ts <run.json> <rerun.json> <reason>");
const run = JSON.parse(readFileSync(runPath, "utf-8")) as { rows: Row[]; reruns?: unknown[] };
const rerun = JSON.parse(readFileSync(rerunPath, "utf-8")) as { rows: Row[] };
const replaced: { id: string; firstError: string; rerunError: string | null }[] = [];
for (const r of rerun.rows) {
  const i = run.rows.findIndex((x) => x.id === r.id);
  if (i < 0) continue;
  if (!run.rows[i].error) {
    console.warn(`${r.id}: completed in the original run, kept as it was`);
    continue;
  }
  replaced.push({ id: r.id, firstError: String(run.rows[i].error), rerunError: r.error ? String(r.error) : null });
  run.rows[i] = r;
}
run.reruns = [...(run.reruns ?? []), { at: new Date().toISOString(), reason, replaced }];
// The stored summary was computed before the rerun; the report recomputes everything from the rows.
(run as { summary?: Record<string, unknown> }).summary = { ...((run as { summary?: Record<string, unknown> }).summary ?? {}), note: "Computed before the rerun: use eval-summary.json, which is recomputed from these rows." };
writeFileSync(runPath, `${JSON.stringify(run, null, 2)}\n`);
console.log(`replaced ${replaced.length} row(s): ${replaced.map((x) => `${x.id}${x.rerunError ? " (failed again)" : ""}`).join(", ")}`);
