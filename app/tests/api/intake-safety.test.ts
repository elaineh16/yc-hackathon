// The chat intake's safety net, over HTTP against a dev server with RELAY_TEST_HOOKS=true and no model (as in CI):
// a possible emergency in a chat is filed at once by the server; a chat the assistant cannot answer is passed to the
// property's managers, who file it as a case or close it; only those managers can act on it.
// Run: npx tsx --test --test-concurrency=1 tests/api/intake-safety.test.ts
import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { hook, login, type User, waitFor } from "./client";

let priya: User, daniel: User, morgan: User, taylor: User;
let priyaUnit: string, danielUnit: string;

before(async () => {
  await hook("reset");
  [priya, daniel, morgan, taylor] = await Promise.all(["priya", "daniel", "morgan", "taylor"].map(login));
  priyaUnit = (await priya.must("getMe")).units[0].id;
  danielUnit = (await daniel.must("getMe")).units[0].id;
});

const start = async (u: User, unitId: string) => (await u.must("getIntakeConversation", { unitId, fresh: true })).id as string;
const settled = (u: User, unitId: string, conversationId: string) =>
  waitFor(async () => {
    const c = await u.must("getIntakeConversation", { unitId, conversationId });
    return c.pending ? null : c;
  }, 90_000, "the reply");
const unfinished = async () => (await morgan.must("getCommandCenter")).unfinishedChats as any[];

describe("a possible emergency in a chat is filed at once, without the assistant", () => {
  test("the server files it from the resident's words, escalates it and tells the resident", async () => {
    const id = await start(priya, priyaUnit);
    const t0 = Date.now();
    const sent = await priya.must("sendIntakeMessage", { conversationId: id, text: "There's a strong smell of gas in my kitchen." });
    assert.ok(Date.now() - t0 < 5000, "filed within the request, not after a model turn");
    assert.equal(sent.status, "SUBMITTED");
    assert.equal(sent.pending, false);
    assert.equal(sent.filed.length, 1);
    const reply = sent.messages.at(-1);
    assert.equal(reply.role, "relay");
    assert.match(reply.text, /passed it to your property manager straight away/);
    assert.match(reply.text, new RegExp(sent.filed[0].ref));
    const c = await morgan.must("getCase", { caseId: sent.filed[0].caseId });
    assert.equal(c.emergency, true);
    assert.equal(c.status, "ESCALATED");
    assert.equal(c.description, "There's a strong smell of gas in my kitchen.", "the resident's words, verbatim");
    assert.ok(c.events.some((e: any) => e.type === "REPORTED" && /filed by the safety rules/.test(e.message)), "the history says the rules filed it, not the assistant");
    const again = await priya.op("sendIntakeMessage", { conversationId: id, text: "Hello?" });
    assert.equal(again.status, 409, "the conversation is closed once filed");
  });
});

