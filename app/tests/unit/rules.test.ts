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
    // V1.1 added locks, keys and doors as a category; before that this example went to a person as "other".
    assert.equal(triage({ description: "The front door buzzer is broken" }).category, "ACCESS");
    const other = triage({ description: "There is a big tear in the hallway carpet" });
    assert.equal(other.category, "OTHER");
    assert.equal(other.needsReview, true);
  });
  test("V1.1 categories from wording", () => {
    assert.equal(triage({ description: "Half the outlets in my living room stopped working" }).category, "ELECTRICAL");
    assert.equal(triage({ description: "The lights keep flickering in the bedroom" }).category, "ELECTRICAL");
    assert.equal(triage({ description: "The elevator doors won't close on the 3rd floor" }).category, "ELEVATOR");
    assert.equal(triage({ description: "My upstairs neighbour plays loud music every night until 2am" }).category, "NOISE");
    assert.equal(triage({ description: "The washer is really noisy during the spin cycle but it works" }).category, "APPLIANCE");
  });
  test("a person smoking next door is not a fire; a smoking outlet is", () => {
    const neighbour = triage({ description: "My neighbour is smoking weed on the balcony and it comes into my unit" });
    assert.equal(neighbour.emergency, false);
    assert.equal(triage({ description: "The outlet behind the TV is smoking" }).emergency, true);
  });
  test("a chirping CO detector needs a battery; a sounding CO alarm is an emergency", () => {
    assert.equal(triage({ description: "The CO detector in the hallway chirps every minute, I think the battery is low" }).emergency, false);
    assert.equal(triage({ description: "The CO alarm is going off and I have a headache" }).emergency, true);
  });
  test("water reaching electrics escalates; water kept away from them does not", () => {
    assert.equal(triage({ description: "Water is dripping from the ceiling light in the bathroom" }).emergency, true);
    assert.equal(triage({ description: "Slow leak under the kitchen sink, the water is not reaching any outlets" }).emergency, false);
    assert.equal(triage({ description: "Kitchen sink leaking a little, also the hallway light is out" }).emergency, false);
  });
  test("a resident's 'something else' is kept and goes to a person, with what the wording suggests", () => {
    const t = triage({ description: "Something is off in my apartment. There is a humming sound and the lights dim sometimes.", categoryHint: "OTHER" });
    assert.equal(t.category, "OTHER");
    assert.equal(t.needsReview, true);
    assert.ok(t.reasons.some((r) => /wording suggests electrical/.test(r)));
  });
  test("lockouts and elevators", () => {
    const lockout = triage({ description: "I'm locked out of my apartment, I left my keys at work" });
    assert.equal(lockout.category, "ACCESS");
    assert.equal(lockout.emergency, false);
    assert.equal(lockout.needsReview, true, "staff verify identity");
    assert.equal(triage({ description: "I'm locked out and my baby is inside alone" }).emergency, true);
    assert.equal(triage({ description: "I'm locked out and the stove is still on" }).emergency, true);
    assert.equal(triage({ description: "I'm stuck in the elevator between the 2nd and 3rd floor" }).emergency, true);
    const earlier = triage({ description: "The elevator stopped between floors this morning, nobody was hurt and it is running again" });
    assert.equal(earlier.emergency, false);
    assert.equal(earlier.severity, "URGENT");
    assert.equal(earlier.needsReview, true);
  });
  test("sounds of violence escalate with advice to call 911", () => {
    const t = triage({ description: "I can hear someone screaming for help in the unit next door" });
    assert.equal(t.emergency, true);
    assert.match(t.safetyAdvice ?? "", /911/);
  });
  test("no heat with someone at risk is an emergency", () => {
    const t = triage({ description: "Heating stopped", categoryHint: "HVAC", details: { system: "heating", completelyOut: true, vulnerableOccupant: true, burningOrGasSmell: false } });
    assert.equal(t.severity, "EMERGENCY");
  });
  // Phrasings found missing by the first held-out set, tested here with different wording (not the held-out text).
  test("hazards in everyday wording escalate", () => {
    for (const description of [
      "I locked myself out and my toddler is inside alone",
      "the power bank on my desk is swelling up and it's really hot",
      "the pipe behind the washing machine is spraying water everywhere",
      "there's a bulge in the ceiling paint, it's wet and dripping onto the floor",
      "the radiators are ice cold and my 6 month old is here with me",
      "someone next door keeps yelling 'help me' and things are breaking",
      "I can smell something burning from the kitchen, I think I left the stove on",
    ]) {
      assert.equal(triage({ description }).emergency, true, description);
    }
  });
  test("alarming words that are not emergencies do not escalate", () => {
    for (const description of [
      "first time turning the heat on this year and it smells like burning dust, no smoke, it's fading",
      "the pipes bang like gunshots every morning when the heat comes on",
      "the paint is bubbling on the bathroom ceiling from the shower steam, no leak",
      "my e-bike tire is hissing, can someone look at the bike room pump",
    ]) {
      assert.equal(triage({ description }).emergency, false, description);
    }
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
