// End-to-end check of the running Wasp server over HTTP: the same endpoints the pages and ElevenLabs use.
// No phones, no ElevenLabs, no contractors. Usage (server running, SIM_STEP_MS small for speed):
//   SMOKE_CONFIRM_RESET=yes npx tsx scripts/smoke.ts     (reads RELAY_TOOL_SECRET and OPERATOR_PIN from .env.server if unset)
// Exits non-zero if any check fails.
// WARNING: it calls resetDemo repeatedly, which WIPES every work order and session in that server's database.
// Never point it at a database you are rehearsing or recording with: it refuses to run without SMOKE_CONFIRM_RESET=yes.
import { readFileSync } from "node:fs";

const BASE = process.env.BASE_URL || "http://localhost:3001";
const fromEnvFile = (key: string) => {
  try {
    return readFileSync(".env.server", "utf8").match(new RegExp(`^${key}=(.*)$`, "m"))?.[1]?.trim() ?? "";
  } catch {
    return "";
  }
};
const SECRET = process.env.RELAY_TOOL_SECRET || fromEnvFile("RELAY_TOOL_SECRET");
const PIN = process.env.OPERATOR_PIN ?? fromEnvFile("OPERATOR_PIN");
if (process.env.SMOKE_CONFIRM_RESET !== "yes") {
  console.error(`Refusing to run: this WIPES the demo database behind ${BASE}. Re-run with SMOKE_CONFIRM_RESET=yes if that is intended.`);
  process.exit(2);
}

let failures = 0;
const check = (ok: unknown, what: string) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${what}`);
  if (!ok) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const OPERATOR_OPS = new Set(["staffAccept", "staffMarkRetrieved", "staffMarkUnavailable", "approveRepair", "denyRepair", "simulateConfirmation", "resetDemo"]);

/** Calls a Wasp query/action the way the client does (superjson body). Operator actions carry the PIN when one is set. */
async function op(name: string, args?: unknown, opts: { withPin?: boolean } = {}): Promise<{ status: number; data: any; error?: string }> {
  const withPin = opts.withPin ?? true;
  const payload = PIN && withPin && OPERATOR_OPS.has(name) ? { ...((args as object) ?? {}), operatorPin: PIN } : (args ?? null);
  const res = await fetch(`${BASE}/operations/${kebab(name)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ json: payload }),
  });
  const body: any = await res.json().catch(() => ({}));
  return res.ok ? { status: res.status, data: body.json } : { status: res.status, data: null, error: body.message };
}
async function intake(body: Record<string, unknown>, secret: string | null = SECRET) {
  const res = await fetch(`${BASE}/api/relay/intake`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(secret === null ? {} : { "X-Relay-Secret": secret }) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}
const demoReport = (sid: string, extra: Record<string, unknown> = {}) => ({
  demo_session_id: sid,
  residence: "MKV",
  room: "main laundry room",
  washer: "washer 2",
  symptom: "Washer won't drain; clothes stuck inside",
  floor_status: "dry",
  error_code: "OE",
  safety_hazard: false,
  ...extra,
});
const dash = async () => (await op("getOperatorDashboard")).data;
const student = async (sid: string) => (await op("getStudentStatus", { sessionId: sid })).data;
async function waitFor(what: string, pred: () => Promise<boolean>, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return true;
    await sleep(500);
  }
  console.log(`  (timed out waiting for ${what})`);
  return false;
}
const newSession = async () => (await op("createDemoSession")).data.sessionId as string;

if (!SECRET) {
  console.error("Set RELAY_TOOL_SECRET (or run from the app folder with .env.server).");
  process.exit(2);
}
const health = await (await fetch(`${BASE}/health`)).json();
check(health.ok && health.db === "up" && health.intakeConfigured, `GET /health ok, db up, intake configured`);
await op("resetDemo");

console.log("\n1. Voice intake saves one work order");
const A = await newSession();
const B = await newSession();
check((await intake(demoReport(A), null)).status === 401, "no secret -> 401");
check((await intake(demoReport(A), "wrong")).status === 401, "wrong secret -> 401");
const bad = await intake({ demo_session_id: A, residence: "MKV" });
check(bad.status === 400 && bad.body.fields.includes("washer") && /NOT saved/.test(bad.body.message), "missing fields -> 400, agent told NOT saved");
check((await intake(demoReport("00000000-0000-0000-0000-000000000000"))).status === 404, "unknown session -> 404");
const first = await intake(demoReport(A));
check(first.status === 201 && first.body.created && /saved/.test(first.body.message), `intake saved (201, #${first.body.work_order_number})`);
const woId = first.body.work_order_id;
const retry = await intake(demoReport(A));
check(retry.status === 200 && retry.body.duplicate && retry.body.work_order_id === woId, "identical retry is a no-op on the same order");
const repeat = await intake(demoReport(A, { symptom: "Washer won't drain, door locked, clothes inside" }));
check(repeat.body.work_order_id === woId && repeat.body.created === false, "repeat report for the same washer updates the existing order");

