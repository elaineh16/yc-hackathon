// Acceptance scenarios over HTTP: the same persisted case moves through all three roles to RESOLVED.
// Run: npm run test:api   (dev server running with RELAY_TEST_HOOKS=true; this resets all cases)
import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { hook, login, rid, slot, type User } from "./client";

let priya: User, daniel: User, morgan: User, taylor: User, sam: User, jo: User, ana: User;
let priyaUnit: string, danielUnit: string;
const vendorIds: Record<string, string> = {};

before(async () => {
  await hook("reset");
  [priya, daniel, morgan, taylor, sam, jo, ana] = await Promise.all(["priya", "daniel", "morgan", "taylor", "sam", "jo", "ana"].map(login));
  priyaUnit = (await priya.must("getMe")).units[0].id;
  danielUnit = (await daniel.must("getMe")).units[0].id;
});

describe("Scenario 1: leaking kitchen sink, resident to resolution", () => {
  let caseId = "";
  const req = rid();
  const report = () =>
    priya.op("reportIssue", {
      unitId: priyaUnit,
      clientRequestId: req,
      description: "The kitchen sink is leaking under the cabinet. There is a small puddle in the cabinet.",
      categoryHint: "PLUMBING",
      details: { fixture: "kitchen_sink", activeLeak: true, spreading: false, waterNearElectrical: false, canShutOff: true },
      permissionToEnter: true,
      accessNotes: "Cat in the unit, keep the door closed.",
    });

  test("1-2. the resident reports it and it persists, routed to the manager", async () => {
    const r = await report();
    assert.equal(r.status, 200, r.message);
    caseId = r.data.caseId;
    assert.equal(r.data.status, "AWAITING_ASSIGNMENT");
    assert.equal(r.data.category, "PLUMBING");
    assert.equal(r.data.severity, "URGENT"); // water leaking now
    assert.equal(r.data.duplicate, false);
    assert.equal(r.data.managersNotified, 1);
    assert.match(r.data.message, /saved as RLY-\d{4}/);
  });

  test("a retried submission returns the same case and creates nothing", async () => {
    const r = await report();
    assert.equal(r.data.caseId, caseId);
    assert.equal(r.data.duplicate, true);
    const mine = await priya.must("getMyCases");
    assert.equal(mine.filter((c: any) => c.id === caseId).length, 1);
  });

  test("3. the manager sees the actual case; other people do not", async () => {
    const page = await morgan.must("searchCases", { q: "kitchen sink" });
    assert.ok(page.items.some((c: any) => c.id === caseId));
    const detail = await morgan.must("getCase", { caseId });
    assert.equal(detail.holder, "MANAGER");
    assert.equal(detail.can.assignVendor, true);
    assert.equal((await taylor.op("getCase", { caseId })).status, 404, "a manager of another property");
    assert.equal((await daniel.op("getCase", { caseId })).status, 404, "another resident");
    assert.equal((await sam.op("getCase", { caseId })).status, 404, "a contractor before any offer");
  });

  test("4. the manager assigns an approved plumber (only plumbers are eligible)", async () => {
    const vendors = await morgan.must("getEligibleVendors", { caseId });
    for (const v of vendors) vendorIds[v.name] = v.id;
    assert.deepEqual(vendors.map((v: any) => v.name).sort(), ["Harbour Plumbing & Drain", "Northside Plumbing"]);
    const wrongTrade = await morgan.op("assignVendor", { caseId, vendorId: (await morgan.must("getSettings")).vendors.find((v: any) => v.name.startsWith("BrightSpark")).id });
    assert.equal(wrongTrade.status, 400);
    assert.equal(wrongTrade.code, "vendor_wrong_trade");
    const r = await morgan.must("assignVendor", { caseId, vendorId: vendorIds["Northside Plumbing"], note: "Please call before arriving." });
    assert.equal(r.status, "AWAITING_VENDOR");
    assert.equal(r.vendorHasLogin, true);
    const again = await morgan.must("assignVendor", { caseId, vendorId: vendorIds["Northside Plumbing"] });
    assert.equal(again.repeated, true);
    assert.equal((await morgan.op("assignVendor", { caseId, vendorId: vendorIds["Harbour Plumbing & Drain"] })).status, 409);
  });

  test("5. the contractor signs in and receives the assignment; another contractor does not", async () => {
    const board = await sam.must("getMyJobs");
    assert.equal(board.offers.length, 1);
    assert.equal(board.offers[0].id, caseId);
    assert.equal((await jo.must("getMyJobs")).offers.length, 0);
    assert.equal((await jo.op("getCase", { caseId })).status, 404);
    const seen = await sam.must("getCase", { caseId });
    assert.equal(seen.can.respondToOffer, true);
    assert.equal(seen.residentName, "Priya", "contractors see the resident's first name only");
  });

  let slots: any[] = [];
  test("6. the contractor gives an estimate and availability", async () => {
    const offer = (await sam.must("getMyJobs")).offers[0];
    const r = await sam.must("respondToOffer", { assignmentId: offer.assignmentId, accept: true, estimateType: "FIXED", estimateCents: 32000, estimateNotes: "Replace trap and supply line", slots: [slot(2, 9), slot(3, 13)] });
    assert.equal(r.status, "AWAITING_APPROVAL", "$320 is over the $250 threshold");
    const again = await sam.must("respondToOffer", { assignmentId: offer.assignmentId, accept: true, estimateType: "FIXED", estimateCents: 32000, slots: [slot(2, 9)] });
    assert.equal(again.repeated, true);
    const resident = await priya.must("getCase", { caseId });
    slots = resident.assignment.slots;
    assert.equal(slots.length, 2);
    assert.equal(resident.assignment.estimateCents, null, "residents do not see the price");
    assert.ok(resident.events.every((e: any) => e.audience === "EVERYONE"), "residents never get management-only events");
  });

  test("the resident's choice waits for the approval; work cannot start yet", async () => {
    const r = await priya.must("chooseVisitTime", { slotId: slots[0].id });
    assert.equal(r.confirmed, false);
    assert.equal(r.status, "AWAITING_APPROVAL");
    assert.equal((await sam.op("startWork", { caseId })).status, 409);
    assert.equal((await sam.op("completeWork", { caseId, notes: "done already" })).status, 409);
  });

  test("7-8. the manager approves; the visit is confirmed because everyone required has agreed", async () => {
    const low = await morgan.op("decideSpend", { caseId, approve: true, capCents: 20000 });
    assert.equal(low.status, 400, "a cap below the estimate is refused");
    const r = await morgan.must("decideSpend", { caseId, approve: true, capCents: 35000, note: "OK up to $350" });
    assert.equal(r.status, "SCHEDULED");
    assert.equal((await morgan.must("decideSpend", { caseId, approve: true, capCents: 35000 })).repeated, true);
  });

  test("9. the resident sees the appointment and the updated timeline", async () => {
    const c = await priya.must("getCase", { caseId });
    assert.equal(c.status, "SCHEDULED");
    assert.equal(c.appointment.id, slots[0].id);
    assert.ok(c.events.some((e: any) => e.type === "CONFIRM_APPOINTMENT"));
    const inbox = await priya.must("getNotifications");
    assert.ok(inbox.items.some((n: any) => /Visit confirmed/.test(n.title)));
  });

  test("10. the contractor does the work and reports it complete", async () => {
    assert.equal((await sam.must("startWork", { caseId })).status, "IN_PROGRESS");
    await sam.must("addProgressNote", { caseId, note: "Trap replaced, testing for leaks." });
    const r = await sam.must("completeWork", { caseId, notes: "Replaced the P-trap and the supply line. No leaks after 20 minutes.", finalCostCents: 31000 });
    assert.equal(r.status, "AWAITING_VERIFICATION");
  });

  test("completion is not resolution: only the resident can confirm, and the manager must wait", async () => {
    assert.equal((await sam.op("confirmResolution", { caseId, resolved: true })).status, 403);
    const early = await morgan.op("closeUnverified", { caseId });
    assert.equal(early.status, 409);
    assert.equal(early.code, "verification_window_open");
  });

  test("11-12. the resident verifies; the case is RESOLVED with its full history", async () => {
    const r = await priya.must("confirmResolution", { caseId, resolved: true, note: "Dry all day, thanks." });
    assert.equal(r.status, "RESOLVED");
    const c = await morgan.must("getCase", { caseId });
    assert.equal(c.resolution, "VERIFIED_BY_RESIDENT");
    const types = c.events.map((e: any) => e.type);
    for (const t of ["REPORTED", "TRIAGE", "ROUTE", "ASSIGN_VENDOR", "VENDOR_ACCEPT", "APPROVAL_REQUESTED", "SLOT_CHOSEN", "APPROVE_SPEND", "CONFIRM_APPOINTMENT", "START_WORK", "PROGRESS_NOTE", "COMPLETE_WORK", "VERIFY_RESOLVED"]) {
      assert.ok(types.includes(t), `history has ${t}`);
    }
    assert.ok(c.events.every((e: any, i: number, a: any[]) => i === 0 || e.id > a[i - 1].id), "history is in order");
  });
});

