// Vendor discovery (Fiber AI) over HTTP, against the dev server in fixture mode (FIBER_MODE=fixture): the real SDK
// call path runs against Fiber-shaped fixture responses of FICTIONAL businesses, so no credits are used. Covers:
// vendor exists, no vendor, valid results, no results, API down, credits exhausted, duplicates, wrong category,
// wrong area, missing contacts, an unverified candidate cannot be dispatched, reject and approve, concurrent requests,
// caching, a missing key, and an interrupted run that resumes or fails clearly.
// Run: npm run test:api -- tests/api/discovery.test.ts   (server with RELAY_TEST_HOOKS=true and FIBER_MODE=fixture)
import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { hook, login, rid, type User, waitFor } from "./client";

let priya: User, daniel: User, noor: User, morgan: User, taylor: User;
let priyaUnit: string, danielUnit: string, noorUnit: string;

before(async () => {
  await hook("reset");
  [priya, daniel, noor, morgan, taylor] = await Promise.all(["priya", "daniel", "noor", "morgan", "taylor"].map(login));
  priyaUnit = (await priya.must("getMe")).units[0].id;
  danielUnit = (await daniel.must("getMe")).units[0].id;
  noorUnit = (await noor.must("getMe")).units[0].id;
});

const DONE = ["SUCCEEDED", "FAILED", "SKIPPED", "CANCELLED"];
const report = (u: User, unitId: string, categoryHint: string, description: string, details: Record<string, unknown>) => u.must("reportIssue", { unitId, clientRequestId: rid(), description, categoryHint, details });
const hvac = (u: User, unitId: string) => report(u, unitId, "HVAC", "The air conditioner in the living room is not cooling at all.", { system: "cooling", completelyOut: true, burningOrGasSmell: false, vulnerableOccupant: false });
const electrical = (u: User, unitId: string) => report(u, unitId, "ELECTRICAL", "Half the outlets in my living room stopped working.", { what: "outlets", burningOrSparks: false, waterNearby: false });
const brokenLock = (u: User, unitId: string) => report(u, unitId, "ACCESS", "The deadbolt on my front door is stuck and will not turn.", { issue: "lock_broken", someoneAtRisk: false });
/** The case's newest discovery once it has finished. */
const settled = (caseId: string, by: User = morgan, timeoutMs = 45_000) =>
  waitFor(
    async () => {
      const p = await by.must("getDiscoveryPanel", { caseId });
      return p.discoveries[0] && DONE.includes(p.discoveries[0].status) ? p : null;
    },
    timeoutMs,
    "the discovery to finish",
  );
const searchCalls = async () => ((await hook("fiberCalls")).calls["/v1/google-maps/search"] as number | undefined) ?? 0;

describe("discovery is only for missing coverage", () => {
  test("a vendor exists: no discovery, and asking for one is refused", async () => {
    const r = await report(priya, priyaUnit, "PLUMBING", "The bathroom sink drains very slowly.", { fixture: "bathroom_sink", activeLeak: false, spreading: false, waterNearElectrical: false });
    // Let the coordinator's coverage check run (it is the first thing a READY_FOR_VENDOR trigger does).
    await waitFor(async () => (await morgan.must("getCase", { caseId: r.caseId })).events.some((e: any) => e.type === "AI_UNAVAILABLE"), 20_000, "the coordinator run");
    const p = await morgan.must("getDiscoveryPanel", { caseId: r.caseId });
    assert.equal(p.usableVendors, 2);
    assert.equal(p.discoveries.length, 0);
    const ask = await morgan.op("requestVendorDiscovery", { caseId: r.caseId });
    assert.equal(ask.status, 409);
    assert.equal(ask.code, "discovery_not_needed");
  });
});

