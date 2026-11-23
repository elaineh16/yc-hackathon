// What a resident-facing agent may see of the building notes, and the last check on its replies. Pure functions, no
// server. Run from app/: npx tsx --test tests/unit/policy.test.ts
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { guardReply, residentSafeNotes, secretsIn } from "../../src/server/agent/intakePolicy";

describe("staff-only building notes", () => {
  test("a marked line is hidden, the rest of its paragraph is not", () => {
    const notes = "Lockouts: staff check identity against the lease.\nSTAFF ONLY: the key cabinet code is 4417.";
    assert.equal(residentSafeNotes(notes), "Lockouts: staff check identity against the lease.");
    assert.deepEqual(secretsIn(notes), ["4417"]);
  });

  test("markers written as bullets, quotes, numbered items or in bold are recognised", () => {
    for (const line of ["- STAFF ONLY: code 4417", "* Staff-only: code 4417", "**Staff only:** code 4417", "> Internal: code 4417", "2. Confidential: code 4417", "• Not for residents: code 4417"]) {
      const shown = residentSafeNotes(`Laundry is in the basement.\n${line}`);
      assert.equal(shown.includes("4417"), false, `leaked through "${line}"`);
      assert.ok(shown.includes("Laundry"), `hid too much for "${line}"`);
    }
  });

  test("continuation lines of a staff block stay hidden until the next blank line", () => {
    const notes = "STAFF ONLY: the lockbox is behind the bins.\nIts combination is 2580.\n\nParking is behind the building.";
    const shown = residentSafeNotes(notes);
    assert.equal(shown.includes("2580"), false);
    assert.equal(shown.includes("lockbox"), false);
    assert.ok(shown.includes("Parking"));
    assert.deepEqual(secretsIn(notes), ["2580"]);
  });

  test("a staff-only heading hides its whole section, up to the next heading", () => {
    const notes = "## Staff only\nAlarm panel PIN 9921.\n\nWifi password maple2026.\n\n## Residents\nQuiet hours start at 11 pm.";
    const shown = residentSafeNotes(notes);
    assert.equal(/9921|maple2026/.test(shown), false);
    assert.ok(shown.includes("Quiet hours"));
    assert.deepEqual(secretsIn(notes).sort(), ["9921", "maple2026"]);
  });

  test("ordinary notes are untouched", () => {
    const notes = "The elevator is serviced under contract.\n\nRecycling goes out on Tuesdays.";
    assert.equal(residentSafeNotes(notes), notes);
    assert.deepEqual(secretsIn(notes), []);
  });
});

describe("the reply guard", () => {
  const secrets = ["4417", "maple2026"];
  test("a secret is withheld however it is written", () => {
    for (const reply of ["The code is 4417.", "Try 4 4 1 7 on the keypad.", "It is 4-4-1-7.", "Spell it: four four one seven.", "The wifi is Maple2026."]) {
      const g = guardReply(reply, secrets);
      assert.equal(/4\D?4\D?1\D?7|four four one seven|maple2026/i.test(g.text), false, `not withheld: "${reply}" became "${g.text}"`);
      assert.ok(g.redacted.length > 0);
    }
  });

  test("anything that reads as a code is withheld even when it is not a known secret", () => {
    const g = guardReply("The lockbox combination is 8812.", []);
    assert.equal(g.text.includes("8812"), false);
    assert.deepEqual(g.redacted, ["8812"]);
  });

  test("ordinary numbers are left alone", () => {
    const reply = "Your report is RLY-0042. Someone will reply within 24 hours; the emergency line is 519-555-0100.";
    assert.equal(guardReply(reply, secrets).text, reply);
  });
});
