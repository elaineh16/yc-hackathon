// The live Fiber AI integration check, recorded through the manager interface. It is the one capped live search:
//   1. a resident reports an air conditioner at Maple Court, which has no approved heating and cooling vendor;
//   2. Relay's coverage check finds the gap and proposes a search (Maple Court is set to ask a manager first);
//   3. the manager approves it: ONE Google Maps search through Fiber AI (2 credits, checked against the balance,
//      the reserve and the daily budget first), saved with the provider's chargeInfo;
//   4. the manager reads the businesses and the provider's response, and shortlists one. Nobody verifies or
//      contacts a real business: verification is the manager's own check, outside Relay.
// If a live search for the same property and trade is still cached (FIBER_CACHE_DAYS), Relay reuses it with no new
// call and no credits, and says so on screen; facts.json records which of the two happened.
// Run (from app/e2e): node demo/capture-fiber.mjs <outDir>
// Needs: the dev server in live Fiber mode (FIBER_API_KEY in .env.server, FIBER_MODE unset), RELAY_TEST_HOOKS=true.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { api, DESKTOP, glide, hook, launch, scene, scrollTo, signIn, sleep, waitFor } from "./lib.mjs";

const OUT = process.argv[2] ?? "demo-out/fiber";
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const facts = { at: new Date().toISOString() };

const { mode } = await hook("fiberCalls");
if (mode !== "live") throw new Error(`The server's Fiber AI mode is "${mode}". This capture is the live integration check: start the server with the key and without FIBER_MODE.`);

// ───────────────────────── setup the video does not show ─────────────────────────
log("reset (live searches and their record of spend are kept)");
await hook("reset");
const maple = (await api("morgan", "getSettings")).properties.find((p) => p.name === "Maple Court Apartments");
// Maple Court asks a manager before any search, so nothing is spent without a person's click.
await api("morgan", "updateProperty", { propertyId: maple.id, autoDiscovery: false });
const before = await api("morgan", "getFiberStatus");
facts.before = { mode: before.mode, balance: before.balance, spentToday: before.spentToday, searchesToday: before.searchesToday };
log("Fiber status:", JSON.stringify(facts.before));

const priyaUnit = (await api("priya", "getMe")).units[0].id;
const ac = await api("priya", "reportIssue", {
  unitId: priyaUnit,
  clientRequestId: crypto.randomUUID(),
  description: "The air conditioner in my living room is blowing warm air and the room is getting hot.",
  categoryHint: "HVAC",
  details: { system: "cooling", completelyOut: true, burningOrGasSmell: false, vulnerableOccupant: false },
});
facts.caseId = ac.caseId;
log("HVAC case", ac.caseId, "- waiting for the coverage check");
const first = await waitFor(async () => {
  const p = await api("morgan", "getDiscoveryPanel", { caseId: ac.caseId });
  return p.discoveries[0] ? p : null;
}, 240_000, "the coverage check");
facts.firstStatus = first.discoveries[0].status;
facts.reused = first.discoveries[0].reused;
log("discovery:", facts.firstStatus, facts.reused ? "(reused: no call)" : "");