let d = await dash();
check(d.workOrder?.id === woId && d.openWorkOrders === 1, "dashboard shows the same single work order");
check(d.workOrder.location === "MKV · Main Laundry Room · Washer 2" && d.workOrder.reportedErrorCode === "OE" && d.workOrder.floorStatus === "DRY", `details: ${d.workOrder.location}, OE, dry floor`);
check(d.workOrder.staff.status === "REQUESTED", "staff request created (REQUESTED)");
check(d.workOrder.timeline.filter((e: any) => e.type === "intake.saved").length === 1, "one intake.saved event");
check((await student(A)).workOrder?.id === woId, "student A sees their work order");
check((await student(B)).sessionValid && (await student(B)).workOrder === null, "student B cannot see A's work order");
{
  // A reopened page (new session C) reporting the same washer takes the order over; A no longer sees it.
  const C = await newSession();
  const r = await intake(demoReport(C, { symptom: "Washer won't drain, door locked, clothes inside" }));
  check(r.body.work_order_id === woId && (await student(C)).workOrder?.id === woId && (await student(A)).workOrder === null, "repeat report from a reopened page moves the order to that page");
  await intake(demoReport(A, { symptom: "Washer won't drain, door locked, clothes inside" }));
  check((await student(A)).workOrder?.id === woId, "order follows the latest reporting session");
}

console.log("\n1b. Operator PIN");
if (PIN) {
  check((await op("staffAccept", { workOrderId: woId, etaMinutes: 15 }, { withPin: false })).status === 401, "staff action without the PIN -> 401");
  check((await op("approveRepair", { workOrderId: woId, capCents: 40_000, operatorPin: "00000000-wrong" }, { withPin: false })).status === 401, "manager action with a wrong PIN -> 401");
  check((await op("resetDemo", undefined, { withPin: false })).status === 401, "reset without the PIN -> 401");
  check((await dash()).workOrder?.staff.status === "REQUESTED", "refused actions changed nothing");
} else {
  check(true, "no OPERATOR_PIN set on this server: dashboard actions are open (PIN checks skipped)");
}

console.log("\n2. Guards before approval");
check((await op("simulateConfirmation", { workOrderId: woId })).status === 409, "confirmation before approval -> 409");
check((await op("approveRepair", { workOrderId: woId, capCents: 40_000 })).status === 409, "approval before a recommendation -> 409");

console.log("\n3. Staff lane");
check((await op("staffAccept", { workOrderId: woId, etaMinutes: 15 })).status === 200, "staff accepts with 15-minute ETA");
check((await op("staffAccept", { workOrderId: woId, etaMinutes: 15 })).data?.idempotent, "second accept is idempotent");
check((await student(A)).workOrder.staffLabel === "Staff on the way · 15 minutes", "student sees 'Staff on the way · 15 minutes'");

console.log("\n4. Simulated contractor outcomes and recommendation");
check(await waitFor("PENDING_APPROVAL", async () => (await dash()).workOrder.repairStatus === "PENDING_APPROVAL"), "repair reaches PENDING_APPROVAL");
d = await dash();
const by = Object.fromEntries(d.workOrder.contractors.map((c: any) => [c.contractorKey, c]));
check(d.workOrder.contractors.length === 3 && d.workOrder.contractors.every((c: any) => c.simulated), "three results, all labelled simulated");
check(by.bluejay?.priceCents === 32_900 && by.bluejay.recommended, "Bluejay $329 recommended");
check(by.quickfix?.scope === "DIAGNOSTIC" && by.quickfix.priceCents === 9_900 && !by.quickfix.recommended, "QuickFix $99 diagnostic-only, not compared as a repair");
check(by.metro?.outcome === "VOICEMAIL" && by.metro.priceCents === null && by.metro.availability === null, "Metro voicemail: price and availability unknown");
check(/Bluejay/.test(d.workOrder.recommendation ?? ""), "recommendation explains Bluejay");
check(d.workOrder.decision?.status === "PENDING" && d.workOrder.decision.estimateCents === 32_900 && d.workOrder.decision.autoApproveLimitCents === 25_000, "approval pending: $329 > $250 threshold");

console.log("\n5. Clothes retrieved while the repair is still pending");
check((await op("staffMarkRetrieved", { workOrderId: woId })).status === 200, "staff marks clothes retrieved");
let s = await student(A);
check(s.workOrder.staffLabel === "Clothes retrieved" && s.workOrder.repairStatus === "PENDING_APPROVAL", "student: clothes retrieved; repair still pending approval");
check((await op("simulateConfirmation", { workOrderId: woId })).status === 409, "confirmation still refused before approval");

