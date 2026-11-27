// Records the product demo, "Relay: from request to resolution", from the real running app. Every scene is real
// interaction with the dev server: the local model answers the chat and reviews cases, the database holds one case
// that three people act on, and email goes to the local Mailpit test inbox. Nothing on screen is mocked.
// Vendor discovery is recorded separately (capture-fiber.mjs): that scene is the live Fiber AI search.
//
// Run (from app/e2e):  node demo/capture-product.mjs <outDir> [--from <scene number>]
// Needs: the dev server in live Fiber mode (Maple Court is switched to "ask a manager before searching", so this
// capture spends nothing), RELAY_TEST_HOOKS=true, SMTP to Mailpit, and the model reachable.
// --from N resumes at scene N with the cases already in the database (facts.json keeps their ids): no reset.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { api, coordinatorIdle, CURSOR, DESKTOP, glide, hook, launch, MAILPIT, PHONE, scene, scrollTo, signIn, sleep, type, waitFor } from "./lib.mjs";

const OUT = process.argv[2] ?? "demo-out/product";
const fromIdx = process.argv.indexOf("--from");
const FROM = fromIdx > 0 ? Number(process.argv[fromIdx + 1]) : 0;
// --to N stops recording after scene N (to record one scene again).
const toIdx = process.argv.indexOf("--to");
const TO = toIdx > 0 ? Number(process.argv[toIdx + 1]) : 99;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
mkdirSync(OUT, { recursive: true });
const factsFile = join(OUT, "facts.json");
const facts = FROM > 0 && existsSync(factsFile) ? JSON.parse(readFileSync(factsFile, "utf-8")) : { scenes: {} };
const save = () => writeFileSync(factsFile, JSON.stringify(facts, null, 1));
const rid = () => crypto.randomUUID();

const { mode } = await hook("fiberCalls");
if (mode !== "live") throw new Error(`The server's Fiber AI mode is "${mode}"; record the product demo against the live-mode server (it spends nothing: searches wait for a manager).`);

// ───────────────────────── setup the video does not show ─────────────────────────
if (FROM === 0) {
  log("reset, then the background cases");
  await hook("reset");
  await fetch(`${MAILPIT}/api/v1/messages`, { method: "DELETE" }).catch(() => undefined);
  const maple = (await api("morgan", "getSettings")).properties.find((p) => p.name === "Maple Court Apartments");
  await api("morgan", "updateProperty", { propertyId: maple.id, autoDiscovery: false });
  const danielUnit = (await api("daniel", "getMe")).units[0].id;
  // A dishwasher that will be "repaired" (through the API) and then reported as not fixed, on camera.
  const dish = await api("daniel", "reportIssue", { unitId: danielUnit, clientRequestId: rid(), description: "The dishwasher will not start. The panel lights up but nothing happens.", categoryHint: "APPLIANCE", details: { appliance: "dishwasher", problem: "wont_start", burningOrSparks: false, gasSmell: false } });
  facts.dishCaseId = dish.caseId;
  // A possible emergency (water near a light fixture) and a lockout: both must go to a person.
  const ceiling = await api("daniel", "reportIssue", { unitId: danielUnit, clientRequestId: rid(), description: "Water is dripping from the ceiling light fixture in my bathroom.", categoryHint: "PLUMBING", details: { fixture: "other", activeLeak: true, spreading: true, waterNearElectrical: true, canShutOff: false } });
  facts.ceilingCaseId = ceiling.caseId;
  const lockout = await api("daniel", "reportIssue", { unitId: danielUnit, clientRequestId: rid(), description: "I locked myself out of my apartment. My keys are inside.", categoryHint: "ACCESS", details: { issue: "locked_out", someoneAtRisk: false } });
  facts.lockoutCaseId = lockout.caseId;
  save();
  log("waiting for Relay AI to review the background cases");
  for (const id of [dish.caseId, ceiling.caseId, lockout.caseId]) await coordinatorIdle(id, 900_000).catch((e) => log("note:", e.message));
  // The dishwasher goes through a real repair by the approved appliance contractor (Ana), through the API.
  const brightspark = (await api("morgan", "getEligibleVendors", { caseId: dish.caseId })).find((v) => v.name === "BrightSpark Appliance Repair");
  await api("morgan", "assignVendor", { caseId: dish.caseId, vendorId: brightspark.id });
  const offer = (await api("ana", "getMyJobs")).offers.find((o) => o.id === dish.caseId);
  const start = new Date(Date.now() + 26 * 3600_000);
  start.setMinutes(0, 0, 0);
  await api("ana", "respondToOffer", { assignmentId: offer.assignmentId, accept: true, estimateType: "FIXED", estimateCents: 14000, estimateNotes: "Diagnose and repair the control board", slots: [{ startAt: start.toISOString(), endAt: new Date(start.getTime() + 2 * 3600_000).toISOString() }] });
  let dc = await api("morgan", "getCase", { caseId: dish.caseId });
  if (dc.can?.decideSpend) await api("morgan", "decideSpend", { caseId: dish.caseId, approve: true });
  dc = await api("daniel", "getCase", { caseId: dish.caseId });
  await api("daniel", "chooseVisitTime", { slotId: dc.assignment.slots[0].id });
  await api("ana", "startWork", { caseId: dish.caseId });
  await api("ana", "completeWork", { caseId: dish.caseId, notes: "Reset the control board and cleared the drain filter. Ran one full cycle.", finalCostCents: 14000 });
  await coordinatorIdle(dish.caseId, 900_000).catch((e) => log("note:", e.message));
  save();
}

