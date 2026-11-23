// Regression tests for the V1.1 security and robustness review (docs/security.md), over HTTP against the dev server
// (RELAY_TEST_HOOKS=true, FIBER_MODE=fixture). Each test names the finding it covers.
// Run: npx tsx --test --test-concurrency=1 tests/api/audit.test.ts
import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { BASE, hook, login, PASSWORD, rid, slot, type User, waitFor } from "./client";

let priya: User, morgan: User, taylor: User, sam: User, jo: User;
let priyaUnit: string;

before(async () => {
  await hook("reset");
  [priya, morgan, taylor, sam, jo] = await Promise.all(["priya", "morgan", "taylor", "sam", "jo"].map(login));
  priyaUnit = (await priya.must("getMe")).units[0].id;
});

const leak = (accessNotes?: string) =>
  priya.must("reportIssue", {
    unitId: priyaUnit,
    clientRequestId: rid(),
    description: "The bathroom sink drips under the cabinet into a bucket.",
    categoryHint: "PLUMBING",
    details: { fixture: "bathroom_sink", activeLeak: true, spreading: false, waterNearElectrical: false, canShutOff: true },
    permissionToEnter: true,
    accessNotes,
  });
const vendorId = async (name: string) => (await morgan.must("getSettings")).vendors.find((v: any) => v.name === name).id as string;
const rawLogin = (username: string, password: string) => fetch(`${BASE}/auth/username/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }) });

describe("H1: a vendor shared with another property cannot be changed from one of them", () => {
  test("a vendor also used at Birch House is read-only for Maple Court's manager", async () => {
    const settings = await morgan.must("getSettings");
    const north = settings.vendors.find((v: any) => v.name === "Northside Plumbing");
    const harbour = settings.vendors.find((v: any) => v.name === "Harbour Plumbing & Drain");
    assert.equal(north.sharedElsewhere, true, "Northside is in both directories");
    assert.equal(harbour.sharedElsewhere, false, "Harbour is only at Maple Court");
    const edit = await morgan.op("saveVendor", { id: north.id, name: north.name, trades: ["PLUMBING", "ELECTRICAL"], phone: "519-555-0000" });
    assert.equal(edit.status, 403);
    assert.equal(edit.code, "vendor_shared");
    const after = (await taylor.must("getSettings")).vendors.find((v: any) => v.name === "Northside Plumbing");
    assert.deepEqual(after.trades, north.trades, "Birch House sees no change");
    assert.equal(after.phone, north.phone);
    // Approval stays per property: Maple's manager can still remove and restore it at Maple only.
    const maple = north.approvedAt[0].propertyId;
    await morgan.must("setVendorApproved", { vendorId: north.id, approved: false, propertyId: maple });
    assert.equal((await taylor.must("getSettings")).vendors.find((v: any) => v.name === "Northside Plumbing").approvedAt[0].approved, true);
    await morgan.must("setVendorApproved", { vendorId: north.id, approved: true, propertyId: maple });
  });
  test("a vendor used only at the manager's own properties can still be edited", async () => {
    const harbour = (await morgan.must("getSettings")).vendors.find((v: any) => v.name === "Harbour Plumbing & Drain");
    const r = await morgan.must("saveVendor", { id: harbour.id, name: harbour.name, trades: harbour.trades, phone: harbour.phone ?? "", email: harbour.email ?? "", notes: "Prefers texts" });
    assert.equal(r.ok, true);
  });
});

describe("M2: resuming an escalation ends the emergency", () => {
  test("after a manager resumes it, the case is no longer an emergency and can be routed normally", async () => {
    const r = await priya.must("reportIssue", {
      unitId: priyaUnit,
      clientRequestId: rid(),
      description: "Water is coming through the ceiling light in the bathroom.",
      categoryHint: "PLUMBING",
      details: { fixture: "other", activeLeak: true, spreading: true, waterNearElectrical: true, canShutOff: false },
    });
    assert.equal(r.status, "ESCALATED");
    assert.equal((await morgan.must("getCase", { caseId: r.caseId })).emergency, true);
    await morgan.must("resumeCase", { caseId: r.caseId, note: "Power to the bathroom is off at the breaker; ceiling dried.", severity: "URGENT" });
    const c = await morgan.must("getCase", { caseId: r.caseId });
    assert.equal(c.status, "AWAITING_ASSIGNMENT");
    assert.equal(c.emergency, false);
    assert.equal(c.severity, "URGENT");
    assert.equal(c.can.assignVendor, true);
  });
});

describe("M5: what a contractor sees", () => {
  let caseId = "";
  test("entry instructions are shown only after the vendor accepts the job", async () => {
    caseId = (await leak("Spare key with the front desk; dog in the bedroom.")).caseId;
    await morgan.must("assignVendor", { caseId, vendorId: await vendorId("Northside Plumbing") });
    const offered = await sam.must("getCase", { caseId });
    assert.equal(offered.accessNotes, null, "not on an offer");
    const offer = (await sam.must("getMyJobs")).offers.find((o: any) => o.id === caseId);
    await sam.must("respondToOffer", { assignmentId: offer.assignmentId, accept: true, estimateType: "FIXED", estimateCents: 9000, slots: [slot(3, 9)] });
    assert.match((await sam.must("getCase", { caseId })).accessNotes, /Spare key/);
  });
  test("a vendor whose job is done does not see the next vendor's work on the reopened case", async () => {
    const s = await priya.must("getCase", { caseId });
    await priya.must("chooseVisitTime", { slotId: s.assignment.slots[0].id });
    await sam.must("startWork", { caseId });
    await sam.must("completeWork", { caseId, notes: "Tightened the trap.", finalCostCents: 9000 });
    await priya.must("confirmResolution", { caseId, resolved: false, note: "Still dripping into the bucket." });
    const reopened = await morgan.must("getCase", { caseId });
    assert.ok(["REOPENED", "AWAITING_ASSIGNMENT"].includes(reopened.status), reopened.status);
    await morgan.must("assignVendor", { caseId, vendorId: await vendorId("Harbour Plumbing & Drain") });
    const offer = (await jo.must("getMyJobs")).offers.find((o: any) => o.id === caseId);
    await jo.must("respondToOffer", { assignmentId: offer.assignmentId, accept: true, estimateType: "FIXED", estimateCents: 9500, slots: [slot(5, 11)] });
    const again = await priya.must("getCase", { caseId });
    await priya.must("chooseVisitTime", { slotId: again.assignment.slots[0].id });
    assert.equal((await morgan.must("getCase", { caseId })).status, "SCHEDULED");
    const formerView = await sam.must("getCase", { caseId });
    const mentions = formerView.events.filter((e: any) => /Harbour/.test(e.message));
    assert.deepEqual(mentions, [], "the first vendor sees nothing about the second vendor's visit");
    const managerView = await morgan.must("getCase", { caseId });
    assert.ok(managerView.events.some((e: any) => /Harbour/.test(e.message)), "the manager sees all of it");
  });
});

describe("M6: limits on paid and abusable paths", () => {
  test("a resident who sends too many reports in an hour is asked to wait", async () => {
    await hook("env", { set: { LIMIT_REPORTS_PER_HOUR: "2" } });
    await hook("reset"); // windows start afresh; reset also restores the setting afterwards
    await hook("env", { set: { LIMIT_REPORTS_PER_HOUR: "2" } });
    await leak();
    await leak();
    const third = await priya.op("reportIssue", { unitId: priyaUnit, clientRequestId: rid(), description: "A third report in a row, too many.", categoryHint: "OTHER", details: {} });
    assert.equal(third.status, 429);
    assert.equal(third.code, "rate_limited");
    await hook("reset");
  });
  test("repeated failed sign-ins lock the username for a while, even with the right password", async () => {
    await hook("env", { set: { LIMIT_LOGIN_FAILURES_PER_USERNAME: "3" } });
    for (let i = 0; i < 3; i++) assert.equal((await rawLogin("daniel", "wrong-password")).status >= 400, true);
    const blocked = await rawLogin("daniel", PASSWORD);
    assert.equal(blocked.status, 429);
    assert.equal((await rawLogin("priya", PASSWORD)).status, 200, "other usernames are not affected");
    await hook("reset");
    assert.equal((await rawLogin("daniel", PASSWORD)).status, 200);
  });
});

describe("M7: an intake turn that fails is retried and the resident gets a reply", () => {
  test("a failure that is not the model's is retried by the job, and the retry answers", async () => {
    await hook("reset");
    const conv = await priya.must("getIntakeConversation", { unitId: priyaUnit, fresh: true });
    await hook("fault", { point: "intake.turn", times: 1 });
    const sent = await priya.must("sendIntakeMessage", { conversationId: conv.id, text: "My kitchen faucet keeps dripping." });
    assert.equal(sent.pending, true);
    const answered = await waitFor(
      async () => {
        const c = await priya.must("getIntakeConversation", { unitId: priyaUnit, conversationId: conv.id });
        return !c.pending && c.messages.at(-1)?.role === "relay" ? c : null;
      },
      90_000,
      "a reply after the retry",
    );
    assert.equal(answered.messages.filter((m: any) => m.role === "relay").length, 2, "the greeting and one reply, not two");
  });
});