describe("no vendor: search, check, review, onboard, resume", () => {
  let caseId = "";
  let panel: any;
  test("no approved heating and cooling vendor at Maple Court: a discovery runs and keeps source-backed candidates", async () => {
    const before = await searchCalls();
    caseId = (await hvac(priya, priyaUnit)).caseId;
    panel = await settled(caseId);
    const d = panel.discoveries[0];
    assert.equal(d.status, "SUCCEEDED");
    assert.equal(d.mode, "fixture");
    // Exactly what was sent: a trade phrase and the city. Nothing about the resident.
    assert.equal(d.query, "heating and cooling contractor");
    assert.equal(d.location, "Waterloo, ON");
    assert.ok(!/priya|nair|4b|living room/i.test(`${d.query} ${d.location}`));
    assert.equal(d.placesReturned, 7);
    assert.equal(d.candidatesKept, 3, "the best three are kept");
    assert.match(d.chargeInfo, /"method":"free"/, "the provider's chargeInfo is recorded verbatim");
    assert.equal(await searchCalls(), before + 1, "one search call");
    const names = panel.candidates.map((c: any) => c.name);
    assert.deepEqual([...names].sort(), ["Evergreen Heating & Cooling", "Grand River Heating & Air", "Laurier Climate Services"]);
    const grand = panel.candidates.find((c: any) => c.name === "Grand River Heating & Air");
    assert.equal(grand.status, "NEW");
    assert.equal(grand.recommendation, "RECOMMENDED");
    assert.ok(grand.reasons.includes("Rated 4.7 from 212 Google reviews."), "reasons cite the source fields");
    assert.ok(grand.reasons.some((x: string) => /^About \d+\.\d km from Maple Court Apartments\.$/.test(x)));
    for (const m of ["licence", "insurance", "availability", "pricing", "email"]) assert.ok(grand.missing.includes(m), `unknown: ${m}`);
    assert.equal(grand.source, "fixture:google-maps");
  });
  test("wrong category and non-businesses are filtered with the reason; duplicates of a known vendor are flagged", async () => {
    const d = panel.discoveries[0];
    assert.ok(d.filtered.some((f: any) => f.name === "Waterloo Park" && /Not a business/.test(f.reason)));
    assert.ok(d.filtered.some((f: any) => f.name === "Bright Plumbing Supply" && /Wrong trade/.test(f.reason)));
    const ever = panel.candidates.find((c: any) => c.name === "Evergreen Heating & Cooling");
    assert.equal(ever.duplicateOf, "Evergreen Heating & Cooling");
    assert.ok(ever.reasons.some((x: string) => /Already a vendor in Relay/.test(x)));
  });
  test("the resident never sees discovery; managers are told and the next step says what to do", async () => {
    const resident = await priya.must("getCase", { caseId });
    assert.ok(!resident.events.some((e: any) => /DISCOVERY|CANDIDATE/.test(e.type)));
    assert.equal((await priya.op("getDiscoveryPanel", { caseId })).status, 403);
    assert.equal((await taylor.op("getDiscoveryPanel", { caseId })).status, 404, "another property's manager");
    const c = await morgan.must("getCase", { caseId });
    assert.match(c.nextAction, /review the businesses found/i);
    assert.ok((await morgan.must("getNotifications")).items.some((n: any) => /Businesses found/.test(n.title) && n.caseId === caseId));
  });
  test("a cached result is reused for the next case: no new call", async () => {
    const before = await searchCalls();
    const second = (await hvac(daniel, danielUnit)).caseId;
    const p = await settled(second);
    assert.equal(p.discoveries[0].reused, true);
    assert.equal(p.discoveries[0].status, "SUCCEEDED");
    for (let i = 0; i < 3; i++) await morgan.must("getDiscoveryPanel", { caseId: second });
    assert.equal(await searchCalls(), before, "refreshing or reusing never calls the provider");
    assert.equal(p.candidates.length, 3, "the same candidates");
  });
  test("a forced new search keeps more candidates, flags wrong area and missing contacts, and never duplicates rows", async () => {
    await hook("env", { set: { FIBER_MAX_CANDIDATES: "6" } });
    const r = await morgan.must("requestVendorDiscovery", { caseId, force: true });
    assert.equal(r.created, true);
    const p = await waitFor(async () => {
      const x = await morgan.must("getDiscoveryPanel", { caseId });
      return x.discoveries.length >= 2 && DONE.includes(x.discoveries[0].status) ? x : null;
    }, 45_000, "the second search");
    assert.equal(p.discoveries[0].candidatesKept, 5);
    assert.equal(p.candidates.length, 5, "upserted by place id: Grand River, Evergreen and Laurier are not duplicated");
    assert.equal(p.candidates.find((c: any) => c.name === "Grand River Heating & Air").timesSeen, 2);
    const far = p.candidates.find((c: any) => c.name === "Lakeshore Mechanical Air");
    assert.equal(far.checks.inServiceArea, false);
    assert.equal(far.recommendation, "NOT_RECOMMENDED");
    assert.ok(far.concerns.some((x: string) => /outside the 30 km service area/.test(x)));
    const bare = p.candidates.find((c: any) => c.name === "Kitchener Comfort Pros");
    assert.equal(bare.checks.hasContact, false);
    assert.ok(bare.missing.includes("phone") && bare.missing.includes("website"));
    panel = p;
  });
  test("an unverified candidate cannot be dispatched or onboarded", async () => {
    const grand = panel.candidates.find((c: any) => c.name === "Grand River Heating & Air");
    assert.equal((await morgan.op("assignVendor", { caseId, vendorId: grand.id })).status, 400, "a candidate is not a vendor");
    const settings = await taylor.must("getSettings");
    const evergreenId = settings.vendors.find((v: any) => v.name === "Evergreen Heating & Cooling").id;
    const notHere = await morgan.op("assignVendor", { caseId, vendorId: evergreenId });
    assert.equal(notHere.status, 400);
    assert.equal(notHere.code, "vendor_not_approved", "approved at Birch House is not approved at Maple Court");
    assert.equal((await morgan.op("onboardCandidate", { candidateId: grand.id })).code, "not_verified");
    await morgan.must("reviewCandidate", { candidateId: grand.id, decision: "SHORTLIST" });
    assert.equal((await morgan.op("onboardCandidate", { candidateId: grand.id })).code, "not_verified", "shortlisting is not verification");
  });
  test("reject needs a reason and can be reopened; verify needs a note", async () => {
    const laurier = panel.candidates.find((c: any) => c.name === "Laurier Climate Services");
    assert.equal((await morgan.op("reviewCandidate", { candidateId: laurier.id, decision: "REJECT" })).status, 400);
    assert.equal((await morgan.must("reviewCandidate", { candidateId: laurier.id, decision: "REJECT", note: "No phone answer" })).status, "REJECTED");
    assert.equal((await morgan.must("reviewCandidate", { candidateId: laurier.id, decision: "REOPEN" })).status, "NEW");
    const grand = panel.candidates.find((c: any) => c.name === "Grand River Heating & Air");
    assert.equal((await morgan.op("reviewCandidate", { candidateId: grand.id, decision: "VERIFY" })).code, "verification_note_required");
    assert.equal((await morgan.must("reviewCandidate", { candidateId: grand.id, decision: "VERIFY", note: "Called the office: licensed, insured, can come this week" })).status, "VERIFIED");
    assert.equal((await taylor.op("reviewCandidate", { candidateId: grand.id, decision: "REJECT", note: "not mine" })).status, 404, "another property's manager");
  });
  test("onboarding a verified business approves it here and the waiting case resumes", async () => {
    const grand = panel.candidates.find((c: any) => c.name === "Grand River Heating & Air");
    const [a, b] = await Promise.all([morgan.must("onboardCandidate", { candidateId: grand.id }), morgan.must("onboardCandidate", { candidateId: grand.id })]);
    assert.ok(a.repeated !== b.repeated || a.vendorId === b.vendorId, "two approvals at once onboard it once");
    assert.equal(a.vendorId, b.vendorId);
    const vendors = await morgan.must("getEligibleVendors", { caseId });
    const added = vendors.find((v: any) => v.name === "Grand River Heating & Air");
    assert.ok(added, "now an approved vendor at Maple Court");
    assert.equal(added.hasLogin, false);
    const c = await morgan.must("getCase", { caseId });
    assert.ok(c.events.some((e: any) => e.type === "VENDOR_ONBOARDED"));
    const offer = await morgan.must("assignVendor", { caseId, vendorId: added.id });
    assert.equal(offer.status, "AWAITING_VENDOR");
    assert.equal(offer.vendorHasLogin, false, "no Relay login: the manager is told to contact them directly");
    assert.ok((await morgan.must("getCase", { caseId })).events.some((e: any) => e.type === "NO_VENDOR_LOGIN"));
  });
  test("a duplicate of an existing vendor approves that vendor here instead of creating another", async () => {
    const ever = panel.candidates.find((c: any) => c.name === "Evergreen Heating & Cooling");
    await morgan.must("reviewCandidate", { candidateId: ever.id, decision: "VERIFY", note: "Already works at Birch House" });
    const r = await morgan.must("onboardCandidate", { candidateId: ever.id });
    const all = (await morgan.must("getSettings")).vendors.filter((v: any) => v.name.startsWith("Evergreen"));
    assert.equal(all.length, 1);
    assert.equal(all[0].id, r.vendorId);
    assert.ok(all[0].approvedAt.some((x: any) => x.propertyName === "Maple Court Apartments" && x.approved));
  });
  test("missing contact details must be supplied before onboarding", async () => {
    const bare = panel.candidates.find((c: any) => c.name === "Kitchener Comfort Pros");
    await morgan.must("reviewCandidate", { candidateId: bare.id, decision: "VERIFY", note: "Visited their shop, licensed" });
    assert.equal((await morgan.op("onboardCandidate", { candidateId: bare.id })).code, "contact_required");
    assert.equal((await morgan.must("onboardCandidate", { candidateId: bare.id, phone: "519-555-0108" })).ok, true);
  });
});