const browser = await launch();
const pages = {};
const as = async (who, device) => (pages[who] ??= await signIn(browser, who, device));
let current = null;
async function record(n, name, page, fn) {
  if (n < FROM || n > TO) return;
  log(`scene ${n}: ${name}`);
  current = await scene(page, join(OUT, name), name);
  try {
    await fn(current);
  } catch (e) {
    await page.screenshot({ path: join(OUT, `error-${name}.png`) }).catch(() => undefined);
    log("FAILED at", page.url());
    throw e;
  }
  const m = await current.stop();
  facts.scenes[name] = { frames: m.frames.length, seconds: Math.round(m.ended - m.started) };
  save();
}
/** Scrolls to something, marks it for a zoom, and lets the viewer read it. */
async function show(page, s, label, locator, ms = 4000, offset = 120) {
  await scrollTo(page, locator, offset);
  await sleep(700);
  await s.focus(label, locator);
  await sleep(ms);
}
const chatReplies = (p) => p.locator('[data-testid="chat-log"] > div.bg-sunk');
// The two approved plumbers at Maple Court with a contractor login (seed data), by vendor name.
const PLUMBERS = { "Northside Plumbing": "sam", "Harbour Plumbing & Drain": "jo" };

// ───────────────────────── 0. Relay: the manager's command center ─────────────────────────
const manager = await as("morgan", DESKTOP);
await manager.goto("/ops");
await manager.getByRole("heading", { name: "Your move" }).waitFor();
await record(0, "00-intro", manager, async (s) => {
  await sleep(3000);
  await s.focus("attention", manager.getByRole("heading", { name: /Needs attention/ }).locator("xpath=ancestor::section[1]"));
  await sleep(4500);
  await s.focus("your-move", manager.getByRole("heading", { name: "Your move" }).locator("xpath=ancestor::section[1]"));
  await sleep(4000);
});