// ───────────────────────── the recorded scene ─────────────────────────
const browser = await launch();
const manager = await signIn(browser, "morgan", DESKTOP);
await manager.goto(`/ops/cases/${ac.caseId}`);
await manager.getByTestId("next-action").waitFor();
const panel = manager.locator("#discovery");
await panel.waitFor();
const s = await scene(manager, join(OUT, "04-fiber"), "fiber");
await sleep(2500);
await s.focus("header", manager.getByTestId("next-action"));
await sleep(3500);
await scrollTo(manager, panel, 90);
await sleep(1200);
await s.focus("gap", panel);
await sleep(4500);
if (facts.firstStatus === "AWAITING_MANAGER") {
  const approve = manager.getByRole("button", { name: /Approve the search/ });
  await s.focus("approve", approve);
  await sleep(2000);
  await glide(manager, approve);
  s.mark("approved");
  log("search approved in the UI");
}
// The search runs as a background job; the panel refreshes every few seconds.
const settled = await waitFor(async () => {
  const p = await api("morgan", "getDiscoveryPanel", { caseId: ac.caseId });
  const d = p.discoveries[0];
  return d && ["SUCCEEDED", "FAILED", "SKIPPED", "CANCELLED"].includes(d.status) ? p : null;
}, 180_000, "the search to finish");
const d = settled.discoveries[0];
facts.discovery = d;
log("search:", d.status, d.reused ? "(reused)" : "", `places ${d.placesReturned}, kept ${d.candidatesKept}, credits ${d.creditsCharged}`, d.errorMessage ?? "");
if (d.status === "SUCCEEDED" && settled.candidates.length) await manager.getByTestId("candidate").first().waitFor({ timeout: 30_000 });
s.mark("results");
await sleep(2500);
const row = manager.getByTestId("discovery-search").first();
await s.focus("search-row", row);
await sleep(4000);
const details = row.getByRole("button", { name: /Details:/ });
if (await details.isVisible().catch(() => false)) {
  await glide(manager, details);
  await sleep(1200);
  await s.focus("provider-response", row);
  await sleep(5500);
}
const cands = manager.getByTestId("candidate");
if ((await cands.count()) > 0) {
  const top = cands.first();
  await scrollTo(manager, top, 110);
  await sleep(1000);
  await s.focus("candidate", top);
  await sleep(6000);
  facts.shortlisted = (await top.locator("span.font-medium").first().innerText()).trim();
  // Shortlist only: nobody has called, checked a licence or insurance, or asked about availability.
  await glide(manager, top.getByRole("button", { name: "Shortlist" }));
  await top.getByText("Shortlisted", { exact: true }).waitFor({ timeout: 20_000 });
  await sleep(1500);
  await s.focus("shortlisted", top);
  await sleep(3500);
  if ((await cands.count()) > 1) {
    await scrollTo(manager, cands.nth(1), 110);
    await sleep(1000);
    await s.focus("candidate-2", cands.nth(1));
    await sleep(4500);
  }
}
const m = await s.stop();
facts.scene = { frames: m.frames.length, seconds: Math.round(m.ended - m.started) };

// Evidence stills: the case's discovery panel and the provider status, as the manager sees them.
await manager.goto(`/ops/cases/${ac.caseId}`);
await manager.locator("#discovery").waitFor();
await manager.getByTestId("discovery-search").first().getByRole("button", { name: /Details:/ }).click().catch(() => undefined);
await sleep(1500);
await manager.locator("#discovery").screenshot({ path: join(OUT, "fiber-live-panel.png") });
await manager.goto("/ops/vendors");
await manager.getByText(/Fiber AI, live/).first().waitFor({ timeout: 30_000 }).catch(() => undefined);
await sleep(2000);
await manager.screenshot({ path: join(OUT, "fiber-live-vendors-page.png"), fullPage: true });
await browser.close();

const after = await api("morgan", "getFiberStatus");
facts.after = { spentToday: after.spentToday, searchesToday: after.searchesToday, recent: after.recent.slice(0, 3) };
facts.candidates = settled.candidates.map((c) => ({ name: c.name, source: c.source, categories: c.categories, rating: c.rating, reviewCount: c.reviewCount, distanceKm: c.distanceKm, recommendation: c.recommendation, status: c.status, phoneListed: !!c.phone, websiteListed: !!c.website, missing: c.missing, duplicateOf: c.duplicateOf }));
writeFileSync(join(OUT, "facts.json"), JSON.stringify(facts, null, 1));
log("done:", JSON.stringify({ status: d.status, reused: d.reused, creditsCharged: d.creditsCharged, kept: d.candidatesKept, shortlisted: facts.shortlisted }));
