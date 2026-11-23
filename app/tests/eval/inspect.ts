// Debug helper: show how V1.1's rules read given cases. Usage: npx tsx tests/eval/inspect.ts I005 I020 C002 ...
import { findHazards, triage } from "../../src/shared/triage";
import { loadDataset, routeOf } from "./common";

const data = loadDataset();
for (const id of process.argv.slice(2)) {
  const c = data.cases.find((x) => x.id === id);
  if (c) {
    const t = triage({ description: c.messages.join(" ") });
    console.log(`\n${id} [${c.scenario}] expected ${c.expected.category}/${c.expected.route}/${c.expected.emergency ? "EMERGENCY" : "no-emergency"}`);
    console.log(`  text: ${c.messages.join(" | ")}`);
    console.log(`  got:  ${t.category}/${routeOf(t)}/${t.severity} review=${t.needsReview} :: ${t.reasons.join(" ")}`);
    continue;
  }
  const k = data.coordinatorCases.find((x) => x.id === id);
  if (k) {
    const text = [k.case.description, ...Object.entries(k.case.facts).map(([a, b]) => `${a.replace(/_/g, " ")} ${String(b)}`)].join(". ");
    console.log(`\n${id} [${k.scenario}] escalate=${k.expected.escalate}\n  text: ${text}\n  hazards: ${JSON.stringify(findHazards(text))}`);
  }
}