describe("failures never block the case", () => {
  before(async () => {
    await hook("reset");
  });
  test("no results: the case continues and a manager can add a vendor by hand", async () => {
    await hook("fiber", { scenario: "empty" });
    const caseId = (await electrical(priya, priyaUnit)).caseId;
    const p = await settled(caseId);
    assert.equal(p.discoveries[0].status, "SUCCEEDED");
    assert.equal(p.discoveries[0].candidatesKept, 0);
    const c = await morgan.must("getCase", { caseId });
    assert.ok(c.events.some((e: any) => e.type === "DISCOVERY_COMPLETED" && /No suitable local businesses/.test(e.message)));
    assert.match(c.nextAction, /Add an approved electrician/);
    const saved = await morgan.must("saveVendor", { name: "Test vendor Sparkline Electric", trades: ["ELECTRICAL"], phone: "519-555-0150" });
    assert.ok(saved.resumed.includes(caseId), "the waiting case resumes");
    const v = (await morgan.must("getEligibleVendors", { caseId })).find((x: any) => x.name === "Test vendor Sparkline Electric");
    assert.equal((await morgan.must("assignVendor", { caseId, vendorId: v.id })).status, "AWAITING_VENDOR");
  });
  test("the API is down: three attempts, then a clear failure, and the case is still workable", async () => {
    await hook("fiber", { scenario: "down" });
    const caseId = (await brokenLock(priya, priyaUnit)).caseId;
    const p = await settled(caseId, morgan, 60_000);
    const d = p.discoveries[0];
    assert.equal(d.status, "FAILED");
    assert.equal(d.errorCode, "unreachable");
    assert.equal(d.attempts, 3);
    assert.match(d.errorMessage, /after 3 attempts/);
    const c = await morgan.must("getCase", { caseId });
    assert.equal(c.status, "AWAITING_ASSIGNMENT");
    assert.ok(c.events.some((e: any) => e.type === "DISCOVERY_FAILED"));
    assert.ok((await morgan.must("getNotifications")).items.some((n: any) => n.caseId === caseId && /Vendor search failed/.test(n.title)));
  });
  test("credits exhausted: no search is made when the balance is empty; a 402 mid-search fails without retrying", async () => {
    await hook("fiber", { scenario: "exhausted" });
    const before = await searchCalls();
    const caseId = (await report(priya, priyaUnit, "ELEVATOR", "The elevator doors will not close on the ground floor.", { someoneTrapped: false, problem: "doors" })).caseId;
    const p = await settled(caseId);
    assert.equal(p.discoveries[0].status, "SKIPPED");
    assert.equal(p.discoveries[0].errorCode, "credits_exhausted");
    assert.equal(await searchCalls(), before, "the free balance check stopped it before any search");
    await hook("fiber", { scenario: "exhausted_mid" });
    await morgan.must("requestVendorDiscovery", { caseId, force: true });
    const q = await waitFor(async () => {
      const x = await morgan.must("getDiscoveryPanel", { caseId });
      return x.discoveries.length >= 2 && DONE.includes(x.discoveries[0].status) ? x : null;
    }, 45_000, "the second attempt");
    assert.equal(q.discoveries[0].status, "FAILED");
    assert.equal(q.discoveries[0].errorCode, "credits_exhausted");
    assert.equal(q.discoveries[0].attempts, 1, "a 402 is not retried");
    assert.match(q.discoveries[0].warnings ?? "", /outOfCreditsAlert/);
  });
  test("no key configured: the search is skipped, managers are told, and the case is not blocked", async () => {
    await hook("env", { set: { FIBER_MODE: "off" } });
    const caseId = (await hvac(priya, priyaUnit)).caseId;
    const p = await settled(caseId);
    assert.equal(p.discoveries[0].status, "SKIPPED");
    assert.equal(p.discoveries[0].errorCode, "not_configured");
    assert.equal(p.provider.configured, false);
    const c = await morgan.must("getCase", { caseId });
    assert.equal(c.status, "AWAITING_ASSIGNMENT");
    assert.match(c.nextAction, /Add an approved heating and cooling contractor/);
    await hook("env", { set: { FIBER_MODE: "fixture" } });
  });
});