console.log("\n6. Manager approves the $400 all-in cap");
check((await op("approveRepair", { workOrderId: woId, capCents: 30_000 })).status === 400, "cap below the estimate -> 400");
check((await op("approveRepair", { workOrderId: woId, capCents: 40_000, approver: "Manager", note: "Conditional on diagnosis" })).status === 200, "approve up to $400");
check((await op("approveRepair", { workOrderId: woId, capCents: 40_000 })).data?.idempotent, "second approve is idempotent");
check((await op("denyRepair", { workOrderId: woId })).status === 409, "deny after approve -> 409");
d = await dash();
check(d.workOrder.decision.approvedCapCents === 40_000 && d.workOrder.decision.estimateCents === 32_900, "cap $400 and estimate $329 stored separately");
check(d.workOrder.repairStatus === "CONFIRMATION_PENDING" && d.workOrder.appointment === null, "awaiting simulated confirmation, no appointment yet");

console.log("\n7. Simulated confirmation");
check((await op("simulateConfirmation", { workOrderId: woId })).status === 200, "simulate confirmation");
check((await op("simulateConfirmation", { workOrderId: woId })).data?.idempotent, "second confirmation is idempotent");
d = await dash();
check(d.workOrder.repairStatus === "CONFIRMED" && d.workOrder.appointment?.simulated && d.workOrder.appointment.contractorName === "Bluejay", `appointment (simulated): ${d.workOrder.appointment?.arrivalWindow}`);
const types = d.workOrder.timeline.map((e: any) => e.type);
check(new Set(types).size === types.length, `no duplicate timeline events (${types.length} events)`);
s = await student(A);
check(s.workOrder.appointment?.arrivalWindow && /Bluejay arriving/.test(s.workOrder.latest.message), `student sees: ${s.workOrder.latest?.message}`);
check(s.workOrder.staffLabel === "Clothes retrieved", "staff outcome still visible");

console.log("\n8. Reset");
check((await op("resetDemo")).status === 200, "reset");
check((await student(A)).sessionValid === false, "old student session is invalid after reset");
check((await dash()).workOrder === null, "dashboard empty after reset");

console.log("\n9. Denial keeps the appointment unconfirmed");
{
  const sid = await newSession();
  const id = (await intake(demoReport(sid))).body.work_order_id;
  await waitFor("PENDING_APPROVAL", async () => (await dash()).workOrder.repairStatus === "PENDING_APPROVAL");
  check((await op("denyRepair", { workOrderId: id, approver: "Manager", note: "Get a second quote" })).status === 200, "manager denies");
  check((await op("simulateConfirmation", { workOrderId: id })).status === 409, "confirmation after denial -> 409");
  const st = await student(sid);
  check(st.workOrder.repairStatus === "DENIED" && st.workOrder.appointment === null, "student: not approved, no appointment");
}

console.log("\n10. Staff unavailable -> manager takes over retrieval");
{
  await op("resetDemo");
  const sid = await newSession();
  const id = (await intake(demoReport(sid))).body.work_order_id;
  check((await op("staffMarkUnavailable", { workOrderId: id, reason: "No one on shift" })).status === 200, "staff unavailable");
  check(/manager is arranging retrieval/.test((await student(sid)).workOrder.staffLabel), "student told the manager is arranging retrieval");
  check((await op("staffMarkRetrieved", { workOrderId: id })).status === 200, "manager-arranged retrieval recorded");
}

console.log("\n10b. No-voice fallback (only if the server sets ALLOW_TEST_REPORT=true)");
{
  await op("resetDemo");
  const sid = await newSession();
  const t = await op("submitTestReport", { sessionId: sid });
  if (t.status === 403) check(true, "test report refused: ALLOW_TEST_REPORT is off");
  else {
    const dd = await dash();
    check(t.status === 200 && (await student(sid)).workOrder?.id === t.data.workOrderId, "test report saved and shown on that student page");
    check(dd.workOrder.timeline.some((e: any) => /typed test report \(no voice\)/.test(e.message)), "timeline labels it a test report, not voice");
  }
}

console.log("\n11. Safety hazard stops the normal flow");
{
  await op("resetDemo");
  const sid = await newSession();
  const r = await intake(demoReport(sid, { floor_status: "water on the floor", safety_hazard: true, hazard_details: "Water spreading toward an outlet" }));
  check(r.status === 201 && r.body.safety_escalated && /safety/.test(r.body.message), "hazard intake saved and escalated");
  await sleep(1500);
  const dd = await dash();
  check(dd.workOrder.repairStatus === "ESCALATED" && dd.workOrder.staff.priority === "SAFETY" && dd.workOrder.contractors.length === 0, "no contractor outreach; staff request is SAFETY priority");
}
await op("resetDemo");

console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll Relay checks passed");
process.exit(failures ? 1 : 0);
