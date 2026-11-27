// Follow-ups and notifications over HTTP, with email captured by Mailpit (SMTP_CAPTURE=true, nothing is delivered to
// anyone). Behaviours A-G, recipients, property isolation, reminder timing and bounds, idempotency, retries across an
// SMTP outage, missing email configuration, no duplicate emails and no false delivery claims.
// Run: npm run test:api -- tests/api/followups.test.ts   (server with RELAY_TEST_HOOKS=true, SMTP to Mailpit)
import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { clearMailbox, hook, login, mailbox, mailText, rid, slot, type User, waitFor } from "./client";

let priya: User, daniel: User, noor: User, morgan: User, taylor: User, sam: User;
let priyaUnit: string, danielUnit: string, noorUnit: string;
const H = 3600_000;
const at = (ms: number) => new Date(Date.now() + ms).toISOString();
const deliver = () => hook("deliver", { now: true });
const sweep = (ms: number) => hook("sweep", { now: at(ms) });

before(async () => {
  [priya, daniel, noor, morgan, taylor, sam] = await Promise.all(["priya", "daniel", "noor", "morgan", "taylor", "sam"].map(login));
  priyaUnit = (await priya.must("getMe")).units[0].id;
  danielUnit = (await daniel.must("getMe")).units[0].id;
  noorUnit = (await noor.must("getMe")).units[0].id;
});

const leak = (u: User, unitId: string, extra: Record<string, unknown> = {}) =>
  u.must("reportIssue", {
    unitId,
    clientRequestId: rid(),
    description: "The kitchen sink is leaking under the cabinet. There is a small puddle in the cabinet.",
    categoryHint: "PLUMBING",
    details: { fixture: "kitchen_sink", activeLeak: true, spreading: false, waterNearElectrical: false, canShutOff: true },
    accessNotes: "Cat in the unit, keep the door closed.",
    ...extra,
  });
const followUps = async (caseId: string) => (await morgan.must("getCase", { caseId })).followUps as any[];
/** Offer to Northside, accept with a price under the threshold (approved by policy) and two visit windows. */
async function toScheduling(caseId: string, day = 2) {
  const vendors = await morgan.must("getEligibleVendors", { caseId });
  await morgan.must("assignVendor", { caseId, vendorId: vendors.find((v: any) => v.name === "Northside Plumbing").id });
  const offer = (await sam.must("getMyJobs")).offers.find((o: any) => o.id === caseId);
  // Each job gets its own days: the same vendor cannot be booked twice for one window.
  await sam.must("respondToOffer", { assignmentId: offer.assignmentId, accept: true, estimateType: "FIXED", estimateCents: 18000, slots: [slot(day, 9), slot(day + 1, 13)] });
  return offer.assignmentId as string;
}