// ───────────────────────── 1. the resident reports by chat ─────────────────────────
const resident = await as("priya", PHONE);
if (FROM <= 1) {
  await resident.goto("/my/report");
  await resident.getByRole("tab", { name: "Chat with Relay" }).click().catch(() => undefined);
  await resident.getByLabel("Message to Relay").waitFor();
}
await record(1, "01-resident-chat", resident, async (s) => {
  await sleep(1500);
  // Priya's lines are scripted, but each one answers the question Relay actually asked (a blanket "yes" could tell
  // Relay that water is spreading, which rightly makes it an emergency). Every Relay reply is the real model's.
  const DETAIL = "It's a steady drip from the pipe under the sink into the cabinet, with a small puddle. I closed the valve, but it still drips a little.";
  const ANSWERS = [
    [/\b(spread|another unit|floor|ceiling|below|neighbou?r|wall)/, "No, it isn't spreading. It stays inside the cabinet."],
    [/\b(anyone|someone|injur|hurt|safe|emergency|help)/, "No, everyone's fine. It's just the leak."],
    [/\b(danger|gas|smoke|smell|burn|spark|fire)/, "No, nothing like that."],
    [/\b(electric|outlet|wiring|light|power|appliance)/, "No, it's not near any outlets or wiring."],
    [/\b(stop|valve|shut|turn (it )?off)/, "No, it still drips a little even with the valve closed."],
    [/\b(right now|leaking now|still leaking|currently|active)/, "Yes, it's still dripping slowly into the cabinet."],
    [/\b(file|submit|go ahead|confirm|correct|is that right|shall i|should i|ready to)\b/, "Yes, that's right."],
    [/\b(where|which|how|describe|more|puddle|drip)/, DETAIL],
  ];
  const answerTo = (q, i, used) => {
    const t = q.toLowerCase();
    const hit = ANSWERS.find(([re, a]) => re.test(t) && !used.some((u) => u.includes(a)));
    let text = hit?.[1] ?? (used.some((u) => u.includes(DETAIL)) ? "That's everything I know." : DETAIL);
    // The first answer also gives the details; later ones ask Relay to file.
    if (i === 1 && text !== DETAIL) text = `${text} ${DETAIL}`;
    if (i >= 3) text = `${text} Please file it now.`;
    return text;
  };
  facts.chat = [];
  const said = [];
  for (let i = 0; i < 5; i++) {
    if (await resident.getByText(/^Filed as RLY-\d{4}/).isVisible().catch(() => false)) break;
    const text = i === 0 ? "Hi, water is leaking under my kitchen sink." : answerTo(facts.chat[i - 1].relay, i, said);
    said.push(text);
    const before = await chatReplies(resident).count();
    await type(resident, resident.getByLabel("Message to Relay"), text, 24);
    await glide(resident, resident.getByRole("button", { name: "Send" }));
    s.mark(`sent-${i + 1}`);
    await resident.getByTestId("chat-pending").waitFor({ timeout: 20_000 }).catch(() => undefined);
    s.mark(`wait-${i + 1}`);
    await waitFor(async () => (await chatReplies(resident).count()) > before && !(await resident.getByTestId("chat-pending").isVisible()), 600_000, `Relay's reply ${i + 1}`);
    s.mark(`reply-${i + 1}`);
    facts.chat.push({ resident: text, relay: (await chatReplies(resident).last().innerText()).trim() });
    await sleep(5000);
  }
  await resident.getByText(/^Filed as RLY-\d{4}/).waitFor({ timeout: 60_000 });
  s.mark("filed");
  await s.focus("confirmation", resident.getByTestId("chat-log"));
  await sleep(4000);
  await glide(resident, resident.getByRole("button", { name: "Follow this request" }));
  await resident.waitForURL(/\/my\/cases\//);
  facts.leakCaseId = new URL(resident.url()).pathname.split("/").pop();
  await sleep(3500);
});
if (FROM <= 2) {
  log("waiting for Relay AI to review the new case", facts.leakCaseId);
  await coordinatorIdle(facts.leakCaseId, 900_000);
  const lc = await api("morgan", "getCase", { caseId: facts.leakCaseId });
  facts.leakStatus = lc.status;
  save();
  if (lc.status !== "AWAITING_ASSIGNMENT") throw new Error(`The leak case is ${lc.status}, not waiting for a vendor: look at the chat in facts.json, then record again from scratch.`);
}
const leakUrl = () => `/ops/cases/${facts.leakCaseId}`;

// ───────────────────────── 2. the manager: what Relay understood, proposed and did ─────────────────────────
if (FROM <= 2) await manager.goto("/ops");
await record(2, "02-manager-workspace", manager, async (s) => {
  await manager.getByRole("heading", { name: "Your move" }).waitFor();
  await sleep(2500);
  const leak = await api("morgan", "getCase", { caseId: facts.leakCaseId });
  facts.leakRef = leak.ref;
  await s.focus("your-move", manager.getByRole("heading", { name: "Your move" }).locator("xpath=ancestor::section[1]"));
  await sleep(3500);
  const link = manager.getByRole("link", { name: new RegExp(leak.ref) }).first();
  if (await link.isVisible().catch(() => false)) await glide(manager, link);
  else await manager.goto(leakUrl());
  await manager.waitForURL(/\/ops\/cases\//);
  await manager.getByTestId("next-action").waitFor();
  await sleep(2500);
  await s.focus("next-action", manager.getByTestId("next-action"));
  await sleep(4500);
  const reading = manager.getByTestId("reading");
  if (await reading.isVisible().catch(() => false)) await show(manager, s, "reading", reading, 6000, 140);
  const runs = manager.getByRole("button", { name: /What Relay did/ });
  await scrollTo(manager, runs, 200);
  await glide(manager, runs);
  await sleep(1500);
  await s.focus("runs", runs.locator("xpath=ancestor::section[1]"));
  s.mark("runs");
  await sleep(6500);
  const suggestion = manager.getByTestId("ai-suggestion").first();
  const proposed = (await suggestion.isVisible().catch(() => false)) ? (await suggestion.innerText()).slice(0, 500) : "";
  facts.proposalText = proposed || null;
  facts.escalationSuggested = (await manager.getByTestId("ai-suggestion").allInnerTexts()).some((x) => /Escalate/.test(x));
  // The AI may propose either approved plumber; the manager sends it if it is one of the two with a Relay login.
  facts.acceptedAiProposal = Object.keys(PLUMBERS).some((name) => proposed.includes(`Offer the job to ${name}`));
  if (facts.acceptedAiProposal) {
    await show(manager, s, "suggestion", suggestion, 6000, 200);
    await glide(manager, suggestion.getByRole("button", { name: "Send this offer" }));
  } else {
    await scrollTo(manager, manager.getByRole("heading", { name: "Assign a vendor" }), 120);
    await sleep(1500);
    await glide(manager, manager.getByText("Northside Plumbing", { exact: true }).first());
    await sleep(800);
    await glide(manager, manager.getByRole("button", { name: "Send the job offer" }));
  }
  await manager.getByRole("heading", { name: "Offer sent" }).waitFor({ timeout: 30_000 });
  await sleep(1200);
  await show(manager, s, "offer-sent", manager.getByRole("heading", { name: "Offer sent" }).locator("xpath=ancestor::section[1]"), 4000, 120);
  facts.vendorName = (await api("morgan", "getCase", { caseId: facts.leakCaseId })).assignment?.vendorName ?? null;
  facts.contractor = PLUMBERS[facts.vendorName] ?? null;
  if (!facts.contractor) throw new Error(`The offer went to ${facts.vendorName}, which has no demo login.`);
  facts.otherContractor = Object.values(PLUMBERS).find((u) => u !== facts.contractor);
});

// ───────────────────────── 4. the contractor reviews, accepts, estimates and proposes times ─────────────────────────
const contractor = await as(facts.contractor, PHONE);
if (FROM <= 4) {
  await contractor.goto("/jobs");
  await contractor.locator(`a[href="/jobs/${facts.leakCaseId}"]`).waitFor({ timeout: 30_000 });
}
await record(4, "04-contractor-accepts", contractor, async (s) => {
  await sleep(2500);
  await glide(contractor, contractor.locator(`a[href="/jobs/${facts.leakCaseId}"]`));
  await contractor.getByRole("heading", { name: "New job offer" }).waitFor();
  await sleep(2000);
  // The request as the resident described it, with Relay's summary.
  const issue = contractor.locator("main section").filter({ hasText: /kitchen sink|sink/i }).first();
  if (await issue.isVisible().catch(() => false)) await show(contractor, s, "request", issue, 4500, 90);
  await scrollTo(contractor, contractor.getByRole("heading", { name: "New job offer" }), 70);
  await sleep(1000);
  await type(contractor, contractor.getByLabel("Estimate (CAD, all in)"), "320", 90);
  await type(contractor, contractor.getByLabel("What it covers"), "Replace the P-trap and the supply line, parts and labour", 20);
  await sleep(500);
  await scrollTo(contractor, contractor.getByRole("button", { name: "Add another time" }), 360);
  await glide(contractor, contractor.getByRole("button", { name: "Add another time" }));
  await sleep(700);
  const day2 = new Date(Date.now() + 48 * 3600_000).toISOString().slice(0, 10);
  await contractor.getByLabel("Visit 2 date").fill(day2);
  await sleep(1500);
  await s.focus("times", contractor.getByRole("group", { name: "When can you come?" }));
  await sleep(3500);
  await glide(contractor, contractor.getByRole("button", { name: "Accept the job" }));
  await contractor.getByText(/waiting for the manager's approval/i).first().waitFor({ timeout: 30_000 });
  await sleep(1500);
  await s.focus("accepted", contractor.getByText(/waiting for the manager's approval/i).first());
  await sleep(4000);
});

// ───────────────────────── 5. the manager approves the money ─────────────────────────
if (FROM <= 5) {
  await manager.goto(leakUrl());
  await manager.getByRole("heading", { name: "Approve the estimate" }).waitFor({ timeout: 60_000 });
}
await record(5, "05-manager-approves", manager, async (s) => {
  await sleep(2000);
  await s.focus("next-action", manager.getByTestId("next-action"));
  await sleep(3500);
  const panel = manager.getByRole("heading", { name: "Approve the estimate" }).locator("xpath=ancestor::section[1]");
  await s.focus("approval", panel);
  await sleep(5000);
  const cap = manager.locator("#cap");
  await glide(manager, cap);
  await cap.fill("");
  await cap.pressSequentially("350", { delay: 90 });
  await sleep(900);
  await glide(manager, panel.getByRole("button", { name: /^Approve/ }));
  await manager.getByRole("heading", { name: "Approve the estimate" }).waitFor({ state: "hidden", timeout: 30_000 });
  await sleep(2000);
  await s.focus("authorized", manager.getByTestId("next-action"));
  await sleep(4500);
});

// ───────────────────────── 6. the resident picks a time ─────────────────────────
if (FROM <= 6) {
  await resident.goto(`/my/cases/${facts.leakCaseId}`);
  await resident.getByRole("heading", { name: "Choose a visit time" }).waitFor({ timeout: 60_000 });
}
await record(6, "06-resident-time", resident, async (s) => {
  await sleep(2000);
  await show(resident, s, "times", resident.getByRole("heading", { name: "Choose a visit time" }).locator("xpath=ancestor::section[1]"), 4000, 80);
  await glide(resident, resident.getByRole("button", { name: /Choose$/ }).first());
  await resident.getByText(/Visit confirmed/).first().waitFor({ timeout: 30_000 });
  await sleep(1500);
  await s.focus("confirmed", resident.getByText(/Visit confirmed/).first());
  await sleep(4000);
});

// ───────────────────────── 7. the contractor does the work ─────────────────────────
if (FROM <= 7) {
  await contractor.goto(`/jobs/${facts.leakCaseId}`);
  await contractor.getByRole("button", { name: "Start work" }).waitFor({ timeout: 60_000 });
}
await record(7, "07-contractor-completes", contractor, async (s) => {
  await sleep(2000);
  await glide(contractor, contractor.getByRole("button", { name: "Start work" }));
  await contractor.getByRole("heading", { name: "Work in progress" }).waitFor();
  await sleep(1500);
  await type(contractor, contractor.getByLabel("What did you do?"), "Replaced the P-trap and the supply line. Ran the water for 20 minutes: no drips.", 18);
  await sleep(600);
  await glide(contractor, contractor.getByRole("button", { name: "Mark work complete" }));
  await contractor.getByText("Waiting for the resident to confirm the fix.").waitFor({ timeout: 30_000 });
  await sleep(1500);
  await s.focus("done", contractor.getByText("Waiting for the resident to confirm the fix."));
  await sleep(4000);
});

// ───────────────────────── 8. completion is not resolution: the resident is asked ─────────────────────────
if (FROM <= 8) {
  await hook("deliver", { now: true });
  await resident.goto(`/my/cases/${facts.leakCaseId}`);
  await resident.getByRole("heading", { name: "Is it fixed?" }).waitFor({ timeout: 60_000 });
}
await record(8, "08-resident-followup", resident, async (s) => {
  await sleep(2000);
  await s.focus("ask", resident.getByRole("heading", { name: "Is it fixed?" }).locator("xpath=ancestor::section[1]"));
  await sleep(4500);
  const bell = resident.getByRole("button", { name: /Notifications/ });
  await glide(resident, bell);
  const popover = resident.locator("div.z-30").filter({ hasText: "Notifications" }).first();
  await popover.waitFor({ timeout: 20_000 });
  await sleep(1000);
  await s.focus("inbox", popover);
  await sleep(5000);
  await glide(resident, bell);
  await sleep(1200);
});

// ───────────────────────── 9. the same follow-up by email, in the local test inbox ─────────────────────────
const inboxContext = await browser.newContext({ ...DESKTOP });
await inboxContext.addInitScript(CURSOR);
const inbox = await inboxContext.newPage();
if (FROM <= 9) {
  await inbox.goto(MAILPIT);
  await inbox.getByText(/fixed\?/i).first().waitFor({ timeout: 60_000 });
}
await record(9, "09-mailpit", inbox, async (s) => {
  await sleep(2500);
  await glide(inbox, inbox.getByText(/fixed\?/i).first());
  await sleep(2500);
  await s.focus("email", inbox.locator("body"));
  await sleep(5000);
});

// ───────────────────────── 10. the resident confirms ─────────────────────────
if (FROM <= 10) {
  await resident.goto(`/my/cases/${facts.leakCaseId}`);
  await resident.getByRole("heading", { name: "Is it fixed?" }).waitFor();
}
await record(10, "10-resident-confirms", resident, async (s) => {
  await sleep(1500);
  await glide(resident, resident.getByRole("button", { name: "Yes, resolved" }));
  await resident.getByTestId("next-action").getByText(/Resolved/).first().waitFor({ timeout: 30_000 });
  await sleep(1200);
  await s.focus("resolved", resident.getByTestId("next-action"));
  await sleep(4000);
});

// ───────────────────────── 11. a repair that did not work: the case reopens ─────────────────────────
const daniel = await as("daniel", PHONE);
if (FROM <= 11) {
  await daniel.goto(`/my/cases/${facts.dishCaseId}`);
  await daniel.getByRole("heading", { name: "Is it fixed?" }).waitFor({ timeout: 60_000 });
}
await record(11, "11-not-fixed", daniel, async (s) => {
  await sleep(2000);
  await s.focus("ask", daniel.getByRole("heading", { name: "Is it fixed?" }).locator("xpath=ancestor::section[1]"));
  await sleep(3500);
  await type(daniel, daniel.getByLabel("What is still wrong"), "It stopped again after one cycle. Same problem as before.", 22);
  await glide(daniel, daniel.getByRole("button", { name: "No, still having problems" }));
  await waitFor(async () => !(await daniel.getByRole("heading", { name: "Is it fixed?" }).isVisible()), 30_000, "the case to reopen");
  await sleep(1500);
  const dc = await api("morgan", "getCase", { caseId: facts.dishCaseId });
  facts.notFixed = { status: dc.status, nextAction: dc.nextAction };
  await scrollTo(daniel, daniel.getByTestId("next-action"), 80);
  await s.focus("reopened", daniel.getByTestId("next-action"));
  await sleep(4500);
});

// ───────────────────────── 12. a vague report: Relay asks instead of guessing ─────────────────────────
const noor = await as("noor", PHONE);
if (FROM <= 12) {
  await noor.goto("/my/report");
  await noor.getByRole("tab", { name: "Chat with Relay" }).click().catch(() => undefined);
  await noor.getByLabel("Message to Relay").waitFor();
  // A fresh conversation: an earlier take may have left one open.
  const residentLines = noor.locator('[data-testid="chat-log"] > div.bg-ink');
  if ((await residentLines.count()) > 0) {
    await noor.getByRole("button", { name: "Start over" }).click();
    await waitFor(async () => (await residentLines.count()) === 0, 30_000, "a fresh conversation");
  }
}
await record(12, "12-vague", noor, async (s) => {
  await sleep(1200);
  const before = await chatReplies(noor).count();
  await type(noor, noor.getByLabel("Message to Relay"), "Something's not right in my apartment since yesterday and I'm not sure what it is.", 24);
  await glide(noor, noor.getByRole("button", { name: "Send" }));
  s.mark("sent-1");
  await noor.getByTestId("chat-pending").waitFor({ timeout: 20_000 }).catch(() => undefined);
  s.mark("wait-1");
  await waitFor(async () => (await chatReplies(noor).count()) > before && !(await noor.getByTestId("chat-pending").isVisible()), 600_000, "Relay's question");
  s.mark("reply-1");
  await sleep(1000);
  await s.focus("question", chatReplies(noor).last());
  await sleep(6000);
  facts.vagueReply = (await chatReplies(noor).last().innerText()).trim();
  facts.vagueFiled = await noor.getByText(/^Filed as RLY-\d{4}/).isVisible().catch(() => false);
});

// ───────────────────────── 13. a possible emergency and a lockout go to a person ─────────────────────────
if (FROM <= 13) {
  await manager.goto("/ops");
  await manager.getByRole("heading", { name: "Your move" }).waitFor();
}
await record(13, "13-safety", manager, async (s) => {
  await sleep(2000);
  await s.focus("attention", manager.getByRole("heading", { name: /Needs attention/ }).locator("xpath=ancestor::section[1]"));
  await sleep(4500);
  const ceiling = await api("morgan", "getCase", { caseId: facts.ceilingCaseId });
  const lockout = await api("morgan", "getCase", { caseId: facts.lockoutCaseId });
  facts.ceiling = { ref: ceiling.ref, status: ceiling.status, severity: ceiling.severity, emergency: ceiling.emergency, nextAction: ceiling.nextAction };
  facts.lockout = { ref: lockout.ref, status: lockout.status, severity: lockout.severity, nextAction: lockout.nextAction };
  await manager.goto(`/ops/cases/${facts.ceilingCaseId}`);
  await manager.getByTestId("next-action").waitFor();
  await sleep(2000);
  await s.focus("emergency", manager.getByTestId("next-action"));
  await sleep(4500);
  await manager.goto(`/ops/cases/${facts.lockoutCaseId}`);
  await manager.getByTestId("next-action").waitFor();
  await sleep(2000);
  await s.focus("lockout", manager.getByTestId("next-action"));
  await sleep(4500);
});

// ───────────────────────── 14. another contractor cannot open the job ─────────────────────────
const other = await as(facts.otherContractor, PHONE);
await record(14, "14-guard", other, async (s) => {
  await sleep(800);
  await other.goto(`/jobs/${facts.leakCaseId}`);
  await other.getByText(/not available/i).first().waitFor({ timeout: 30_000 });
  await sleep(1000);
  await s.focus("guard", other.getByText(/not available/i).first());
  await sleep(3500);
});

// ───────────────────────── 15. the manager's record of the whole case ─────────────────────────
if (FROM <= 15) {
  await manager.goto(leakUrl());
  await manager.getByTestId("timeline").waitFor();
}
await record(15, "15-final", manager, async (s) => {
  await sleep(2500);
  await s.focus("resolved", manager.getByTestId("next-action"));
  await sleep(4000);
  await show(manager, s, "timeline", manager.getByTestId("timeline"), 6000, 100);
  const followups = manager.getByTestId("followups");
  if (await followups.isVisible().catch(() => false)) await show(manager, s, "followups", followups, 5000, 120);
  const leak = await api("morgan", "getCase", { caseId: facts.leakCaseId });
  facts.final = { status: leak.status, events: leak.events.length, followUps: (leak.followUps ?? []).map((f) => ({ channel: f.channel, status: f.status, event: f.event })) };
});

await browser.close();
save();
log("done", JSON.stringify({ leak: facts.leakRef, acceptedAiProposal: facts.acceptedAiProposal, vagueFiled: facts.vagueFiled, notFixed: facts.notFixed }));
