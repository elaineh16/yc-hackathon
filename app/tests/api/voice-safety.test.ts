// The intake safety net for voice calls, over HTTP against a dev server with RELAY_TEST_HOOKS=true (no ElevenLabs
// needed: these are the events the resident's browser forwards during a call, and the agent's submit_report).
// A call runs between the browser and ElevenLabs, so before this, a call that dropped or was hung up before the agent
// filed anything left nothing in Relay. Now each line is kept; a possible emergency is filed at once by the rules; a
// call that ends unfiled, or goes silent, reaches a person; and the agent's own filing closes the call, once.
// Run: npx tsx --test --test-concurrency=1 tests/api/voice-safety.test.ts
import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { hook, login, rid, type User } from "./client";

let priya: User, daniel: User, morgan: User, taylor: User;
let priyaUnit: string, danielUnit: string;

before(async () => {
  await hook("reset");
  [priya, daniel, morgan, taylor] = await Promise.all(["priya", "daniel", "morgan", "taylor"].map(login));
  priyaUnit = (await priya.must("getMe")).units[0].id;
  danielUnit = (await daniel.must("getMe")).units[0].id;
});

/** One call, as the browser reports it. */
function call(u: User, unitId: string, attemptId = rid()) {
  const send = (kind: string, extra: Record<string, unknown> = {}) => u.must("recordVoiceEvent", { unitId, attemptId, kind, ...extra });
  return {
    attemptId,
    connected: (callId = `conv_${attemptId}`) => send("connected", { callId }),
    relay: (text: string) => send("relay", { text }),
    resident: (text: string) => send("resident", { text }),
    ended: () => send("ended"),
    // The agent's submit_report, as the client tool sends it (the call's id is the request id).
    submit: (reading: Record<string, unknown>) => u.must("submitVoiceReport", { unitId, clientRequestId: attemptId, ...reading }),
  };
}
const routine = (description: string, category = "PLUMBING") => ({ description, category, severity: "ROUTINE", title: "Kitchen sink dripping", summary: description, rationale: "A slow leak with nothing at risk." });
const unfinished = async (u: User = morgan) => (await u.must("getCommandCenter")).unfinishedChats as any[];