describe("A and recipients: the report is acknowledged to the right people only", () => {
  let caseId = "";
  before(async () => {
    await hook("reset");
    await clearMailbox();
  });
  test("the resident gets an in-app and an email acknowledgement; the manager is told; nobody else", async () => {
    caseId = (await leak(priya, priyaUnit)).caseId;
    await deliver();
    const mail = await mailbox();
    const toPriya = mail.filter((m) => m.to.includes("priya.nair@relay-demo.test"));
    assert.equal(toPriya.length, 1);
    assert.match(toPriya[0].subject, /^Report received: RLY-\d{4}$/);
    assert.ok(mail.some((m) => m.to.includes("morgan.reyes@relay-demo.test") && /^New report:/.test(m.subject)));
    assert.ok(!mail.some((m) => m.to.some((t) => /daniel|taylor|noor/.test(t))), "no one outside this case");
    const inbox = await priya.must("getNotifications");
    assert.ok(inbox.items.some((n: any) => n.eventType === "case.received" && n.caseId === caseId));
    assert.ok(!(await taylor.must("getNotifications")).items.some((n: any) => n.caseId === caseId), "another property's manager hears nothing");
  });
  test("the email links to the case (sign-in required) and carries minimal private information", async () => {
    const m = (await mailbox()).find((x) => x.to.includes("priya.nair@relay-demo.test"))!;
    const text = await mailText(m.id);
    assert.ok(text.includes(`http://localhost:3000/my/cases/${caseId}`), "a plain app link to the case");
    assert.match(text, /asked to sign in/);
    assert.ok(!/Cat in the unit/.test(text), "access notes are not emailed");
    assert.ok(!/token|session|password/i.test(text), "no secrets in the link or body");
  });
  test("each delivery is recorded as what it really was", async () => {
    const rows = await followUps(caseId);
    const priyaEmail = rows.find((r) => r.recipient === "Priya Nair" && r.channel === "EMAIL" && r.eventType === "case.received");
    assert.equal(priyaEmail.status, "CAPTURED");
    assert.match(priyaEmail.statusNote, /not delivered to anyone/);
    assert.equal(rows.find((r) => r.recipient === "Priya Nair" && r.channel === "IN_APP" && r.eventType === "case.received").status, "DELIVERED");
    assert.ok(!rows.some((r) => r.channel === "EMAIL" && (r.status === "DELIVERED" || r.status === "ACCEPTED")), "a capture server never counts as delivery");
  });
  test("people who did not opt in, or have no address, are skipped with the reason", async () => {
    const d = (await leak(daniel, danielUnit)).caseId;
    const n = (await noor.must("reportIssue", { unitId: noorUnit, clientRequestId: rid(), description: "The radiator in the bedroom is cold.", categoryHint: "HVAC", details: { system: "heating", completelyOut: false, burningOrGasSmell: false, vulnerableOccupant: false } })).caseId;
    await deliver();
    assert.match((await followUps(d)).find((r) => r.recipient === "Daniel Osei" && r.channel === "EMAIL").statusNote, /not turned on email notifications/);
    assert.match((await taylor.must("getCase", { caseId: n })).followUps.find((r: any) => r.recipient === "Noor Haddad" && r.channel === "EMAIL").statusNote, /No email address/);
    assert.ok(!(await mailbox()).some((m) => m.to.includes("daniel.osei@relay-demo.test")));
  });
});

describe("B, C, D: actions with deadlines, reminders, and what happens when nobody answers", () => {
  let caseId = "";
  before(async () => {
    await hook("reset");
    await clearMailbox();
    caseId = (await leak(priya, priyaUnit)).caseId;
  });
  test("an offer names who must act, by when, and what happens otherwise; acting acknowledges it", async () => {
    const vendors = await morgan.must("getEligibleVendors", { caseId });
    await morgan.must("assignVendor", { caseId, vendorId: vendors.find((v: any) => v.name === "Northside Plumbing").id });
    const n = (await sam.must("getNotifications")).items.find((x: any) => x.caseId === caseId && x.eventType === "offer.received");
    assert.equal(n.ackRequired, true);
    assert.ok(n.ackDueAt, "a deadline");
    assert.match(n.body, /by .+ If there is no answer by then, the offer expires/);
    await sweep(13 * H);
    await sweep(14 * H);
    const reminders = (await sam.must("getNotifications")).items.filter((x: any) => x.caseId === caseId && x.eventType === "offer.reminder");
    assert.equal(reminders.length, 1, "one reminder at half time, not one per sweep");
    const offer = (await sam.must("getMyJobs")).offers.find((o: any) => o.id === caseId);
    await sam.must("respondToOffer", { assignmentId: offer.assignmentId, accept: true, estimateType: "FIXED", estimateCents: 18000, slots: [slot(2, 9), slot(3, 13)] });
    const after = (await sam.must("getNotifications")).items.find((x: any) => x.caseId === caseId && x.eventType === "offer.received");
    assert.equal(after.acknowledged, true, "responding acknowledged it");
  });
  test("C: the resident is asked to choose a time, reminded at most twice, then the manager is told once", async () => {
    const first = (await priya.must("getNotifications")).items.find((x: any) => x.caseId === caseId && x.eventType === "appointment.proposed");
    assert.match(first.body, /Choose one, or tell us none of them work, by .+ your property manager will follow up/);
    for (const hours of [25, 49, 73, 97, 200, 400]) await sweep(hours * H);
    const reminders = (await priya.must("getNotifications")).items.filter((x: any) => x.caseId === caseId && x.eventType === "appointment.reminder_to_choose");
    assert.equal(reminders.length, 2, "bounded by the property's maxReminders");
    const told = (await morgan.must("getNotifications")).items.filter((x: any) => x.caseId === caseId && x.eventType === "appointment.no_answer");
    assert.equal(told.length, 1, "the manager is told once, not on every sweep");
    assert.equal((await morgan.must("getCase", { caseId })).events.filter((e: any) => e.type === "SLOTS_UNANSWERED").length, 1);
  });
  test("declining every time tells the contractor to propose new ones", async () => {
    await priya.must("declineVisitTimes", { caseId, note: "I am away those days" });
    await deliver();
    assert.ok((await sam.must("getNotifications")).items.some((x: any) => x.caseId === caseId && x.eventType === "appointment.declined"));
    assert.ok((await mailbox()).some((m) => m.to.includes("sam@northside-plumbing.test") && /^Propose new times/.test(m.subject)));
  });
  test("D: a confirmed visit gets one reminder ahead of time, to the resident and the contractor", async () => {
    const start = new Date(slot(2, 9).startAt).getTime();
    await sam.must("proposeVisitTimes", { caseId, slots: [slot(2, 9)] });
    const open = (await priya.must("getCase", { caseId })).assignment.slots.find((s: any) => s.status === "PROPOSED");
    const chosen = await priya.must("chooseVisitTime", { slotId: open.id });
    assert.equal(chosen.confirmed, true);
    const lead = start - Date.now() - 23 * H;
    await sweep(lead);
    await sweep(lead + 30 * 60_000);
    await deliver();
    for (const u of [priya, sam]) {
      const r = (await u.must("getNotifications")).items.filter((x: any) => x.caseId === caseId && x.eventType === "appointment.reminder");
      assert.equal(r.length, 1);
    }
    assert.equal((await mailbox()).filter((m) => /^Upcoming visit:/.test(m.subject)).length, 2, "one email each, no duplicates");
  });
});