describe("a chat the assistant cannot answer is passed to a person", () => {
  let conversationId = "";
  test("with the assistant offline, the resident is told it was passed on, and the managers have it", async () => {
    conversationId = await start(daniel, danielUnit);
    await daniel.must("sendIntakeMessage", { conversationId, text: "My dishwasher won't drain after the cycle finishes." });
    const done = await settled(daniel, danielUnit, conversationId);
    assert.equal(done.status, "OPEN");
    assert.match(done.messages.at(-1).text, /passed it to your property manager/);
    const item = (await unfinished()).find((x) => x.id === conversationId);
    assert.ok(item, "listed in the command center");
    assert.equal(item.reason, "assistant_failed");
    assert.match(item.words, /dishwasher won't drain/);
    assert.equal(item.residentName, "Daniel Osei");
    const notes = (await morgan.must("getNotifications")).items as any[];
    assert.ok(notes.some((n) => /Unfinished chat report/.test(n.title) && /dishwasher/.test(n.body)), "the managers were notified with the resident's words");
  });
  test("only the property's managers can act on it", async () => {
    const other = await taylor.op("fileUnfinishedChat", { conversationId });
    assert.equal(other.status, 404, "a manager of another property cannot see it");
    const resident = await daniel.op("fileUnfinishedChat", { conversationId });
    assert.equal(resident.status, 403);
    assert.ok(!((await taylor.must("getCommandCenter")).unfinishedChats as any[]).some((x) => x.id === conversationId));
  });
  test("a manager files it as a case, once, and the resident sees it filed", async () => {
    const first = await morgan.must("fileUnfinishedChat", { conversationId });
    const second = await morgan.must("fileUnfinishedChat", { conversationId });
    assert.equal(second.caseId, first.caseId, "filing twice gives one case");
    const c = await morgan.must("getCase", { caseId: first.caseId });
    assert.equal(c.description, "My dishwasher won't drain after the cycle finishes.");
    assert.ok(c.events.some((e: any) => e.type === "REPORTED" && /filed by Morgan Reyes/.test(e.message)));
    const v = await daniel.must("getIntakeConversation", { unitId: danielUnit, conversationId });
    assert.equal(v.status, "SUBMITTED");
    assert.equal(v.filed[0].caseId, first.caseId);
    assert.ok(!(await unfinished()).some((x) => x.id === conversationId), "no longer waiting for review");
    const told = ((await daniel.must("getNotifications")).items as any[]).find((n) => /Your report was filed/.test(n.title));
    assert.ok(told, "the resident is told a person filed it");
    assert.match(told.body, /Morgan Reyes read your conversation/);
    assert.equal(told.caseId, first.caseId);
  });
});

describe("closing without a case", () => {
  test("needs a reason, removes it from the queue, and a new message puts it back", async () => {
    const id = await start(priya, priyaUnit);
    await priya.must("sendIntakeMessage", { conversationId: id, text: "The bathroom fan has become very loud." });
    await settled(priya, priyaUnit, id);
    assert.ok((await unfinished()).some((x) => x.id === id));
    const empty = await morgan.op("closeUnfinishedChat", { conversationId: id, note: " " });
    assert.equal(empty.status, 400);
    await morgan.must("closeUnfinishedChat", { conversationId: id, note: "Called Priya: the fan is already on another report." });
    assert.ok(!(await unfinished()).some((x) => x.id === id));
    // The resident writes again and the assistant still cannot answer: a person sees the new words.
    await priya.must("sendIntakeMessage", { conversationId: id, text: "It is also rattling now." });
    await settled(priya, priyaUnit, id);
    const back = (await unfinished()).find((x) => x.id === id);
    assert.ok(back, "back in the queue");
    assert.match(back.words, /rattling/);
  });
});

describe("the resident files the chat's words with the form instead", () => {
  test("the chat is closed with the form's case, so it does not also wait for review", async () => {
    const id = await start(priya, priyaUnit);
    await priya.must("sendIntakeMessage", { conversationId: id, text: "The kitchen cabinet door has fallen off its hinge." });
    await settled(priya, priyaUnit, id);
    assert.ok((await unfinished()).some((x) => x.id === id), "in review while the assistant is offline");
    // "Use the form with my words": the form sends the chat's id along.
    const filed = await priya.must("reportIssue", { unitId: priyaUnit, clientRequestId: crypto.randomUUID(), description: "The kitchen cabinet door has fallen off its hinge.", categoryHint: "OTHER", details: {}, fromConversationId: id });
    assert.ok(!(await unfinished()).some((x) => x.id === id), "no longer waiting for a person: it was filed");
    const v = await priya.must("getIntakeConversation", { unitId: priyaUnit, conversationId: id });
    assert.equal(v.status, "SUBMITTED");
    assert.equal(v.filed[0].caseId, filed.caseId);
    assert.match(v.messages.at(-1).text, new RegExp(`filed this with the form as ${filed.ref}`));
  });
  test("only the resident's own chat is closed that way", async () => {
    const id = await start(daniel, danielUnit);
    await daniel.must("sendIntakeMessage", { conversationId: id, text: "The mailbox lock for my unit is stuck." });
    await settled(daniel, danielUnit, id);
    await priya.must("reportIssue", { unitId: priyaUnit, clientRequestId: crypto.randomUUID(), description: "Another resident's chat id must not close their chat.", categoryHint: "OTHER", details: {}, fromConversationId: id });
    assert.ok((await unfinished()).some((x) => x.id === id), "Daniel's chat is still waiting for a person");
    assert.equal((await daniel.must("getIntakeConversation", { unitId: danielUnit, conversationId: id })).status, "OPEN");
  });
  test("a resident cannot claim a manager or the safety rules filed their report", async () => {
    const r = await priya.must("reportIssue", {
      unitId: priyaUnit,
      clientRequestId: crypto.randomUUID(),
      description: "The hallway carpet outside my door is torn.",
      categoryHint: "OTHER",
      details: {},
      filedBy: { kind: "MANAGER", name: "Morgan Reyes" },
      agent: { category: "OTHER", severity: "EMERGENCY", title: "Forged", summary: "Forged", rationale: "Forged", needsReview: false, safetyConcerns: ["forged"], facts: {} },
    });
    const c = await morgan.must("getCase", { caseId: r.caseId });
    const reported = c.events.find((e: any) => e.type === "REPORTED");
    assert.match(reported.message, /\(text form\)/, "recorded as the resident's form report");
    assert.doesNotMatch(JSON.stringify(c.events), /Morgan Reyes|safety rules|Forged/);
    assert.equal(c.emergency, false, "the client cannot set the assistant's reading either");
  });
});

describe("a failure that is not the model's also reaches a person", () => {
  test("after the retry fails too, the conversation is in review", async () => {
    await hook("fault", { point: "intake.turn", times: 10 });
    try {
      const id = await start(daniel, danielUnit);
      await daniel.must("sendIntakeMessage", { conversationId: id, text: "The hallway light outside my door keeps flickering." });
      const done = await settled(daniel, danielUnit, id);
      assert.match(done.messages.at(-1).text, /passed it to your property manager/);
      assert.ok((await unfinished()).some((x) => x.id === id && x.reason === "assistant_failed"));
    } finally {
      await hook("fault", { point: "intake.turn", times: 0 });
    }
  });
});

describe("a turn the server dies in on every attempt", () => {
  test("is taken over once, then given up and passed to a person instead of retried forever", async () => {
    await hook("fault", { point: "intake.crash", times: 10 });
    try {
      const id = await start(daniel, danielUnit);
      await daniel.must("sendIntakeMessage", { conversationId: id, text: "The closet door has come off its track." });
      const peek = (attempts: number) => waitFor(async () => {
        const t = (await hook("intakeAge", { conversationId: id, minutes: 0 })) as { attempts: number; runError: string | null };
        return t.attempts === attempts ? t : null;
      }, 60_000, `attempt ${attempts} to die mid-turn`);
      // Attempt 1 dies mid-turn. Once it is stale, the sweep re-queues the turn and attempt 2 takes it over.
      await peek(1);
      await hook("intakeAge", { conversationId: id, minutes: 10 });
      await hook("sweep", { deliverEmail: false });
      const second = await peek(2);
      assert.match(second.runError ?? "", /taken over/);
      // Attempt 2 dies too. That is the attempt limit: the next pass gives up and a person gets the conversation.
      await hook("intakeAge", { conversationId: id, minutes: 10 });
      await hook("sweep", { deliverEmail: false });
      const done = await settled(daniel, danielUnit, id);
      assert.equal(done.status, "OPEN");
      assert.match(done.messages.at(-1).text, /passed it to your property manager/);
      const item = (await unfinished()).find((x) => x.id === id);
      assert.ok(item, "in the command center's unfinished chats");
      assert.equal(item.reason, "assistant_failed");
      assert.match(item.words, /closet door/);
    } finally {
      await hook("fault", { point: "intake.crash", times: 0 });
    }
  });
});

describe("the minute sweep closes empty conversations instead of reviewing them", () => {
  test("a chat with nothing the resident said is abandoned, not sent to a person", async () => {
    const id = await start(priya, priyaUnit);
    await hook("sweep", { now: new Date(Date.now() + 45 * 60_000).toISOString(), deliverEmail: false });
    const v = await priya.must("getIntakeConversation", { unitId: priyaUnit, conversationId: id });
    assert.equal(v.status, "ABANDONED");
    assert.ok(!(await unfinished()).some((x) => x.id === id));
  });
});