describe("Scenario 2: the same engine handles an appliance case (approved by policy)", () => {
  let caseId = "";
  test("a washer that will not drain goes from report to resolution", async () => {
    const r = await daniel.must("reportIssue", {
      unitId: danielUnit,
      clientRequestId: rid(),
      description: "The washer in my unit will not drain. Water is standing in the drum.",
      categoryHint: "APPLIANCE",
      details: { appliance: "washer", problem: "wont_drain", errorCode: "OE", burningOrSparks: false, gasSmell: false },
    });
    caseId = r.caseId;
    assert.equal(r.category, "APPLIANCE");
    assert.equal(r.status, "AWAITING_ASSIGNMENT");
    const vendors = await morgan.must("getEligibleVendors", { caseId });
    assert.deepEqual(vendors.map((v: any) => v.name), ["BrightSpark Appliance Repair"]);
    await morgan.must("assignVendor", { caseId, vendorId: vendors[0].id });
    const offer = (await ana.must("getMyJobs")).offers[0];
    const accepted = await ana.must("respondToOffer", { assignmentId: offer.assignmentId, accept: true, estimateType: "FIXED", estimateCents: 18000, slots: [slot(4, 10)] });
    assert.equal(accepted.status, "SCHEDULING", "$180 is within the threshold: approved by policy");
    const c = await daniel.must("getCase", { caseId });
    const chosen = await daniel.must("chooseVisitTime", { slotId: c.assignment.slots[0].id });
    assert.equal(chosen.confirmed, true);
    assert.equal(chosen.status, "SCHEDULED");
    await ana.must("startWork", { caseId });
    await ana.must("completeWork", { caseId, notes: "Cleared the drain pump filter; drained and ran a full cycle." });
    assert.equal((await daniel.must("confirmResolution", { caseId, resolved: true })).status, "RESOLVED");
    const history = await morgan.must("getCase", { caseId });
    assert.ok(history.events.some((e: any) => e.type === "APPROVED_BY_POLICY"));
  });
});
