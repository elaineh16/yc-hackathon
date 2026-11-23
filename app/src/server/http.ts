// Plain HTTP endpoints (declared in main.wasp): the health check, the durable job, the signup block, and the
// test-only hooks.
import type { Request, Response } from "express";
import { HttpError, prisma } from "wasp/server";
import { faults } from "./cases/engine";
import { sweepDeadlines } from "./cases/sweep";
import { resetCases } from "./seed";
import { initTracing } from "./tracing";
import { voiceConfigured } from "./voice";

/** Wasp server setupFn: runs once at startup. */
export const serverSetup = async () => {
  await initTracing();
  if (testHooksEnabled()) console.warn("[relay] RELAY_TEST_HOOKS is on: /api/test/* can wipe data. Never enable this outside automated tests.");
};

export const health = async (_req: Request, res: Response, _ctx: unknown) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ ok: true, db: "up", voiceConfigured: voiceConfigured(), tracing: Boolean(process.env.TRACEROOT_API_KEY), time: new Date().toISOString() });
  } catch {
    res.status(503).json({ ok: false, db: "down" });
  }
};

/** pg-boss job, every minute: expire unanswered offers, remind residents, tell managers what is overdue. */
export const runDeadlineSweep = async (_args: unknown, _ctx: unknown) => {
  const r = await sweepDeadlines();
  return { ...r };
};

/** Accounts are provisioned by the property (seed or a manager), never self-registered with a chosen role. */
export const blockSelfSignup = async (_params: unknown) => {
  throw new HttpError(403, "Accounts are created by your property manager.");
};

// ───────────────────────── test-only hooks ─────────────────────────
// Off unless RELAY_TEST_HOOKS=true, and refused in production builds. They let the automated tests reset data,
// move the clock for the deadline sweep, and make a database write fail on purpose.

const testHooksEnabled = () => process.env.RELAY_TEST_HOOKS === "true" && process.env.NODE_ENV !== "production";

export const testHook = async (req: Request, res: Response, _ctx: unknown) => {
  if (!testHooksEnabled()) return res.status(404).json({ message: "Not found" });
  const body = (req.body ?? {}) as Record<string, unknown>;
  switch (req.params.hook) {
    case "reset":
      faults.clear();
      await resetCases(prisma);
      return res.json({ ok: true });
    case "sweep": {
      const now = typeof body.now === "string" ? new Date(body.now) : new Date();
      if (Number.isNaN(now.getTime())) return res.status(400).json({ message: "now is not a date" });
      return res.json({ ok: true, result: await sweepDeadlines(now) });
    }
    case "fault":
      if (typeof body.point !== "string") return res.status(400).json({ message: "point is required" });
      faults.arm(body.point, typeof body.times === "number" ? body.times : 1);
      return res.json({ ok: true });
    default:
      return res.status(404).json({ message: "Unknown test hook" });
  }
};
