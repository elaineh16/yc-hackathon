// Reliability and safety over HTTP: authorization, invalid transitions, races, deadlines, faults.
// Run: npm run test:api   (dev server running with RELAY_TEST_HOOKS=true; this resets all cases)
import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { hook, login, rid, slot, type User, user } from "./client";

let priya: User, daniel: User, noor: User, morgan: User, taylor: User, sam: User, jo: User, ana: User;
let priyaUnit = "", danielUnit = "";
let northside = "", harbour = "";

const plumbingReport = (u: User, unitId: string, extra: Record<string, unknown> = {}) =>
  u.op("reportIssue", {
    unitId,
    clientRequestId: rid(),
    description: "The bathroom sink drain is slow and dripping under the basin.",
    categoryHint: "PLUMBING",
    details: { fixture: "bathroom_sink", activeLeak: false, spreading: false, waterNearElectrical: false },
    ...extra,
  });

/** A plumbing case that is offered to a vendor. */
async function offered(vendorId: string, who = priya, unitId = priyaUnit) {
  const r = await plumbingReport(who, unitId);
  assert.equal(r.status, 200, r.message);
  await morgan.must("assignVendor", { caseId: r.data.caseId, vendorId });
  return r.data.caseId as string;
}
const offerOf = async (u: User, caseId: string) => (await u.must("getMyJobs")).offers.find((o: any) => o.id === caseId);

before(async () => {
  await hook("reset");
  [priya, daniel, noor, morgan, taylor, sam, jo, ana] = await Promise.all(["priya", "daniel", "noor", "morgan", "taylor", "sam", "jo", "ana"].map(login));
  priyaUnit = (await priya.must("getMe")).units[0].id;
  danielUnit = (await daniel.must("getMe")).units[0].id;
  const vendors = (await morgan.must("getSettings")).vendors;
  northside = vendors.find((v: any) => v.name === "Northside Plumbing").id;
  harbour = vendors.find((v: any) => v.name === "Harbour Plumbing & Drain").id;
});

describe("authorization", () => {
  test("no session: every operation is refused", async () => {
    const anon = user(null);
    for (const [op, args] of [["getMyCases", undefined], ["searchCases", {}], ["getMyJobs", undefined], ["reportIssue", {}]] as const) {
      assert.equal((await anon.op(op, args)).status, 401, op);
    }
  });
  test("roles: residents cannot manage, contractors cannot report, managers cannot act as vendors", async () => {
    const caseId = await offered(northside);
    assert.equal((await priya.op("assignVendor", { caseId, vendorId: harbour })).status, 403);
    assert.equal((await priya.op("decideSpend", { caseId, approve: true, capCents: 100 })).status, 403);
    assert.equal((await sam.op("reportIssue", { unitId: priyaUnit, clientRequestId: rid(), description: "Trying to report as a contractor" })).status, 403);
    assert.equal((await morgan.op("respondToOffer", { assignmentId: (await offerOf(sam, caseId)).assignmentId, accept: false, declineReason: "no" })).status, 403);
    assert.equal((await priya.op("searchCases", {})).status, 403);
  });
  test("a resident cannot read or act on another resident's case", async () => {
    const r = await plumbingReport(priya, priyaUnit);
    for (const op of ["getCase", "cancelCase", "confirmResolution", "reopenCase"]) {
      const res = await daniel.op(op, { caseId: r.data.caseId, resolved: true, reason: "not mine" });
      assert.equal(res.status, 404, op);
    }
    assert.equal((await daniel.op("reportIssue", { unitId: priyaUnit, clientRequestId: rid(), description: "Reporting for a unit I do not live in" })).status, 403);
  });
  test("a contractor cannot see or answer another contractor's job", async () => {
    const caseId = await offered(northside);
    const assignmentId = (await offerOf(sam, caseId)).assignmentId;
    assert.equal((await jo.op("getCase", { caseId })).status, 404);
    assert.equal((await jo.op("respondToOffer", { assignmentId, accept: true, estimateType: "FIXED", estimateCents: 100, slots: [slot(2, 9)] })).status, 404);
    assert.equal((await ana.op("startWork", { caseId })).status, 404);
  });
  test("a manager cannot see another property's cases", async () => {
    const r = await plumbingReport(priya, priyaUnit);
    assert.equal((await taylor.op("getCase", { caseId: r.data.caseId })).status, 404);
    assert.ok(!(await taylor.must("searchCases", {})).items.some((c: any) => c.id === r.data.caseId));
  });
  test("self sign-up is blocked", async () => {
    const res = await fetch(`${process.env.RELAY_API_URL ?? "http://localhost:3001"}/auth/username/signup`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: `intruder${Date.now()}`, password: "password123" }) });
    assert.ok(res.status >= 400, `signup returned ${res.status}`);
  });
});

