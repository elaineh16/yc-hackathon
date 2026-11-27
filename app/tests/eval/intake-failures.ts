// Does a chat report reach a person when the assistant cannot finish it? A scenario benchmark over HTTP against a
// dev server with RELAY_TEST_HOOKS=true and FIBER_MODE=fixture. Run it with no model (LLM_DISABLED=true) so the
// assistant is offline, as in CI. It resets all cases.
//
// For each scenario a resident sends one chat message while the assistant is broken in one of two ways:
//   offline: the model is unreachable (every turn fails at once);
//   error:   a failure that is not the model's, on every attempt (the test fault point "intake.turn").
// "Reached a person" means something a property manager can see appeared after the message: a case for that resident
// or a manager notification. The time to it is measured from the moment the message was accepted.
//
// Usage (from app/): npx tsx tests/eval/intake-failures.ts <label>   (writes ../docs/evidence/intake-failures-<label>.json)
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hook, login, type User } from "../api/client";

const label = process.argv[2] ?? "run";
const MESSAGES = [
  { id: "H1", hazard: true, resident: "priya", text: "There's a strong smell of gas in my kitchen." },
  { id: "H2", hazard: true, resident: "daniel", text: "Water is pouring through the ceiling light in my bathroom and it's sparking." },
  { id: "N1", hazard: false, resident: "priya", text: "My dishwasher won't drain after the cycle finishes." },
  { id: "N2", hazard: false, resident: "daniel", text: "The bathroom fan has become very loud." },
];
const MODES = ["offline", "error"] as const;
const WAIT_MS = 60_000;

const users: Record<string, User> = {};
for (const u of ["priya", "daniel", "morgan"]) users[u] = await login(u);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Row = { scenario: string; mode: string; hazard: boolean; reached: boolean; how: string | null; ms: number | null; residentReply: string | null; caseRef: string | null };
const rows: Row[] = [];
for (const m of MESSAGES) {
  for (const mode of MODES) {
    await hook("reset");
    const ai = await users[m.resident].must("getAiStatus");
    if (ai.available) throw new Error("Run this against a server without a model (LLM_DISABLED=true): the assistant must be offline.");
    if (mode === "error") await hook("fault", { point: "intake.turn", times: 10 });
    const unitId = (await users[m.resident].must("getMe")).units[0].id;
    const conv = await users[m.resident].must("getIntakeConversation", { unitId, fresh: true });
    const seenNotes = new Set(((await users.morgan.must("getNotifications")).items ?? []).map((n: any) => n.id));
    await users[m.resident].must("sendIntakeMessage", { conversationId: conv.id, text: m.text });
    const t0 = Date.now();
    let reached: Row["how"] = null;
    let ms: number | null = null;
    let caseRef: string | null = null;
    while (Date.now() - t0 < WAIT_MS) {
      const cases = (await users.morgan.must("searchCases", { pageSize: 20 })).items as any[];
      const who = m.resident === "priya" ? "Priya" : "Daniel";
      const mine = cases.find((c) => (c.residentName ?? "").includes(who));
      const notes = ((await users.morgan.must("getNotifications")).items ?? []).filter((n: any) => !seenNotes.has(n.id));
      if (mine || notes.length) {
        reached = mine ? "case" : `manager notification: ${notes[0].title}`;
        caseRef = mine?.ref ?? null;
        ms = Date.now() - t0;
        break;
      }
      await sleep(250);
    }
    // What the resident was told (the last Relay line), once the turn has finished.
    let residentReply: string | null = null;
    for (let i = 0; i < 120; i++) {
      const v = await users[m.resident].must("getIntakeConversation", { unitId, conversationId: conv.id });
      if (!v.pending) {
        residentReply = [...v.messages].reverse().find((x: any) => x.role === "relay")?.text ?? null;
        break;
      }
      await sleep(500);
    }
    if (mode === "error") await hook("fault", { point: "intake.turn", times: 0 });
    rows.push({ scenario: m.id, mode, hazard: m.hazard, reached: reached !== null, how: reached, ms, residentReply, caseRef });
    console.log(`${m.id} ${mode.padEnd(7)} reached a person: ${reached ? `yes (${ms} ms, ${reached})` : "no"}`);
  }
}
await hook("reset");

const by = (f: (r: Row) => boolean) => ({ reached: rows.filter((r) => f(r) && r.reached).length, of: rows.filter(f).length });
const summary = { all: by(() => true), hazard: by((r) => r.hazard), nonHazard: by((r) => !r.hazard), offline: by((r) => r.mode === "offline"), error: by((r) => r.mode === "error") };
const out = { label, at: new Date().toISOString(), waitedMs: WAIT_MS, definition: "a case for the resident or a manager notification appeared after the message", summary, rows };
const dir = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "docs", "evidence");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, `intake-failures-${label}.json`), `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify(summary));
