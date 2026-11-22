// Public HTTP endpoints (declared in main.wasp):
//   POST /api/relay/intake   the ElevenLabs "save_work_order" server tool
//   GET  /health             Maritime health check
// Contract: dashboard/README.md. The response's `message` is what the agent says next, and it says "saved"
// only after the database transaction has committed.
import { createHash, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { prisma } from "wasp/server";
import { agentMessage, parseIntake } from "./relay/domain.js";
import { IntakeError, recordIntake } from "./relay/service.js";

const NOT_SAVED = "The report was NOT saved. Do not tell the student it was saved.";

function secretOk(header: unknown): boolean {
  const want = process.env.RELAY_TOOL_SECRET;
  if (!want) return false; // fail closed: an unconfigured server accepts no tool calls
  if (typeof header !== "string") return false;
  const h = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(h(header), h(want));
}

export const relayIntake = async (req: Request, res: Response, _ctx: unknown) => {
  if (!process.env.RELAY_TOOL_SECRET) {
    return res.status(503).json({ ok: false, error: "not_configured", message: `${NOT_SAVED} The server is not configured.` });
  }
  if (!secretOk(req.header("x-relay-secret"))) {
    return res.status(401).json({ ok: false, error: "unauthorized", message: NOT_SAVED });
  }
  const parsed = parseIntake(req.body);
  if (!parsed.ok) {
    return res.status(400).json({
      ok: false,
      error: "invalid_request",
      fields: parsed.errors,
      message: `${NOT_SAVED} Ask the student for: ${parsed.errors.join(", ")}, then try again.`,
    });
  }
  try {
    const r = await recordIntake(parsed.value);
    return res.status(r.created ? 201 : 200).json({
      ok: true,
      work_order_id: r.workOrderId,
      work_order_number: r.number,
      created: r.created,
      duplicate: r.duplicate,
      safety_escalated: r.hazard,
      message: agentMessage(r.hazard, r.created),
    });
  } catch (e) {
    if (e instanceof IntakeError) return res.status(e.status).json({ ok: false, error: e.code, message: `${NOT_SAVED} ${e.message}` });
    console.error("[relay] intake failed", e);
    return res.status(500).json({
      ok: false,
      error: "save_failed",
      message: `${NOT_SAVED} Apologize, and tell the student to report it at the residence front desk.`,
    });
  }
};

export const health = async (_req: Request, res: Response, _ctx: unknown) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({
      ok: true,
      db: "up",
      intakeConfigured: Boolean(process.env.RELAY_TOOL_SECRET),
      voiceConfigured: Boolean(process.env.ELEVENLABS_API_KEY && (process.env.EL_AGENT_INTAKE_ID || process.env.ELEVENLABS_AGENT_ID)),
      time: new Date().toISOString(),
    });
  } catch {
    res.status(503).json({ ok: false, db: "down" });
  }
};
