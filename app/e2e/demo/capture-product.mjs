// Records the product demo from the real running app: every scene is real interaction with the dev server (model
// on, discovery in fixture mode, email captured by Mailpit). Output: one folder of frames per scene, with markers.
// Run (from app/e2e): node demo/capture-product.mjs <outDir>
// Needs: the dev server with RELAY_TEST_HOOKS=true, FIBER_MODE=fixture, SMTP to Mailpit, and the model reachable.
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { api, coordinatorIdle, DESKTOP, glide, hook, launch, MAILPIT, PHONE, scene, scrollTo, signIn, sleep, type, waitFor } from "./lib.mjs";

const OUT = process.argv[2] ?? "demo-out/product";
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const facts = {};

// ───────────────────────── setup the video does not show ─────────────────────────
log("reset and background cases");
await hook("reset");
await fetch(`${MAILPIT}/api/v1/messages`, { method: "DELETE" }).catch(() => undefined);
const priyaUnit = (await api("priya", "getMe")).units[0].id;
const danielUnit = (await api("daniel", "getMe")).units[0].id;
const rid = () => crypto.randomUUID();
// A dishwasher (an approved vendor exists), an AC that is not cooling (no approved heating and cooling vendor at Maple
// Court, so discovery runs), and a possible emergency, so the command center shows real, varied work.
await api("daniel", "reportIssue", { unitId: danielUnit, clientRequestId: rid(), description: "The dishwasher will not start. The panel lights up but nothing happens.", categoryHint: "APPLIANCE", details: { appliance: "dishwasher", problem: "wont_start", burningOrSparks: false, gasSmell: false } });
const ac = await api("priya", "reportIssue", { unitId: priyaUnit, clientRequestId: rid(), description: "The air conditioner in the living room is blowing warm air and the unit is getting hot.", categoryHint: "HVAC", details: { system: "cooling", completelyOut: true, burningOrGasSmell: false, vulnerableOccupant: false } });
facts.acCaseId = ac.caseId;
await api("daniel", "reportIssue", { unitId: danielUnit, clientRequestId: rid(), description: "Water is dripping from the ceiling light fixture in my bathroom.", categoryHint: "PLUMBING", details: { fixture: "other", activeLeak: true, spreading: true, waterNearElectrical: true, canShutOff: false } });
log("waiting for Relay AI to review the background cases");
for (const c of (await api("morgan", "searchCases", { pageSize: 20 })).items) await coordinatorIdle(c.id, 900_000).catch((e) => log("note:", e.message));
await waitFor(async () => (await api("morgan", "getDiscoveryPanel", { caseId: facts.acCaseId })).candidates?.length > 0, 120_000, "discovery candidates");

const browser = await launch();
const manifests = [];

