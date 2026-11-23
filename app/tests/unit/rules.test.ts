// Unit tests for the pure rules shared by the server and the pages. No server or database needed: npm test
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CASE_STATUSES, type CaseStatus } from "../../src/shared/domain.ts";
import { validateDetails } from "../../src/shared/intake.ts";
import { assertTransition, canPerform, ownership, TRANSITIONS, TransitionError } from "../../src/shared/machine.ts";
import { approvalRequired, overlaps, triage } from "../../src/shared/triage.ts";

describe("state machine", () => {
  test("every status except the closed ones has an owner and a next action", () => {
    for (const s of CASE_STATUSES) {
      const o = ownership(s);
      if (s === "RESOLVED" || s === "CANCELLED") assert.equal(o.holder, "NONE");
      else assert.ok(o.holder !== "NONE" && o.nextAction.length > 0, s);
    }
  });
  test("the main path is reachable in order", () => {
    const path: [Parameters<typeof assertTransition>[0], CaseStatus, Parameters<typeof assertTransition>[2], CaseStatus?][] = [
      ["TRIAGE", "NEW", "SYSTEM"],
      ["ROUTE", "TRIAGED", "SYSTEM"],
      ["ASSIGN_VENDOR", "AWAITING_ASSIGNMENT", "MANAGER"],
      ["VENDOR_ACCEPT", "AWAITING_VENDOR", "CONTRACTOR", "AWAITING_APPROVAL"],
      ["APPROVE_SPEND", "AWAITING_APPROVAL", "MANAGER"],
      ["CONFIRM_APPOINTMENT", "SCHEDULING", "RESIDENT"],
      ["START_WORK", "SCHEDULED", "CONTRACTOR"],
      ["COMPLETE_WORK", "IN_PROGRESS", "CONTRACTOR"],
      ["VERIFY_RESOLVED", "AWAITING_VERIFICATION", "RESIDENT"],
    ];
    const expected: CaseStatus[] = ["TRIAGED", "AWAITING_ASSIGNMENT", "AWAITING_VENDOR", "AWAITING_APPROVAL", "SCHEDULING", "SCHEDULED", "IN_PROGRESS", "AWAITING_VERIFICATION", "RESOLVED"];
    path.forEach(([action, from, by, to], i) => assert.equal(assertTransition(action, from, by, to), expected[i]));
  });
  test("a contractor can complete work but never resolve a case", () => {
    assert.throws(() => assertTransition("VERIFY_RESOLVED", "AWAITING_VERIFICATION", "CONTRACTOR"), (e: unknown) => e instanceof TransitionError && e.reason === "wrong_actor");
    assert.throws(() => assertTransition("CLOSE_UNVERIFIED", "AWAITING_VERIFICATION", "CONTRACTOR"), TransitionError);
  });
  test("the AI coordinator's powers are limited", () => {
    const agentActions = (Object.keys(TRANSITIONS) as (keyof typeof TRANSITIONS)[]).filter((a) => TRANSITIONS[a].by.includes("AGENT"));
    assert.deepEqual(agentActions.sort(), ["ASSIGN_VENDOR", "ESCALATE"]);
    assert.equal(canPerform("APPROVE_SPEND", "AWAITING_APPROVAL", "AGENT"), false);
    assert.equal(canPerform("RESUME", "ESCALATED", "AGENT"), false, "only a person can de-escalate");
  });
  test("work cannot be scheduled while an approval is pending, and closed cases stay closed", () => {
    assert.throws(() => assertTransition("CONFIRM_APPOINTMENT", "AWAITING_APPROVAL", "RESIDENT"), (e: unknown) => e instanceof TransitionError && e.reason === "wrong_state");
    assert.throws(() => assertTransition("ASSIGN_VENDOR", "RESOLVED", "MANAGER"), TransitionError);
    assert.throws(() => assertTransition("CANCEL", "RESOLVED", "RESIDENT"), TransitionError);
    assert.throws(() => assertTransition("ASSIGN_VENDOR", "ESCALATED", "MANAGER"), TransitionError, "no routine dispatch while escalated");
  });
  test("two-target actions require an explicit target from the allowed set", () => {
    assert.throws(() => assertTransition("VENDOR_ACCEPT", "AWAITING_VENDOR", "CONTRACTOR"), (e: unknown) => e instanceof TransitionError && e.reason === "wrong_target");
    assert.throws(() => assertTransition("VENDOR_ACCEPT", "AWAITING_VENDOR", "CONTRACTOR", "RESOLVED"), TransitionError);
  });
});

