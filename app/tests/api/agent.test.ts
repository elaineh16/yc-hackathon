// The agents against the real model (no stubs). Slow on a CPU-only machine: several minutes.
// If no model is reachable the tests are skipped with the reason; nothing is faked.
// Run: npm run test:api -- tests/api/agent.test.ts   (dev server running with RELAY_TEST_HOOKS=true; resets cases)
import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { hook, login, sleep, type User } from "./client";

let priya: User, morgan: User;
let unitId = "";
let caseId = "";
let available = false;
let reason = "";

before(async () => {
  await hook("reset");
  [priya, morgan] = await Promise.all(["priya", "morgan"].map(login));
  unitId = (await priya.must("getMe")).units[0].id;
  const s = await priya.must("getAiStatus");
  available = s.available;
  reason = s.reason;
});

describe("intake agent", () => {
  test("converses in natural language, then files the case only through the server", async (t) => {
    if (!available) return t.skip(`no model: ${reason}`);
    let v = await priya.must("getIntakeConversation", { unitId, fresh: true });
    assert.match(v.messages[0].text, /AI assistant/, "it introduces itself as an AI assistant");
    const turns = [
      "Hi, the kitchen sink in my unit is leaking underneath, inside the cabinet. It's a slow drip and there is a small puddle in the cabinet. Nothing is near any outlets.",
      "It's dripping right now. The water is not spreading onto the floor and I turned off the valve under the sink.",
      "Yes, that's all correct. Please file it.",
      "Yes, please submit it now.",
      "Yes.",
    ];
    for (const text of turns) {
      if (v.status === "SUBMITTED") break;
      v = await priya.must("sendIntakeMessage", { conversationId: v.id, text });
      const last = v.messages.at(-1)!;
      t.diagnostic(`relay: ${last.text.slice(0, 200)}`);
      // Before the server saves it, the assistant must never claim it is saved.
      if (v.status !== "SUBMITTED") assert.doesNotMatch(last.text, /\b(report|request) (is|has been) (saved|filed|submitted)\b/i);
    }
    assert.equal(v.status, "SUBMITTED", "the agent filed the report within five resident turns");
    assert.match(v.messages.at(-1).text, /^Your report is saved as RLY-\d{4}/, "the confirmation is the server's own result");
    caseId = v.caseId;
    const c = await morgan.must("getCase", { caseId });
    assert.equal(c.channel, "CHAT");
    assert.equal(c.triageSource, "AGENT");
    assert.equal(c.category, "PLUMBING");
    assert.match(c.description, /kitchen sink is leaking/, "the resident's own words are kept verbatim");
    assert.ok(c.triageReasons.some((r: string) => /intake assistant/.test(r)), "the agent's rationale is recorded");
    t.diagnostic(`filed ${c.ref}: ${c.title} (${c.severity}); facts: ${c.answers.map((a: any) => `${a.question}=${a.answer}`).join("; ")}`);
  });
});

describe("coordinator", () => {
  test("wakes on the new case, reads it through tools, and every proposal passes policy", async (t) => {
    if (!available || !caseId) return t.skip(available ? "no case from the intake test" : `no model: ${reason}`);
    let c: any;
    const deadline = Date.now() + 8 * 60_000;
    do {
      await sleep(5000);
      c = await morgan.must("getCase", { caseId });
    } while (Date.now() < deadline && !c.ai.runs.some((r: any) => r.status !== "RUNNING"));
    const run = c.ai.runs.find((r: any) => r.status !== "RUNNING");
    assert.ok(run, "a coordinator run finished");
    t.diagnostic(`run ${run.status} after ${run.trigger} in ${Math.round((run.durationMs ?? 0) / 1000)} s: ${run.steps.map((s: any) => s.summary).join(" | ")}`);
    assert.equal(run.status, "SUCCEEDED", run.error ?? "");
    assert.ok(run.steps.some((s: any) => s.tool === "get_case"), "it read the case through a tool");
    if (c.ai.assessment) t.diagnostic(`assessment: ${c.ai.assessment}`);
    const vendorIds = new Set((await morgan.must("getEligibleVendors", { caseId })).map((v: any) => v.name));
    for (const p of c.ai.proposals.filter((p: any) => p.kind === "ASSIGN_VENDOR")) {
      assert.ok(vendorIds.has(p.vendorName), `${p.vendorName} is an eligible plumber`);
      assert.match(p.policyNote, /Autopilot is off/, "policy held it for a manager");
    }
    const pending = c.ai.proposals.find((p: any) => p.kind === "ASSIGN_VENDOR" && p.status === "PENDING");
    if (!pending) {
      t.diagnostic("the model recorded an assessment without proposing a vendor this time");
      return;
    }
    await morgan.must("decideSuggestion", { proposalId: pending.id, accept: true });
    const after = await morgan.must("getCase", { caseId });
    assert.equal(after.status, "AWAITING_VENDOR");
    assert.equal(after.assignment.vendorName, pending.vendorName);
    assert.equal(after.ai.proposals.find((p: any) => p.id === pending.id).status, "EXECUTED");
    assert.equal((await morgan.op("decideSuggestion", { proposalId: pending.id, accept: false })).status, 409, "a decided suggestion cannot be flipped");
  });
});