// ───────────────────────── 1. the resident reports by chat ─────────────────────────
log("scene: resident chat");
const resident = await signIn(browser, "priya", PHONE);
await resident.goto("/my/report");
await resident.getByRole("tab", { name: "Chat with Relay" }).click().catch(() => undefined);
await resident.getByLabel("Message to Relay").waitFor();
let s = await scene(resident, join(OUT, "01-resident-chat"), "resident-chat");
await sleep(1500);
const answers = [
  "Hi, the kitchen sink is leaking under the cabinet. There's a small puddle and it keeps dripping.",
  "It's a slow drip from the pipe under the sink into the cabinet. It's not near any outlets, and I turned off the valve under the sink.",
  "Yes, that's right. Please file it.",
  "Yes, please submit it now.",
];
const relayCount = () => resident.locator('[data-testid="chat-log"] > div.bg-sunk').count();
for (const [i, text] of answers.entries()) {
  if (await resident.getByText(/^Filed as RLY-\d{4}/).isVisible().catch(() => false)) break;
  const before = await relayCount();
  await type(resident, resident.getByLabel("Message to Relay"), text, 24);
  await glide(resident, resident.getByRole("button", { name: "Send" }));
  s.mark(`sent-${i + 1}`);
  await resident.getByTestId("chat-pending").waitFor({ timeout: 20_000 }).catch(() => undefined);
  s.mark(`wait-${i + 1}`);
  await waitFor(async () => (await relayCount()) > before && !(await resident.getByTestId("chat-pending").isVisible()), 600_000, `Relay's reply ${i + 1}`);
  s.mark(`reply-${i + 1}`);
  await sleep(4500);
}
await resident.getByText(/^Filed as RLY-\d{4}/).waitFor({ timeout: 60_000 });
s.mark("filed");
await s.focus("confirmation", resident.getByTestId("chat-log"));
await sleep(3500);
await glide(resident, resident.getByRole("button", { name: "Follow this request" }));
await resident.waitForURL(/\/my\/cases\//);
facts.leakCaseId = new URL(resident.url()).pathname.split("/").pop();
await sleep(3500);
manifests.push(await s.stop());

log("waiting for Relay AI to review the new case", facts.leakCaseId);
await coordinatorIdle(facts.leakCaseId, 900_000);

// ───────────────────────── 2. the manager: command center and the case workspace ─────────────────────────
log("scene: manager workspace");
const manager = await signIn(browser, "morgan", DESKTOP);
await manager.goto("/ops");
await manager.getByRole("heading", { name: "Your move" }).waitFor();
s = await scene(manager, join(OUT, "02-manager-workspace"), "manager-workspace");
await sleep(3000);
await s.focus("your-move", manager.getByRole("heading", { name: "Your move" }).locator("xpath=ancestor::section[1]"));
await sleep(3000);
const leak = await api("morgan", "getCase", { caseId: facts.leakCaseId });
facts.leakRef = leak.ref;
const link = manager.getByRole("link", { name: new RegExp(leak.ref) }).first();
if (await link.isVisible().catch(() => false)) await glide(manager, link);
else await manager.goto(`/ops/cases/${facts.leakCaseId}`);
await manager.waitForURL(/\/ops\/cases\//);
await manager.getByTestId("next-action").waitFor();
await sleep(2500);
await s.focus("header", manager.locator("main").first(), 0);
await s.focus("next-action", manager.getByTestId("next-action"));
await sleep(3500);
const reading = manager.getByTestId("reading");
if (await reading.isVisible().catch(() => false)) {
  await scrollTo(manager, reading, 160);
  await sleep(800);
  await s.focus("reading", reading);
  await sleep(4000);
}
const runs = manager.getByRole("button", { name: /What Relay did/ });
await scrollTo(manager, runs, 220);
await glide(manager, runs);
await sleep(1200);
await s.focus("runs", runs.locator("xpath=ancestor::section[1]"));
await sleep(5000);
const suggestion = manager.getByTestId("ai-suggestion").first();
if (await suggestion.isVisible().catch(() => false)) {
  await scrollTo(manager, suggestion, 200);
  await sleep(600);
  await s.focus("suggestion", suggestion);
  await sleep(4000);
  facts.acceptedAiProposal = true;
  await glide(manager, suggestion.getByRole("button", { name: "Send this offer" }));
} else {
  facts.acceptedAiProposal = false;
  await scrollTo(manager, manager.getByRole("heading", { name: "Assign a vendor" }), 120);
  await glide(manager, manager.getByText("Northside Plumbing", { exact: true }).first());
  await glide(manager, manager.getByRole("button", { name: "Send the job offer" }));
}
await manager.getByRole("heading", { name: "Offer sent" }).waitFor({ timeout: 30_000 });
await sleep(1000);
await s.focus("offer-sent", manager.getByRole("heading", { name: "Offer sent" }).locator("xpath=ancestor::section[1]"));
await sleep(3500);
manifests.push(await s.stop());

// ───────────────────────── 3. vendor discovery (fixture mode, labelled) ─────────────────────────
log("scene: discovery");
await manager.goto(`/ops/cases/${facts.acCaseId}`);
const panel = manager.locator("#discovery");
await panel.waitFor();
s = await scene(manager, join(OUT, "03-discovery"), "discovery");
await sleep(1500);
await scrollTo(manager, panel, 90);
await sleep(1500);
await s.focus("discovery-search", manager.getByTestId("discovery-search").first());
await sleep(4500);
const cand = manager.getByTestId("candidate").filter({ hasText: "Laurier Climate Services" });
await s.focus("candidate", cand);
await sleep(5000);
await glide(manager, cand.getByRole("button", { name: "Mark verified" }));
await type(manager, manager.getByLabel("What you checked"), "Called the office: licensed and insured, can come Thursday.", 22);
await glide(manager, manager.getByRole("dialog").getByRole("button", { name: "Mark verified" }));
await cand.getByText("Verified by you").waitFor();
await sleep(1500);
await glide(manager, cand.getByRole("button", { name: "Approve for this property" }));
await sleep(1500);
await glide(manager, manager.getByRole("dialog").getByRole("button", { name: "Approve and add to vendors" }));
await cand.getByText("Approved for this property").waitFor();
await sleep(1500);
await s.focus("approved", cand);
await sleep(3500);
await scrollTo(manager, manager.getByRole("heading", { name: "Assign a vendor" }), 120);
await sleep(800);
await glide(manager, manager.getByRole("radio").first());
await glide(manager, manager.getByRole("button", { name: "Send the job offer" }));
await manager.getByRole("heading", { name: "Offer sent" }).waitFor();
await sleep(3000);
manifests.push(await s.stop());

// ───────────────────────── 4. the contractor, the approval, the visit, the work ─────────────────────────
log("scene: contractor accepts");
const contractor = await signIn(browser, "sam", PHONE);
await contractor.goto(`/jobs/${facts.leakCaseId}`);
await contractor.getByRole("heading", { name: "New job offer" }).waitFor();
s = await scene(contractor, join(OUT, "04-contractor-accepts"), "contractor-accepts");
await sleep(2500);
await type(contractor, contractor.getByLabel("Estimate (CAD, all in)"), "320", 60);
await type(contractor, contractor.getByLabel("What it covers"), "Replace the P-trap and the supply line", 22);
await scrollTo(contractor, contractor.getByRole("button", { name: "Accept the job" }), 400);
await sleep(800);
await glide(contractor, contractor.getByRole("button", { name: "Accept the job" }));
await contractor.getByText(/waiting for the manager's approval/i).first().waitFor({ timeout: 30_000 });
await sleep(3000);
manifests.push(await s.stop());

log("scene: manager approves");
await manager.goto(`/ops/cases/${facts.leakCaseId}`);
await manager.getByRole("heading", { name: "Approve the estimate" }).waitFor();
s = await scene(manager, join(OUT, "05-manager-approves"), "manager-approves");
await sleep(2000);
await s.focus("approval", manager.getByRole("heading", { name: "Approve the estimate" }).locator("xpath=ancestor::section[1]"));
await sleep(3000);
const cap = manager.locator("#cap");
await glide(manager, cap);
await cap.fill("");
await cap.pressSequentially("350", { delay: 80 });
await sleep(600);
await glide(manager, manager.getByRole("button", { name: /^Approve/ }).first());
await manager.getByRole("heading", { name: "Approve the estimate" }).waitFor({ state: "hidden", timeout: 30_000 });
await sleep(3000);
manifests.push(await s.stop());

log("scene: resident picks a time");
await resident.goto(`/my/cases/${facts.leakCaseId}`);
await resident.getByRole("heading", { name: "Choose a visit time" }).waitFor();
s = await scene(resident, join(OUT, "06-resident-time"), "resident-time");
await sleep(2500);
await glide(resident, resident.getByRole("button", { name: /Choose$/ }).first());
await resident.getByText(/Visit confirmed:/).first().waitFor();
await sleep(3500);
manifests.push(await s.stop());

log("scene: contractor completes");
await contractor.goto(`/jobs/${facts.leakCaseId}`);
await contractor.getByRole("button", { name: "Start work" }).waitFor();
s = await scene(contractor, join(OUT, "07-contractor-completes"), "contractor-completes");
await sleep(2000);
await glide(contractor, contractor.getByRole("button", { name: "Start work" }));
await contractor.getByRole("heading", { name: "Work in progress" }).waitFor();
await sleep(1500);
await type(contractor, contractor.getByLabel("What did you do?"), "Replaced the P-trap and the supply line. No leaks after 20 minutes.", 18);
await glide(contractor, contractor.getByRole("button", { name: "Mark work complete" }));
await contractor.getByText("Waiting for the resident to confirm the fix.").waitFor();
await sleep(3000);
manifests.push(await s.stop());

// ───────────────────────── 5. follow-up: in-app, email (captured), the resident's answer ─────────────────────────
log("scene: follow-up");
await hook("deliver", { now: true });
await resident.goto(`/my/cases/${facts.leakCaseId}`);
await resident.getByRole("heading", { name: "Is it fixed?" }).waitFor();
s = await scene(resident, join(OUT, "08-resident-followup"), "resident-followup");
await sleep(2000);
await glide(resident, resident.getByRole("button", { name: /Notifications/ }));
await resident.getByText(/Is this fixed\?/).first().waitFor();
await sleep(4000);
await resident.keyboard.press("Escape");
await sleep(1200);
manifests.push(await s.stop());

log("scene: the captured email");
const mail = await browser.newContext({ ...DESKTOP });
const inbox = await mail.newPage();
await inbox.goto(MAILPIT);
await inbox.getByText(/Is this fixed\?/).first().waitFor({ timeout: 30_000 });
s = await scene(inbox, join(OUT, "09-mailpit"), "mailpit");
await sleep(2500);
await inbox.getByText(/Is this fixed\?/).first().click();
await sleep(5000);
manifests.push(await s.stop());

log("scene: resident confirms");
await resident.goto(`/my/cases/${facts.leakCaseId}`);
await resident.getByRole("heading", { name: "Is it fixed?" }).waitFor();
s = await scene(resident, join(OUT, "10-resident-confirms"), "resident-confirms");
await sleep(1500);
await glide(resident, resident.getByRole("button", { name: "Yes, resolved" }));
await resident.getByTestId("next-action").getByText(/Resolved/).waitFor();
await sleep(3000);
manifests.push(await s.stop());

log("scene: the audit trail");
await manager.goto(`/ops/cases/${facts.leakCaseId}`);
await manager.getByTestId("timeline").waitFor();
s = await scene(manager, join(OUT, "11-timeline"), "timeline");
await sleep(1500);
await scrollTo(manager, manager.getByTestId("timeline"), 100);
await sleep(1200);
await s.focus("timeline", manager.getByTestId("timeline"));
await sleep(4500);
const followups = manager.getByTestId("followups");
if (await followups.isVisible().catch(() => false)) {
  await scrollTo(manager, followups, 120);
  await sleep(1000);
  await s.focus("followups", followups);
  await sleep(4500);
}
manifests.push(await s.stop());

// ───────────────────────── 6. a vague report, and an authorization guard ─────────────────────────
log("scene: vague report");
await resident.goto("/my/report");
await resident.getByRole("tab", { name: "Chat with Relay" }).click().catch(() => undefined);
await resident.getByLabel("Message to Relay").waitFor();
s = await scene(resident, join(OUT, "12-vague"), "vague");
await sleep(1200);
const before = await relayCount();
await type(resident, resident.getByLabel("Message to Relay"), "Something's not right in my apartment since yesterday and I'm not sure what it is.", 24);
await glide(resident, resident.getByRole("button", { name: "Send" }));
s.mark("sent-1");
await resident.getByTestId("chat-pending").waitFor({ timeout: 20_000 }).catch(() => undefined);
s.mark("wait-1");
await waitFor(async () => (await relayCount()) > before && !(await resident.getByTestId("chat-pending").isVisible()), 600_000, "Relay's question");
s.mark("reply-1");
await sleep(6000);
facts.vagueReply = await resident.locator('[data-testid="chat-log"] > div.bg-sunk').last().innerText();
facts.vagueFiled = await resident.getByText(/^Filed as RLY-\d{4}/).isVisible().catch(() => false);
manifests.push(await s.stop());

log("scene: authorization guard");
const other = await signIn(browser, "jo", PHONE);
s = await scene(other, join(OUT, "13-guard"), "guard");
await sleep(800);
await other.goto(`/jobs/${facts.leakCaseId}`);
await other.getByText(/could not be found/i).first().waitFor({ timeout: 30_000 });
await sleep(1000);
await s.focus("guard", other.getByText(/could not be found/i).first());
await sleep(3500);
manifests.push(await s.stop());

await browser.close();
writeFileSync(join(OUT, "facts.json"), JSON.stringify({ ...facts, scenes: manifests.map((m) => ({ name: m.name, frames: m.frames.length, seconds: Math.round(m.ended - m.started) })) }, null, 1));
log("done", JSON.stringify(facts));
