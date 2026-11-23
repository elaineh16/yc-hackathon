// Fills a TEST server (RELAY_TEST_HOOKS=true) with a realistic spread of cases, created through the real API by the
// demo accounts, so the screens and the demo have something to show. It RESETS all cases first.
// Run from app/: npx tsx scripts/demo-data.ts        (dev server running; FIBER_MODE=fixture for discovery)
import { hook, login, rid, slot, type User, waitFor } from "../tests/api/client";

const [priya, daniel, noor, morgan, taylor, sam, ana, lee] = await Promise.all(["priya", "daniel", "noor", "morgan", "taylor", "sam", "ana", "lee"].map(login));
await hook("reset");
const unit = async (u: User) => (await u.must("getMe")).units[0].id as string;
const [priyaUnit, danielUnit, noorUnit] = await Promise.all([unit(priya), unit(daniel), unit(noor)]);
const report = (u: User, unitId: string, categoryHint: string, description: string, details: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  u.must("reportIssue", { unitId, clientRequestId: rid(), description, categoryHint, details, ...extra });
const vendorId = async (mgr: User, caseId: string, name: string) => (await mgr.must("getEligibleVendors", { caseId })).find((v: any) => v.name === name).id;
const offerTo = async (mgr: User, caseId: string, name: string) => mgr.must("assignVendor", { caseId, vendorId: await vendorId(mgr, caseId, name) });
const offerOf = async (who: User, caseId: string) => (await who.must("getMyJobs")).offers.find((o: any) => o.id === caseId);

// 1. Resolved last: a leak fixed and confirmed by the resident (it gives the metrics something real to count).
const fixed = await report(daniel, danielUnit, "PLUMBING", "The bathroom faucet drips all night and keeps me awake.", { fixture: "bathroom_sink", activeLeak: true, spreading: false, waterNearElectrical: false, canShutOff: true });
await offerTo(morgan, fixed.caseId, "Northside Plumbing");
await sam.must("respondToOffer", { assignmentId: (await offerOf(sam, fixed.caseId)).assignmentId, accept: true, estimateType: "FIXED", estimateCents: 14000, slots: [slot(1, 9)] });
await daniel.must("chooseVisitTime", { slotId: (await daniel.must("getCase", { caseId: fixed.caseId })).assignment.slots[0].id });
await sam.must("startWork", { caseId: fixed.caseId });
await sam.must("completeWork", { caseId: fixed.caseId, notes: "Replaced the cartridge and both washers. No drip after ten minutes.", finalCostCents: 14000 });
await daniel.must("confirmResolution", { caseId: fixed.caseId, resolved: true, note: "Quiet all night. Thank you." });

// 2. Waiting on the manager's approval: an estimate over the property's threshold.
const leak = await report(priya, priyaUnit, "PLUMBING", "The kitchen sink is leaking under the cabinet. Water is pooling inside the cabinet.", { fixture: "kitchen_sink", activeLeak: true, spreading: false, waterNearElectrical: false, canShutOff: true }, { permissionToEnter: true, accessNotes: "Cat in the unit, keep the door closed." });
await offerTo(morgan, leak.caseId, "Northside Plumbing");
await sam.must("respondToOffer", { assignmentId: (await offerOf(sam, leak.caseId)).assignmentId, accept: true, estimateType: "FIXED", estimateCents: 32000, estimateNotes: "Replace the P-trap and the supply line, parts and labour", slots: [slot(2, 9), slot(3, 13)] });

// 3. Scheduled: a washer approved by policy, with a visit the resident chose.
const washer = await report(daniel, danielUnit, "APPLIANCE", "The washing machine will not drain. Water stays in the drum after the cycle.", { appliance: "washer", problem: "wont_drain", errorCode: "OE", burningOrSparks: false, gasSmell: false });
await offerTo(morgan, washer.caseId, "BrightSpark Appliance Repair");
await ana.must("respondToOffer", { assignmentId: (await offerOf(ana, washer.caseId)).assignmentId, accept: true, estimateType: "FIXED", estimateCents: 16500, slots: [slot(2, 14), slot(4, 10)] });
await daniel.must("chooseVisitTime", { slotId: (await daniel.must("getCase", { caseId: washer.caseId })).assignment.slots[0].id });

// 4. In progress with a request for more money that only the manager can decide.
const pipe = await report(priya, priyaUnit, "PLUMBING", "The pipe under the bathroom sink is leaking slowly into a bowl.", { fixture: "bathroom_sink", activeLeak: true, spreading: false, waterNearElectrical: false, canShutOff: true });
await offerTo(morgan, pipe.caseId, "Harbour Plumbing & Drain");
const jo = await login("jo");
await jo.must("respondToOffer", { assignmentId: (await offerOf(jo, pipe.caseId)).assignmentId, accept: true, estimateType: "FIXED", estimateCents: 18000, slots: [slot(1, 11)] });
await priya.must("chooseVisitTime", { slotId: (await priya.must("getCase", { caseId: pipe.caseId })).assignment.slots[0].id });
await jo.must("startWork", { caseId: pipe.caseId });
await jo.must("requestMoreBudget", { caseId: pipe.caseId, additionalCents: 35000, reason: "The trap is cracked and the shut-off valve is seized. I need to replace both: parts and about an hour more." });

// 5. No approved heating and cooling vendor at Maple Court: discovery finds local businesses (fixture data here).
const ac = await report(priya, priyaUnit, "HVAC", "The air conditioner in the living room is not cooling at all, it just blows warm air.", { system: "cooling", completelyOut: true, burningOrGasSmell: false, vulnerableOccupant: false });
const panel = await waitFor(async () => {
  const p = await morgan.must("getDiscoveryPanel", { caseId: ac.caseId });
  return p.discoveries[0]?.status === "SUCCEEDED" ? p : null;
}, 60_000, "the discovery");
const grand = panel.candidates.find((c: any) => c.name === "Grand River Heating & Air");
await morgan.must("reviewCandidate", { candidateId: grand.id, decision: "SHORTLIST" });
const laurier = panel.candidates.find((c: any) => c.name === "Laurier Climate Services");
await morgan.must("reviewCandidate", { candidateId: laurier.id, decision: "VERIFY", note: "Called the office: licensed, insured, can come Thursday." });

// 6. Neighbour noise (the manager's to handle) and a lockout (identity check by staff).
await report(daniel, danielUnit, "NOISE", "My upstairs neighbour plays loud music most nights until 2am.", { ongoing: true, someoneInDanger: false, when: "Most nights after 11 pm" });
await report(priya, priyaUnit, "ACCESS", "I'm locked out of my apartment, my keys are at work.", { issue: "locked_out", someoneAtRisk: false });

// 7. Birch House: an emergency, and an ordinary radiator job with an offer out to Evergreen.
await report(noor, noorUnit, "HVAC", "The radiator is cold and I can smell gas near the boiler room door.", { system: "heating", completelyOut: true, burningOrGasSmell: true, vulnerableOccupant: false });
const radiator = await noor.must("reportIssue", { unitId: noorUnit, clientRequestId: rid(), description: "The bedroom radiator is only lukewarm since yesterday.", categoryHint: "HVAC", details: { system: "heating", completelyOut: false, burningOrGasSmell: false, vulnerableOccupant: false } });
await offerTo(taylor, radiator.caseId, "Evergreen Heating & Cooling");
await lee.must("getMyJobs");

// 8. An electrical problem at Maple Court that is still waiting on the manager.
await report(priya, priyaUnit, "ELECTRICAL", "Half the outlets in my living room stopped working this morning.", { what: "outlets", burningOrSparks: false, waterNearby: false, breakerTried: true });
await hook("deliver", { now: true });
console.log("Demo data ready.");
