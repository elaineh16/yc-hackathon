// The chat intake's safety net (src/server/agent/intakeSafety.ts): what in a chat must reach a person whatever the
// assistant does. Pure logic; the server paths are covered in tests/api/intake-safety.test.ts.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { idleReviewDue, residentWordsOf, safetyScreen } from "../../src/server/agent/intakeSafety.ts";

describe("the safety screen reads residents' chat words with the filing rules", () => {
  test("possible emergencies are caught from a chat message", () => {
    for (const text of [
      "There's a strong smell of gas in my kitchen.",
      "Water is pouring through the ceiling light in my bathroom and it's sparking.",
      "There is smoke coming out of the outlet behind the fridge.",
    ]) {
      assert.equal(safetyScreen(text).emergency, true, text);
    }
  });
  test("ordinary problems, and hazards the resident rules out, are not", () => {
    for (const text of ["My dishwasher won't drain after the cycle finishes.", "The bathroom fan has become very loud.", "The kitchen tap drips. No gas smell, nothing near the outlets."]) {
      assert.equal(safetyScreen(text).emergency, false, text);
    }
  });
  test("only the resident's own lines are screened and forwarded, never Relay's", () => {
    const messages = [
      { role: "relay", text: "Is there any smell of gas or smoke?" },
      { role: "resident", text: "No, it's just the fan." },
      { role: "relay", text: "Thanks." },
    ];
    assert.equal(residentWordsOf(messages), "No, it's just the fan.");
    assert.equal(safetyScreen(residentWordsOf(messages)).emergency, false, "Relay's question about gas is not the resident's words");
  });
});

describe("an unfinished conversation goes to a person once it is idle", () => {
  const base = { status: "OPEN", caseId: null, reviewSince: null, pendingSince: null, messages: [{ role: "resident", text: "The sink is blocked." }] };
  const now = new Date("2026-11-25T12:00:00Z");
  const ago = (min: number) => new Date(now.getTime() - min * 60_000);
  test("after the idle time, with something the resident said", () => {
    assert.equal(idleReviewDue({ ...base, updatedAt: ago(31) }, now, 30), true);
    assert.equal(idleReviewDue({ ...base, updatedAt: ago(29) }, now, 30), false);
  });
  test("not when filed, already in review, waiting for a reply, or empty", () => {
    assert.equal(idleReviewDue({ ...base, caseId: "c", updatedAt: ago(60) }, now, 30), false);
    assert.equal(idleReviewDue({ ...base, reviewSince: ago(10), updatedAt: ago(60) }, now, 30), false);
    assert.equal(idleReviewDue({ ...base, pendingSince: ago(1), updatedAt: ago(60) }, now, 30), false);
    assert.equal(idleReviewDue({ ...base, messages: [{ role: "relay", text: "Hi, I'm Relay." }], updatedAt: ago(60) }, now, 30), false);
    assert.equal(idleReviewDue({ ...base, status: "ABANDONED", updatedAt: ago(60) }, now, 30), false);
  });
});
