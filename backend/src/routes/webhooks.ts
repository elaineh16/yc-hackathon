// Post-call webhook from ElevenLabs (workspace settings > Webhooks > post-call transcription).
// Saves transcript + summary on the matching call, and nudges the dispatch loop
// if a contractor call ended without an answer.
import { Router } from "express";
import { dispatchNext } from "../dispatch.js";
import { config, verifyWebhook } from "../elevenlabs.js";
import { addCall, db, findCallByConversationId, updateCall } from "../store.js";
import type { AgentKind } from "../types.js";

export const webhooks = Router();

webhooks.post("/post-call", (req, res) => {
  const raw = (req as unknown as { rawBody?: string }).rawBody ?? JSON.stringify(req.body);
  if (!verifyWebhook(raw, req.header("elevenlabs-signature"))) {
    return res.status(401).json({ error: "bad signature" });
  }

  const { type, data } = req.body ?? {};
  if (type !== "post_call_transcription" || !data) return res.json({ ignored: true });

  const conversationId: string = data.conversation_id;
  const transcript = Array.isArray(data.transcript)
    ? data.transcript.map((t: { role: string; message: string | null }) => ({ role: t.role, message: t.message ?? "" }))
    : [];
  const summary: string | null = data.analysis?.transcript_summary ?? null;
  const vars = data.conversation_initiation_client_data?.dynamic_variables ?? {};

  let call = findCallByConversationId(conversationId);

  // Inbound intake calls aren't known until now unless create_ticket passed conversation_id.
  if (!call) {
    const kind: AgentKind =
      data.agent_id === config.agents.dispatch() ? "dispatch" : data.agent_id === config.agents.confirm() ? "confirm" : "intake";
    call = addCall({
      ticketId: vars.ticket_id ?? null,
      agent: kind,
      direction: kind === "intake" ? "inbound" : "outbound",
      counterpartName: vars.tenant_name ?? "Caller",
      counterpartPhone: vars.system__caller_id ?? "",
      contractorId: vars.contractor_id ?? null,
      outcome: "ended",
      conversationId,
      callSid: vars.system__call_sid ?? null,
    });
  }

  const stillOpen = call.outcome === "in_progress";
  updateCall(call.id, {
    transcript,
    summary: call.summary ?? summary,
    endedAt: new Date().toISOString(),
    outcome: stillOpen ? (call.agent === "dispatch" ? "no_answer" : "ended") : call.outcome,
  });

  // Contractor hung up without accepting/declining: try the next one.
  if (stillOpen && call.agent === "dispatch" && call.ticketId) {
    dispatchNext(call.ticketId, "call ended without answer").catch(console.error);
  }

  res.json({ ok: true, call_id: call.id });
});

// Debug helper: see what we've stored
webhooks.get("/debug/calls", (_req, res) => res.json(db.calls.slice(0, 20)));