describe("E and F: completion asks the resident, unresolved reopens, silence is bounded", () => {
  before(async () => {
    await hook("reset");
    await clearMailbox();
  });
  let day = 2;
  async function completed() {
    const caseId = (await leak(priya, priyaUnit)).caseId;
    await toScheduling(caseId, day);
    day += 3;
    const open = (await priya.must("getCase", { caseId })).assignment.slots.find((s: any) => s.status === "PROPOSED");
    await priya.must("chooseVisitTime", { slotId: open.id });
    await sam.must("startWork", { caseId });
    await sam.must("completeWork", { caseId, notes: "Replaced the trap and the supply line.", finalCostCents: 18000 });
    return caseId;
  }
  test("E: the resident is asked whether it is fixed; no reopens it and the manager is told", async () => {
    const caseId = await completed();
    await deliver();
    const ask = (await priya.must("getNotifications")).items.find((x: any) => x.caseId === caseId && x.eventType === "repair.completed");
    assert.match(ask.body, /"Yes, resolved" or "No, still having problems"/);
    assert.ok((await mailbox()).some((m) => m.to.includes("priya.nair@relay-demo.test") && /^Is this fixed\?/.test(m.subject)));
    const r = await priya.must("confirmResolution", { caseId, resolved: false, note: "Still dripping under the sink" });
    assert.equal(r.status, "REOPENED");
    await deliver();
    assert.ok((await morgan.must("getNotifications")).items.some((x: any) => x.caseId === caseId && x.eventType === "case.not_fixed"));
    assert.ok((await mailbox()).some((m) => m.to.includes("morgan.reyes@relay-demo.test") && /^Not fixed:/.test(m.subject)));
  });
  test("F: verification reminders stop at the limit; the manager is told once; sweeping again changes nothing", async () => {
    const caseId = await completed();
    for (const hours of [25, 49, 73, 97, 150]) await sweep(hours * H);
    const reminders = (await priya.must("getNotifications")).items.filter((x: any) => x.caseId === caseId && x.eventType === "verification.reminder");
    assert.equal(reminders.length, 2);
    const overdue = (await morgan.must("getNotifications")).items.filter((x: any) => x.caseId === caseId && x.eventType === "verification.overdue");
    assert.equal(overdue.length, 1);
    const count = (await followUps(caseId)).length;
    await sweep(150 * H);
    await sweep(150 * H);
    assert.equal((await followUps(caseId)).length, count, "idempotent: the same sweep twice creates nothing");
    assert.equal((await priya.must("getCase", { caseId })).status, "AWAITING_VERIFICATION", "never resolved automatically");
  });
});