describe("workflow rules", () => {
  test("missing manager approval: work cannot be scheduled or started", async () => {
    const caseId = await offered(northside);
    const assignmentId = (await offerOf(sam, caseId)).assignmentId;
    await sam.must("respondToOffer", { assignmentId, accept: true, estimateType: "INSPECTION_REQUIRED", estimateCents: 9000, slots: [slot(3, 9)] });
    const c = await priya.must("getCase", { caseId });
    assert.equal(c.status, "AWAITING_APPROVAL", "an inspection-first response always needs a manager");
    const chosen = await priya.must("chooseVisitTime", { slotId: c.assignment.slots[0].id });
    assert.equal(chosen.confirmed, false);
    assert.equal((await sam.op("startWork", { caseId })).status, 409);
    assert.equal((await morgan.op("decideSpend", { caseId, approve: true })).status, 400, "inspection-first needs an explicit cap");
  });
  test("contractor decline returns the case to the manager, and the vendor loses access", async () => {
    const caseId = await offered(northside);
    const assignmentId = (await offerOf(sam, caseId)).assignmentId;
    assert.equal((await sam.op("respondToOffer", { assignmentId, accept: false, declineReason: "" })).status, 400, "a reason is required");
    const r = await sam.must("respondToOffer", { assignmentId, accept: false, declineReason: "Fully booked this week" });
    assert.equal(r.status, "AWAITING_ASSIGNMENT");
    assert.equal((await sam.op("getCase", { caseId })).status, 404);
    const m = await morgan.must("getCase", { caseId });
    assert.equal(m.holder, "MANAGER");
    assert.ok(m.previousAssignments.some((a: any) => a.status === "DECLINED" && a.declineReason === "Fully booked this week"));
    const vendors = await morgan.must("getEligibleVendors", { caseId });
    assert.equal(vendors.find((v: any) => v.id === northside).previouslyOnCase, true);
  });
  test("missing contractor response: the offer expires through the durable sweep, not a timer", async () => {
    const caseId = await offered(northside);
    const later = new Date(Date.now() + 2 * 24 * 3600_000).toISOString();
    const swept = await hook("sweep", { now: later });
    assert.ok(swept.result.offersExpired >= 1);
    const m = await morgan.must("getCase", { caseId });
    assert.equal(m.status, "AWAITING_ASSIGNMENT");
    assert.ok(m.events.some((e: any) => e.type === "OFFER_EXPIRED"));
    assert.equal((await offerOf(sam, caseId)), undefined);
    const again = await hook("sweep", { now: later });
    assert.equal(again.result.offersExpired, 0, "the sweep is idempotent");
  });
  test("invalid transitions are refused with 409", async () => {
    const caseId = await offered(northside);
    assert.equal((await priya.op("confirmResolution", { caseId, resolved: true })).status, 409);
    assert.equal((await morgan.op("closeUnverified", { caseId })).status, 409);
    assert.equal((await morgan.op("resumeCase", { caseId, note: "nothing to resume" })).status, 409);
    assert.equal((await sam.op("completeWork", { caseId, notes: "skipping ahead" })).status, 409);
  });
  test("appointment conflict: a vendor cannot be booked twice for the same time", async () => {
    const when = slot(5, 10);
    const a = await offered(northside);
    const b = await offered(northside, daniel, danielUnit);
    for (const caseId of [a, b]) {
      const assignmentId = (await offerOf(sam, caseId)).assignmentId;
      await sam.must("respondToOffer", { assignmentId, accept: true, estimateType: "FIXED", estimateCents: 15000, slots: [when] });
    }
    const ca = await priya.must("getCase", { caseId: a });
    assert.equal((await priya.must("chooseVisitTime", { slotId: ca.assignment.slots[0].id })).status, "SCHEDULED");
    const cb = await daniel.must("getCase", { caseId: b });
    const clash = await daniel.op("chooseVisitTime", { slotId: cb.assignment.slots[0].id });
    assert.equal(clash.status, 409);
    assert.equal(clash.code, "slot_conflict");
    const after = await daniel.must("getCase", { caseId: b });
    assert.equal(after.status, "SCHEDULING");
    assert.equal(after.assignment.slots[0].status, "UNAVAILABLE");
    assert.equal(after.holder, "CONTRACTOR", "the contractor is asked for new times");
  });
  test("cancellation after an offer withdraws it from the vendor", async () => {
    const caseId = await offered(northside);
    const r = await priya.must("cancelCase", { caseId, reason: "Fixed it myself" });
    assert.equal(r.status, "CANCELLED");
    assert.equal(await offerOf(sam, caseId), undefined);
    assert.equal((await sam.op("getCase", { caseId })).status, 404);
    assert.equal((await priya.must("cancelCase", { caseId })).repeated, true, "a repeated cancel is harmless");
  });
  test("repeated and concurrent requests do not double up", async () => {
    const caseId = await offered(northside);
    const assignmentId = (await offerOf(sam, caseId)).assignmentId;
    const responses = await Promise.all([1, 2, 3].map(() => sam.op("respondToOffer", { assignmentId, accept: true, estimateType: "FIXED", estimateCents: 12000, slots: [slot(6, 13)] })));
    assert.ok(responses.every((r) => r.status === 200), responses.map((r) => r.status).join(","));
    assert.equal(responses.filter((r) => r.data.repeated === false).length, 1, "exactly one response took effect");
    const c = await priya.must("getCase", { caseId });
    assert.equal(c.assignment.slots.length, 1, "no duplicated visit windows");
    const req = rid();
    const twice = await Promise.all([1, 2].map(() => plumbingReport(priya, priyaUnit, { clientRequestId: req })));
    assert.equal(twice[0].data.caseId, twice[1].data.caseId, "concurrent identical submissions create one case");
  });
  test("completion without the resident's verification does not resolve the case", async () => {
    const caseId = await offered(northside);
    const assignmentId = (await offerOf(sam, caseId)).assignmentId;
    await sam.must("respondToOffer", { assignmentId, accept: true, estimateType: "FIXED", estimateCents: 9000, slots: [slot(7, 9)] });
    const c = await priya.must("getCase", { caseId });
    await priya.must("chooseVisitTime", { slotId: c.assignment.slots[0].id });
    await sam.must("startWork", { caseId });
    await sam.must("completeWork", { caseId, notes: "Cleared the drain and replaced the washer." });
    assert.equal((await morgan.must("getCase", { caseId })).status, "AWAITING_VERIFICATION");
    assert.equal((await morgan.op("closeUnverified", { caseId })).code, "verification_window_open");
    const late = new Date(Date.now() + 4 * 24 * 3600_000).toISOString();
    const swept = await hook("sweep", { now: late });
    assert.ok(swept.result.verificationReminders >= 1, "the resident was reminded");
    assert.equal((await morgan.must("getCase", { caseId })).status, "AWAITING_VERIFICATION", "reminders never resolve the case");
    const notFixed = await priya.must("confirmResolution", { caseId, resolved: false, note: "Still dripping at night" });
    assert.equal(notFixed.status, "REOPENED");
  });
});