describe("concurrency and interruption", () => {
  before(async () => {
    await hook("reset");
    await hook("fiber", { scenario: "slow" });
  });
  test("concurrent requests create one discovery and one provider call", async () => {
    const before = await searchCalls();
    // Birch House asks a manager before searching, so nothing runs until taylor approves.
    const caseId = (await electrical(noor, noorUnit)).caseId;
    const asks = await Promise.all(Array.from({ length: 5 }, () => taylor.op("requestVendorDiscovery", { caseId })));
    assert.ok(asks.every((a) => a.status === 200), JSON.stringify(asks.map((a) => a.status)));
    const ids = new Set(asks.map((a) => a.data.discoveryId));
    assert.equal(ids.size, 1, "every request got the same discovery");
    const [id] = [...ids];
    const runs = await Promise.all(Array.from({ length: 3 }, () => hook("discover", { discoveryId: id })));
    assert.ok(runs.filter((r) => r.result.status === "succeeded").length <= 1, "only one worker runs it");
    const p = await settled(caseId, taylor);
    assert.equal(p.discoveries.filter((d: any) => !d.reused).length, 1);
    assert.equal(p.discoveries[0].status, "SUCCEEDED");
    assert.equal(await searchCalls(), before + 1, "one paid call however many requests and workers");
  });
  test("a run interrupted after the paid call resumes from the saved response, without calling again", async () => {
    await hook("fiber", { scenario: "normal" });
    const caseId = (await brokenLock(noor, noorUnit)).caseId;
    await hook("fault", { point: "discovery.beforeCandidates", times: 1 });
    const before = await searchCalls();
    await taylor.must("requestVendorDiscovery", { caseId });
    await waitFor(async () => (await taylor.must("getDiscoveryPanel", { caseId })).discoveries[0]?.status === "RUNNING", 30_000, "the interrupted run");
    assert.equal(await searchCalls(), before + 1);
    // The sweep notices a run stuck for over five minutes and resumes it.
    await hook("sweep", { now: new Date(Date.now() + 6 * 60_000).toISOString(), deliverEmail: false });
    const p = await settled(caseId, taylor);
    assert.equal(p.discoveries[0].status, "SUCCEEDED");
    assert.equal(p.discoveries[0].attempts, 2);
    assert.equal(await searchCalls(), before + 1, "resumed from the saved response: no second paid call");
    assert.ok(p.candidates.some((c: any) => c.name === "Keyline Locksmiths"));
  });
  test("a run interrupted on every attempt fails clearly after the last one", async () => {
    await hook("reset");
    const caseId = (await brokenLock(noor, noorUnit)).caseId;
    await hook("fault", { point: "discovery.beforeCandidates", times: 5 });
    await taylor.must("requestVendorDiscovery", { caseId });
    for (let i = 1; i <= 3; i++) {
      await waitFor(async () => {
        const d = (await taylor.must("getDiscoveryPanel", { caseId })).discoveries[0];
        return d?.status === "RUNNING" && d.attempts === i ? d : null;
      }, 30_000, `interrupted attempt ${i}`);
      await hook("sweep", { now: new Date(Date.now() + i * 6 * 60_000).toISOString(), deliverEmail: false });
    }
    const p = await settled(caseId, taylor);
    assert.equal(p.discoveries[0].status, "FAILED");
    assert.equal(p.discoveries[0].errorCode, "interrupted");
    assert.match(p.discoveries[0].errorMessage, /interrupted 3 times/);
    assert.equal((await taylor.must("getCase", { caseId })).status, "AWAITING_ASSIGNMENT");
    await hook("fault", { point: "none", times: 0 });
  });
});