describe("email delivery: duplicates, outages, retries and missing configuration", () => {
  before(async () => {
    await hook("reset");
    await clearMailbox();
  });
  test("concurrent delivery passes send each email once", async () => {
    await leak(priya, priyaUnit);
    await Promise.all([deliver(), deliver(), deliver()]);
    const mail = await mailbox();
    const subjects = mail.filter((m) => m.to.includes("priya.nair@relay-demo.test")).map((m) => m.subject);
    assert.equal(subjects.length, new Set(subjects).size, "no duplicate emails");
  });
  test("an SMTP outage: retried with backoff, recorded as failed after three attempts, nothing lost", async () => {
    await hook("env", { set: { SMTP_PORT: "1026" } });
    const caseId = (await leak(priya, priyaUnit)).caseId;
    const email = async () => (await followUps(caseId)).find((r) => r.recipient === "Priya Nair" && r.channel === "EMAIL" && r.eventType === "case.received");
    await deliver();
    let e = await email();
    assert.equal(e.status, "PENDING");
    assert.equal(e.attempts, 1);
    assert.ok(e.lastError);
    await deliver();
    await deliver();
    e = await email();
    assert.equal(e.status, "FAILED");
    assert.equal(e.attempts, 3);
    assert.match(e.statusNote, /Not sent after 3 attempts/);
    // Mail queued during the outage is kept, and goes out once the server is back.
    const later = (await leak(priya, priyaUnit)).caseId;
    await deliver();
    await hook("env", { set: { SMTP_PORT: "1025" } });
    await deliver();
    await deliver();
    const sent = (await followUps(later)).find((r) => r.recipient === "Priya Nair" && r.channel === "EMAIL" && r.eventType === "case.received");
    assert.equal(sent.status, "CAPTURED");
    assert.ok(sent.attempts >= 2);
  });
  test("no email configuration: email rows are skipped with the reason and in-app still works", async () => {
    await hook("env", { set: { SMTP_HOST: "" } });
    await clearMailbox();
    const caseId = (await leak(priya, priyaUnit)).caseId;
    await deliver();
    const rows = await followUps(caseId);
    assert.ok(rows.filter((r) => r.channel === "EMAIL").every((r) => r.status === "SKIPPED" && /not configured/.test(r.statusNote)));
    assert.ok(rows.some((r) => r.recipient === "Priya Nair" && r.channel === "IN_APP" && r.status === "DELIVERED"));
    assert.equal((await mailbox()).length, 0);
    await hook("env", { set: { SMTP_HOST: "localhost" } });
  });
});

describe("G and emergencies: Relay says when it cannot proceed, and unacknowledged emergencies are raised once more", () => {
  before(async () => {
    await hook("reset");
  });
  test("an unacknowledged emergency alert is raised again once, then not again", async () => {
    const r = await priya.must("reportIssue", {
      unitId: priyaUnit,
      clientRequestId: rid(),
      description: "I smell gas in the kitchen near the stove.",
      categoryHint: "APPLIANCE",
      details: { appliance: "stove_oven", problem: "other", burningOrSparks: false, gasSmell: true },
    });
    const alert = (await morgan.must("getNotifications")).items.find((x: any) => x.caseId === r.caseId && x.kind === "EMERGENCY");
    assert.equal(alert.ackRequired, true);
    await sweep(20 * 60_000);
    await sweep(40 * 60_000);
    const again = (await morgan.must("getNotifications")).items.filter((x: any) => x.caseId === r.caseId && /Not yet acknowledged/.test(x.title));
    assert.equal(again.length, 1);
    await morgan.must("acknowledgeNotification", { id: alert.id });
    assert.equal((await morgan.must("getNotifications")).items.find((x: any) => x.id === alert.id).acknowledged, true);
  });
  test("when the AI cannot review a case, the manager is told what is needed, once per trigger", async () => {
    const ai = await morgan.must("getAiStatus");
    if (ai.available) return; // The model is up on this server: the coordinator reviews instead (covered by agent.test.ts).
    const caseId = (await leak(daniel, danielUnit)).caseId;
    // The notice comes from the coordinator job. pg-boss takes one job per queue every 2 s, and the jobs earlier tests
    // queued (most for cases a reset has since deleted) run first, so on a slow machine this can take a while.
    await waitFor(async () => (await morgan.must("getNotifications")).items.find((x: any) => x.caseId === caseId && x.eventType === "agent.blocked"), 90_000, "the agent-blocked notice");
    const notes = (await morgan.must("getNotifications")).items.filter((x: any) => x.caseId === caseId && x.eventType === "agent.blocked");
    assert.equal(notes.length, 1);
    assert.match(notes[0].body, /Next step for you: Assign an approved vendor/);
  });
});
