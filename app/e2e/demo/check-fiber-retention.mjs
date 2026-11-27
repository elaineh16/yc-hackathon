// After the live Fiber search: a test reset must keep the real search (the record of credits spent, and the cache),
// clear the managers' decisions on its businesses, and a new identical need must reuse it with no new call.
// Run (from app/e2e) against the live-mode dev server: node demo/check-fiber-retention.mjs
import { api, hook, waitFor } from "./lib.mjs";

const out = {};
if ((await hook("fiberCalls")).mode !== "live") throw new Error("Run this against the live-mode server.");
const live = (await api("morgan", "getFiberStatus")).recent.find((d) => d.mode === "live" && !d.reused);
if (!live) throw new Error("No live search on record.");
out.liveSearch = { id: live.id, createdAt: live.createdAt, creditsCharged: live.creditsCharged };
await hook("reset");
const st = await api("morgan", "getFiberStatus");
out.afterReset = { spentToday: st.spentToday, searchesToday: st.searchesToday, liveSearchKept: st.recent.some((d) => d.id === live.id) };
const maple = (await api("morgan", "getSettings")).properties.find((p) => p.name === "Maple Court Apartments");
await api("morgan", "updateProperty", { propertyId: maple.id, autoDiscovery: false });
const unitId = (await api("priya", "getMe")).units[0].id;
const { caseId } = await api("priya", "reportIssue", { unitId, clientRequestId: crypto.randomUUID(), description: "The air conditioner in my living room is not cooling.", categoryHint: "HVAC", details: { system: "cooling", completelyOut: true, burningOrGasSmell: false, vulnerableOccupant: false } });
const p = await waitFor(async () => {
  const x = await api("morgan", "getDiscoveryPanel", { caseId });
  return x.discoveries[0] ? x : null;
}, 240_000, "the coverage check");
const d = p.discoveries[0];
out.newCase = { status: d.status, reused: d.reused, creditsCharged: d.creditsCharged, candidates: p.candidates.map((c) => ({ name: c.name, source: c.source, status: c.status })) };
const st2 = await api("morgan", "getFiberStatus");
out.afterReuse = { spentToday: st2.spentToday, searchesToday: st2.searchesToday, balance: st2.balance?.available ?? null };
const ok = out.afterReset.liveSearchKept && out.afterReset.spentToday === live.creditsCharged && d.reused && d.status === "SUCCEEDED" && d.creditsCharged === 0 && p.candidates.length > 0 && p.candidates.every((c) => c.status === "NEW" && !c.source.startsWith("fixture")) && st2.spentToday === live.creditsCharged;
console.log(JSON.stringify({ ok, ...out }, null, 1));
process.exit(ok ? 0 : 1);