describe("safety and failure", () => {
  test("emergency escalation: a gas smell is escalated and routine dispatch is blocked", async () => {
    const r = await noor.must("reportIssue", {
      unitId: (await noor.must("getMe")).units[0].id,
      clientRequestId: rid(),
      description: "The radiator is cold and I can smell gas near the boiler room door.",
      categoryHint: "HVAC",
      details: { system: "heating", completelyOut: true, burningOrGasSmell: true, vulnerableOccupant: false },
    });
    assert.equal(r.status, "ESCALATED");
    assert.equal(r.severity, "EMERGENCY");
    assert.match(r.message, /911/);
    const vendors = await taylor.must("getEligibleVendors", { caseId: r.caseId });
    const offer = await taylor.op("assignVendor", { caseId: r.caseId, vendorId: vendors[0].id });
    assert.equal(offer.status, 409, "no routine dispatch while escalated");
    assert.equal((await taylor.must("getCase", { caseId: r.caseId })).holder, "MANAGER");
  });
  test("an unsupported category is saved and routed to a person", async () => {
    const r = await priya.must("reportIssue", { unitId: priyaUnit, clientRequestId: rid(), description: "The hallway smoke detector chirps every minute.", categoryHint: "OTHER", details: {} });
    assert.equal(r.status, "TRIAGED");
    assert.equal(r.needsReview, true);
    assert.equal(r.managersNotified, 1);
  });
  test("a failed database write saves nothing and a retry succeeds", async () => {
    const req = rid();
    await hook("fault", { point: "intake.afterCreate" });
    const failed = await plumbingReport(priya, priyaUnit, { clientRequestId: req, title: "Fault injection probe" });
    assert.equal(failed.status, 500);
    const none = (await priya.must("getMyCases")).filter((c: any) => c.title === "Fault injection probe");
    assert.equal(none.length, 0, "the transaction rolled back: no half-saved case");
    const retried = await plumbingReport(priya, priyaUnit, { clientRequestId: req, title: "Fault injection probe" });
    assert.equal(retried.status, 200);
    assert.equal(retried.data.duplicate, false);
  });
  test("voice intake is refused cleanly when the voice service rejects the credentials", async () => {
    const r = await priya.op("startVoiceIntake");
    // With a valid key this returns a token; any failure must be a clear error, never a fake session.
    if (r.status === 200) assert.ok(r.data.conversationToken, "a real token was issued");
    else assert.ok([502, 503].includes(r.status) && /form/i.test(r.message ?? ""), `${r.status} ${r.message}`);
  });
});