describe("a possible emergency said on a call is filed at once, by the rules", () => {
  test("the resident's words are filed and escalated within the request, before the agent files anything", async () => {
    const c = call(priya, priyaUnit);
    await c.connected();
    await c.relay("Hi Priya, I'm Relay, an AI assistant for Maple Court. What's going on?");
    const quiet = await c.resident("Hi, I'm in my kitchen.");
    assert.equal(quiet.filed, null, "nothing to file yet");
    const t0 = Date.now();
    const r = await c.resident("There's a strong smell of gas in here.");
    assert.ok(Date.now() - t0 < 5000, "filed within the request");
    assert.ok(r.filed?.caseId, "filed by the safety net");
    assert.match(r.filed.message, /saved as RLY-\d{4}/);
    assert.match(r.filed.message, /Leave the unit now/, "the rules' safety advice");
    const k = await morgan.must("getCase", { caseId: r.filed.caseId });
    assert.equal(k.emergency, true);
    assert.equal(k.status, "ESCALATED");
    assert.equal(k.channel, "VOICE");
    assert.equal(k.description, "Hi, I'm in my kitchen. There's a strong smell of gas in here.", "the resident's words, verbatim (whitespace joined, as for every report), and only theirs");
    assert.ok(k.events.some((e: any) => e.type === "REPORTED" && /voice call with Relay's assistant, filed by the safety rules/.test(e.message)));

    // The agent then files too (its prompt says to, at once, for danger): the same case, not a second one.
    const agent = await c.submit({ description: "Strong smell of gas in the kitchen.", category: "OTHER", severity: "EMERGENCY", title: "Gas smell in kitchen", summary: "The resident smells gas.", rationale: "Gas smell.", safety_concerns: ["gas smell"] });
    assert.equal(agent.caseId, r.filed.caseId, "one case either way");
    assert.equal(agent.duplicate, true);
    assert.match(agent.message, /saved as RLY-\d{4}/, "the agent is told it is saved, and says so");
    const ended = await c.ended();
    assert.equal(ended.passed, false, "nothing for a person to review: it is filed");
    assert.equal(ended.filed.caseId, r.filed.caseId);
    assert.ok(!(await unfinished()).some((x) => x.id === r.conversationId));
  });
});

describe("a call that ends with nothing filed goes to a person at once", () => {
  let conversationId = "";
  test("the managers have the resident's words, and the resident is told", async () => {
    const c = call(daniel, danielUnit);
    await c.connected("conv_test_dropped");
    await c.relay("Hi Daniel, I'm Relay, an AI assistant for Maple Court. What's going on?");
    await c.resident("My dishwasher won't drain after the cycle finishes.");
    await c.relay("When did that start?");
    const r = await c.ended();
    conversationId = r.conversationId;
    assert.equal(r.passed, true, "a person has it");
    assert.equal(r.filed, null);
    const item = (await unfinished()).find((x) => x.id === conversationId);
    assert.ok(item, "in the command center's unfinished reports");
    assert.equal(item.channel, "VOICE");
    assert.equal(item.reason, "call_ended");
    assert.equal(item.reasonText, "The voice call ended before anything was filed");
    assert.equal(item.words, "My dishwasher won't drain after the cycle finishes.", "the resident's lines only");
    assert.equal(item.residentName, "Daniel Osei");
    const notes = (await morgan.must("getNotifications")).items as any[];
    assert.ok(notes.some((n) => /Unfinished voice report/.test(n.title) && /They said: "My dishwasher/.test(n.body)), "the managers are notified with the resident's words");
    const again = await c.ended();
    assert.equal(again.passed, true, "a repeated end is harmless");
    assert.equal((await unfinished()).filter((x) => x.id === conversationId).length, 1);
  });
  test("only the property's managers can act on it, and nobody else can write into the call", async () => {
    assert.equal((await taylor.op("fileUnfinishedChat", { conversationId })).status, 404, "a manager of another property");
    assert.equal((await daniel.op("fileUnfinishedChat", { conversationId })).status, 403);
    assert.equal((await morgan.op("recordVoiceEvent", { unitId: danielUnit, attemptId: rid(), kind: "ended" })).status, 403, "only residents record calls");
    assert.equal((await priya.op("recordVoiceEvent", { unitId: danielUnit, attemptId: rid(), kind: "resident", text: "hello" })).status, 403, "only for a unit you live in");
  });
  test("a manager files it as a case, and the resident is told a person read the call", async () => {
    const first = await morgan.must("fileUnfinishedChat", { conversationId });
    const k = await morgan.must("getCase", { caseId: first.caseId });
    assert.equal(k.channel, "VOICE");
    assert.equal(k.description, "My dishwasher won't drain after the cycle finishes.");
    assert.ok(k.events.some((e: any) => e.type === "REPORTED" && /voice call with Relay's assistant, filed by Morgan Reyes/.test(e.message)));
    assert.ok(!(await unfinished()).some((x) => x.id === conversationId));
    const told = ((await daniel.must("getNotifications")).items as any[]).find((n) => /Your report was filed/.test(n.title) && n.caseId === first.caseId);
    assert.ok(told);
    assert.match(told.body, /Morgan Reyes read the transcript of your call/);
  });
});

describe("when the voice agent files, the call is closed with its case", () => {
  test("the end of the call goes to no one", async () => {
    const c = call(priya, priyaUnit);
    await c.connected();
    await c.resident("The kitchen sink is dripping under the cabinet.");
    await c.relay("Just to confirm: the kitchen sink is dripping under the cabinet. Shall I file it?");
    await c.resident("Yes please.");
    const filed = await c.submit(routine("The kitchen sink is dripping under the cabinet."));
    assert.equal(filed.duplicate, false);
    const r = await c.ended();
    assert.equal(r.passed, false);
    assert.equal(r.filed.caseId, filed.caseId);
    assert.ok(!(await unfinished()).some((x) => x.id === r.conversationId));
  });
  test("calling back after a dropped call continues the same report, and the agent's filing settles its review", async () => {
    const c = call(daniel, danielUnit);
    await c.resident("The bathroom fan has become very loud.");
    const dropped = await c.ended();
    assert.equal(dropped.passed, true);
    assert.ok((await unfinished()).some((x) => x.id === dropped.conversationId));
    // The resident calls again from the same page: the same report.
    await c.connected("conv_second_call");
    await c.resident("It's the bathroom fan again, it rattles when it runs.");
    const filed = await c.submit(routine("The bathroom fan is loud and rattles when it runs.", "HVAC"));
    assert.ok(!(await unfinished()).some((x) => x.id === dropped.conversationId), "no longer waiting for a person");
    const alerts = ((await morgan.must("getNotifications")).items as any[]).filter((n) => /Unfinished voice report/.test(n.title) && /bathroom fan/.test(n.body));
    assert.ok(alerts.length > 0 && alerts.every((n) => n.acknowledged), "the review alert is settled, so it never shows as overdue");
    const r = await c.ended();
    assert.equal(r.filed.caseId, filed.caseId);
    assert.equal(r.passed, false);
  });
  test("danger the resident describes after a non-emergency filing reaches the managers at once", async () => {
    const c = call(priya, priyaUnit);
    await c.resident("The kitchen sink is dripping a little.");
    const filed = await c.submit(routine("The kitchen sink is dripping a little."));
    const k0 = await morgan.must("getCase", { caseId: filed.caseId });
    assert.equal(k0.emergency, false);
    await c.resident("Oh no, now the water is dripping onto the outlet under the sink and it's sparking.");
    const warned = ((await morgan.must("getNotifications")).items as any[]).filter((n) => n.caseId === filed.caseId && /Possible emergency on RLY-\d{4}/.test(n.title));
    assert.equal(warned.length, 1, "the managers are warned on that case");
    assert.equal(warned[0].kind, "EMERGENCY");
    assert.match(warned[0].body, /sparking/);
    await c.resident("It's still sparking.");
    const again = ((await morgan.must("getNotifications")).items as any[]).filter((n) => n.caseId === filed.caseId && /Possible emergency/.test(n.title));
    assert.equal(again.length, 1, "once per call");
    const k1 = await morgan.must("getCase", { caseId: filed.caseId });
    assert.equal(k1.severity, k0.severity, "a person decides: nothing on the case changes by itself");
  });
});

describe("a call that goes silent without ending reaches a person from the minute sweep", () => {
  test("after a few minutes of silence (a closed tab, a crash), not the chat's half hour", async () => {
    const c = call(daniel, danielUnit);
    const r = await c.resident("The front door lock is jammed and I can't lock it.");
    await hook("sweep", { now: new Date(Date.now() + 60_000).toISOString(), deliverEmail: false });
    assert.ok(!(await unfinished()).some((x) => x.id === r.conversationId), "not after one minute: the call may still be live");
    await hook("sweep", { now: new Date(Date.now() + 6 * 60_000).toISOString(), deliverEmail: false });
    const item = (await unfinished()).find((x) => x.id === r.conversationId);
    assert.ok(item, "after five quiet minutes");
    assert.equal(item.reason, "call_ended");
  });
  test("a call where the resident said nothing is closed, not sent to a person", async () => {
    const c = call(priya, priyaUnit);
    const r = await c.relay("Hi Priya, I'm Relay, an AI assistant for Maple Court. What's going on?");
    const ended = await c.ended();
    assert.equal(ended.passed, false, "nothing to read");
    await hook("sweep", { now: new Date(Date.now() + 10 * 60_000).toISOString(), deliverEmail: false });
    assert.ok(!(await unfinished()).some((x) => x.id === r.conversationId));
  });
});

describe("calls and chats stay apart", () => {
  test("the chat page never opens a call's transcript, and a chat message cannot be sent into a call", async () => {
    const c = call(priya, priyaUnit);
    const r = await c.resident("The hallway light keeps flickering.");
    const chat = await priya.must("getIntakeConversation", { unitId: priyaUnit });
    assert.notEqual(chat.id, r.conversationId);
    assert.ok(!chat.messages.some((m: any) => /flickering/.test(m.text)));
    assert.equal((await priya.op("getIntakeConversation", { unitId: priyaUnit, conversationId: r.conversationId })).data?.id === r.conversationId, false);
    assert.equal((await priya.op("sendIntakeMessage", { conversationId: r.conversationId, text: "hello" })).status, 404);
    // Starting a fresh chat does not close the call.
    await priya.must("getIntakeConversation", { unitId: priyaUnit, fresh: true });
    assert.equal((await c.ended()).passed, true, "the call was still open, and now goes to a person");
  });
  test("another resident's call id gives them their own record, never the other resident's", async () => {
    const c = call(daniel, danielUnit);
    await c.resident("My radiator is cold.");
    const theirs = call(priya, priyaUnit, c.attemptId);
    const mine = await theirs.resident("Hello?");
    const dan = await c.ended();
    assert.notEqual(mine.conversationId, dan.conversationId);
    const item = (await unfinished()).find((x) => x.id === dan.conversationId);
    assert.equal(item.words, "My radiator is cold.", "untouched by the other resident");
  });
  test("malformed events are refused", async () => {
    assert.equal((await priya.op("recordVoiceEvent", { unitId: priyaUnit, attemptId: rid(), kind: "hacked" })).status, 400);
    assert.equal((await priya.op("recordVoiceEvent", { unitId: priyaUnit, attemptId: "short", kind: "ended" })).status, 400);
    assert.equal((await priya.op("recordVoiceEvent", { unitId: priyaUnit, attemptId: rid(), kind: "resident", text: "   " })).status, 400);
  });
});
