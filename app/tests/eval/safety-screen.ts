// How much of the chat safety net is deterministic: the safety screen (the same rules that classify a filed report)
// run on residents' own chat words, over every intake case in the evaluation datasets. No model, no server.
//
// Production screens everything the resident has said so far after each of their messages, and files at the first
// message where the screen fires. This script does the same, message by message:
//   - emergencies the screen files at once (on the first message, and at any point in the conversation);
//   - non-emergencies it would wrongly file as emergencies at any point (the attention cost).
// "Whole conversation" (all the resident's words at once) is kept for comparison with the first version of this
// script, which reported only that and the first message, and so missed a filing that a later message would have
// argued against.
// The held-out sets are measured, never tuned on: the rules are not changed by this script or its results.
// Usage (from app/): npx tsx tests/eval/safety-screen.ts      (writes ../docs/evidence/safety-screen.json)
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { safetyScreen } from "../../src/server/agent/intakeSafety";
import { loadDataset } from "./common";

/** 95% Wilson score interval, as [low, high] in percent. */
function wilson(k: number, n: number): [number, number] {
  if (n === 0) return [0, 0];
  const z = 1.96, p = k / n, d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d, h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.round(Math.max(0, c - h) * 1000) / 10, Math.round(Math.min(1, c + h) * 1000) / 10];
}
const rate = (k: number, n: number) => ({ k, n, ci95: wilson(k, n) });

const out: Record<string, unknown> = {
  at: new Date().toISOString(),
  screen: "safetyScreen(): triage() over the resident's words only, re-run after each resident message",
  interval: "95% Wilson score interval, in percent",
};
for (const file of ["cases.v1.json", "heldout.v1.json", "heldout.v2.json"]) {
  const d = loadDataset(file);
  type C = (typeof d.cases)[number];
  // The 1-based resident message at which the screen first fires, or null.
  const firesAt = (c: C) => {
    for (let k = 1; k <= c.messages.length; k++) if (safetyScreen(c.messages.slice(0, k).join("\n")).emergency) return k;
    return null;
  };
  const whole = (c: C) => safetyScreen(c.messages.join("\n")).emergency;
  const em = d.cases.filter((c) => c.expected.emergency);
  const non = d.cases.filter((c) => !c.expected.emergency);
  const emAt = em.map((c) => ({ id: c.id, at: firesAt(c) }));
  const nonAt = non.map((c) => ({ id: c.id, at: firesAt(c) }));
  const row = {
    cases: d.cases.length,
    emergencies: em.length,
    caughtOnFirstMessage: rate(emAt.filter((x) => x.at === 1).length, em.length),
    caughtAtAnyPoint: rate(emAt.filter((x) => x.at !== null).length, em.length),
    caughtAt: Object.fromEntries(emAt.filter((x) => x.at !== null).map((x) => [x.id, x.at])),
    missed: emAt.filter((x) => x.at === null).map((x) => x.id),
    nonEmergencies: non.length,
    falselyFiledAtAnyPoint: rate(nonAt.filter((x) => x.at !== null).length, non.length),
    falseTriggers: Object.fromEntries(nonAt.filter((x) => x.at !== null).map((x) => [x.id, x.at])),
    forComparison: {
      caughtOverWholeConversation: em.filter(whole).length,
      falselyFiledOverWholeConversation: non.filter(whole).length,
    },
  };
  out[file] = row;
  const f = (r: { k: number; n: number; ci95: [number, number] }) => `${r.k}/${r.n} [${r.ci95[0]}–${r.ci95[1]}%]`;
  console.log(
    `${file.padEnd(16)} emergencies filed at once: first message ${f(row.caughtOnFirstMessage)}, at any point ${f(row.caughtAtAnyPoint)}; ` +
      `non-emergencies filed as emergencies: ${f(row.falselyFiledAtAnyPoint)} ${JSON.stringify(row.falseTriggers)}; missed ${row.missed.join(",") || "none"}`,
  );
}
writeFileSync(join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "docs", "evidence", "safety-screen.json"), `${JSON.stringify(out, null, 2)}\n`);