describe("triage safety rules", () => {
  test("hazards in the resident's words escalate", () => {
    for (const text of ["I smell gas in the kitchen", "There is smoke coming from the dryer", "The outlet is sparking", "A pipe burst and water is pouring out", "The CO alarm keeps going off"]) {
      const t = triage({ description: text });
      assert.equal(t.emergency, true, text);
      assert.equal(t.severity, "EMERGENCY", text);
      assert.ok(t.safetyAdvice, text);
    }
  });
  test("a chirping smoke detector is not a fire; a sounding alarm is", () => {
    const chirp = triage({ description: "The hallway smoke detector chirps every minute" });
    assert.equal(chirp.emergency, false);
    assert.equal(chirp.category, "OTHER");
    assert.equal(chirp.needsReview, true, "a person decides");
    assert.equal(triage({ description: "The smoke alarm is going off and I can't find why" }).emergency, true);
  });
  test("negated mentions are not hazards", () => {
    for (const text of ["No smoke or smell, the dryer just will not start", "There is no gas smell, the oven light is broken", "It is not sparking, the outlet is loose"]) {
      assert.equal(triage({ description: text }).emergency, false, text);
    }
  });
  test("a yes to a safety question escalates; an unsure answer goes to a person", () => {
    const yes = triage({ description: "Kitchen sink leaking", categoryHint: "PLUMBING", details: { fixture: "kitchen_sink", activeLeak: true, spreading: false, waterNearElectrical: true } });
    assert.equal(yes.emergency, true);
    const unsure = triage({ description: "Kitchen sink leaking", categoryHint: "PLUMBING", details: { fixture: "kitchen_sink", activeLeak: true, spreading: null, waterNearElectrical: false } });
    assert.equal(unsure.emergency, false);
    assert.equal(unsure.needsReview, true);
  });
  test("categories from wording, and unknown problems go to a person", () => {
    assert.equal(triage({ description: "The washing machine will not drain" }).category, "APPLIANCE");
    assert.equal(triage({ description: "No heat, the radiator is cold" }).category, "HVAC");
    assert.equal(triage({ description: "The water heater makes no hot water" }).category, "PLUMBING");
    const other = triage({ description: "The front door buzzer is broken" });
    assert.equal(other.category, "OTHER");
    assert.equal(other.needsReview, true);
  });
  test("no heat with someone at risk is an emergency", () => {
    const t = triage({ description: "Heating stopped", categoryHint: "HVAC", details: { system: "heating", completelyOut: true, vulnerableOccupant: true, burningOrGasSmell: false } });
    assert.equal(t.severity, "EMERGENCY");
  });
});

describe("intake validation", () => {
  test("keeps only the category's answers, in canonical types", () => {
    const r = validateDetails("PLUMBING", { fixture: "Kitchen sink", activeLeak: "yes", spreading: "no", waterNearElectrical: "not sure", injected: "<script>" });
    assert.ok(r.ok);
    if (r.ok) assert.deepEqual(r.details, { fixture: "kitchen_sink", activeLeak: true, spreading: false, waterNearElectrical: null });
  });
  test("reports missing and invalid answers", () => {
    const r = validateDetails("APPLIANCE", { appliance: "toaster", burningOrSparks: "maybe?" });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.deepEqual(r.missing.sort(), ["gasSmell", "problem"]);
      assert.deepEqual(r.invalid.sort(), ["appliance", "burningOrSparks"]);
    }
  });
  test("text answers of 'none' are treated as no answer", () => {
    const r = validateDetails("APPLIANCE", { appliance: "washer", problem: "wont_drain", errorCode: "none", burningOrSparks: false, gasSmell: false });
    assert.ok(r.ok && !("errorCode" in r.details));
  });
});

describe("spending and scheduling rules", () => {
  test("fixed estimates at or under the threshold are approved by policy; inspection-first never is", () => {
    assert.equal(approvalRequired("FIXED", 25000, 25000), false);
    assert.equal(approvalRequired("FIXED", 25001, 25000), true);
    assert.equal(approvalRequired("INSPECTION_REQUIRED", 0, 25000), true);
    assert.equal(approvalRequired("FIXED", null, 25000), true);
  });
  test("overlap is half-open: back-to-back visits do not clash", () => {
    const at = (h: number) => new Date(Date.UTC(2026, 11, 1, h));
    assert.equal(overlaps(at(9), at(11), at(10), at(12)), true);
    assert.equal(overlaps(at(9), at(11), at(11), at(13)), false);
  });
});
