// Unit tests for the pure Relay rules. Run: npm test
import assert from "node:assert/strict";
import { test } from "node:test";
import * as D from "../src/server/relay/domain.ts";

const report = {
  demo_session_id: "s1",
  residence: "mkv",
  room: "main   laundry room",
  washer: "Washer #2",
  symptom: "won't drain",
  floor_status: "dry",
  error_code: "oe",
};

test("parseIntake normalizes the demo report", () => {
  const r = D.parseIntake(report);
  assert.ok(r.ok);
  assert.equal(r.value.residence, "MKV");
  assert.equal(r.value.room, "Main Laundry Room");
  assert.equal(r.value.machine, "Washer 2");
  assert.equal(r.value.floorStatus, "DRY");
  assert.equal(r.value.reportedErrorCode, "OE");
  assert.equal(D.isHazard(r.value), false);
  assert.equal(D.openKeyFor(r.value), "mkv|main laundry room|washer 2");
});

test("parseIntake lists every missing field and rejects unknown floor status", () => {
  const r = D.parseIntake({ demo_session_id: "s1", floor_status: "maybe" });
  assert.equal(r.ok, false);
  if (!r.ok) assert.deepEqual(r.errors, ["residence", "room", "washer", "symptom", "floor_status"]);
});

test("washer numbers in words and digits normalize the same way", () => {
  for (const v of ["2", 2, "washer 2", "washer two", "Washer no. 2", "washer number 2"]) assert.equal(D.normalizeMachine(v), "Washer 2", String(v));
});

test("water on the floor or a reported hazard escalates", () => {
  const wet = D.parseIntake({ ...report, floor_status: "water on the floor" });
  assert.ok(wet.ok && D.isHazard(wet.value));
  const hazard = D.parseIntake({ ...report, safety_hazard: true });
  assert.ok(hazard.ok && D.isHazard(hazard.value));
  const noCode = D.parseIntake({ ...report, error_code: "none" });
  assert.ok(noCode.ok && noCode.value.reportedErrorCode === null);
});

test("fingerprint changes only when the report changes", () => {
  const a = D.parseIntake(report);
  const b = D.parseIntake({ ...report, room: "Main Laundry Room" });
  const c = D.parseIntake({ ...report, symptom: "won't drain, door locked" });
  assert.ok(a.ok && b.ok && c.ok);
  assert.equal(D.fingerprint(a.value), D.fingerprint(b.value));
  assert.notEqual(D.fingerprint(a.value), D.fingerprint(c.value));
});

test("Bluejay is recommended: QuickFix is diagnostic-only and Metro is unknown", () => {
  const rec = D.recommend(D.SEEDED_RESULTS);
  assert.equal(rec?.contractorKey, "bluejay");
  assert.equal(rec?.priceCents, 32_900);
  assert.match(rec!.text, /QuickFix .* not a comparable repair price/);
  assert.match(rec!.text, /Metro went to voicemail/);
  assert.equal(D.recommend(D.SEEDED_RESULTS.filter((r) => r.scope !== "REPAIR")), null);
});

test("approval policy: $329 needs approval over the $250 threshold; cap must cover the estimate", () => {
  const p = D.policy({});
  assert.equal(p.autoApproveLimitCents, 25_000);
  assert.equal(p.hardCapCents, 100_000);
  assert.ok(D.needsApproval(32_900, p.autoApproveLimitCents));
  assert.ok(!D.needsApproval(25_000, p.autoApproveLimitCents));
  assert.equal(D.validateCap(40_000, 32_900, p.hardCapCents), null);
  assert.match(D.validateCap(30_000, 32_900, p.hardCapCents)!, /below/);
  assert.match(D.validateCap(150_000, 32_900, p.hardCapCents)!, /hard cap/);
  assert.match(D.validateCap("400", 32_900, p.hardCapCents)!, /whole number/);
  assert.equal(D.policy({ AUTO_APPROVE_LIMIT: "5000", HARD_CAP: "1000" }).autoApproveLimitCents, 100_000);
});

test("arrival window is tomorrow 9 to 11 AM Toronto time", () => {
  const w = D.arrivalWindow(new Date("2026-11-22T18:00:00Z"));
  assert.equal(w.start.toISOString(), "2026-11-23T14:00:00.000Z");
  assert.equal(w.end.toISOString(), "2026-11-23T16:00:00.000Z");
  assert.match(w.label, /^Tomorrow \(Monday, Nov\.? 23\), 9:00–11:00 AM$/);
});

test("student labels", () => {
  assert.equal(D.staffLabel({ status: "ACCEPTED", etaMinutes: 15, assignedTo: "STAFF", priority: "NORMAL" }), "Staff on the way · 15 minutes");
  assert.equal(D.staffLabel({ status: "RETRIEVED", etaMinutes: 15, assignedTo: "STAFF", priority: "NORMAL" }), "Clothes retrieved");
  assert.match(D.repairLabel("CONFIRMED", { contractorName: "Bluejay", arrivalWindow: "Tomorrow" }), /Bluejay arriving Tomorrow \(simulated\)/);
  assert.match(D.agentMessage(false, true), /^The report is saved\./);
});
