// Plain HTTP endpoints (declared in main.wasp): the health check, the durable job, the signup block, and the
// test-only hooks.
import { timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { HttpError, prisma } from "wasp/server";
import { faults } from "./cases/engine";
import { sweepDeadlines } from "./cases/sweep";
import { emailConfig } from "./notify/config";
import { deliverNow } from "./notify/email";
import { clearLimits } from "./limits";
import { resetCases } from "./seed";
import { initTracing } from "./tracing";
import { runDiscovery } from "./vendors/discovery";
import { fiberConfig } from "./vendors/fiber";
import { FIXTURE_SCENARIOS, type FixtureScenario, fixtureCalls, setFixtureScenario } from "./vendors/fixtures";
import { voiceConfigured } from "./voice";

/** Wasp server setupFn: runs once at startup. */
export const serverSetup = async () => {
  await initTracing();
  if (testHooksEnabled()) console.warn("[relay] RELAY_TEST_HOOKS is on: /api/test/* can wipe data. Never enable this outside automated tests.");
};

export const health = async (_req: Request, res: Response, _ctx: unknown) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    // Configuration flags only: never a key, a host or a count of anything private.
    res.json({ ok: true, db: "up", voiceConfigured: voiceConfigured(), tracing: Boolean(process.env.TRACEROOT_API_KEY), discovery: fiberConfig().mode, email: emailConfig().enabled ? (emailConfig().capture ? "capture" : "smtp") : "off", time: new Date().toISOString() });
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
// They let the automated tests reset data, move the clock for the deadline sweep, and make a database write fail on
// purpose. Four gates: off unless RELAY_TEST_HOOKS=true; refused in production builds; only from this machine
// (loopback, never a forwarded address); and, when RELAY_TEST_HOOKS_TOKEN is set, only with that token.

const testHooksEnabled = () => process.env.RELAY_TEST_HOOKS === "true" && process.env.NODE_ENV !== "production";
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
function hookCallerAllowed(req: Request): boolean {
  if (!LOOPBACK.has(req.socket.remoteAddress ?? "")) return false;
  const token = process.env.RELAY_TEST_HOOKS_TOKEN;
  if (!token) return true;
  const given = Buffer.from(String(req.headers["x-relay-test-token"] ?? ""));
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}
// Fiber settings that change spending: a test may change them only while no real Fiber call can be made.
const FIBER_SPEND = new Set(["FIBER_MAX_CANDIDATES", "FIBER_DAILY_CREDIT_BUDGET", "FIBER_MIN_BALANCE"]);

// Settings a test may change for a while (and that reset restores). An allowlist with allowed values: a test can never
// switch on live Fiber calls, point email at another host, or read any other setting.
const OVERRIDABLE: Record<string, RegExp> = {
  FIBER_MODE: /^(fixture|off)$/,
  FIBER_MAX_CANDIDATES: /^\d{1,2}$/,
  FIBER_DAILY_CREDIT_BUDGET: /^\d{1,4}$/,
  FIBER_MIN_BALANCE: /^\d{1,4}$/,
  SMTP_HOST: /^(localhost|)$/,
  SMTP_PORT: /^(1025|1026)$/,
  LIMIT_REPORTS_PER_HOUR: /^\d{1,3}$/,
  LIMIT_LOGIN_FAILURES_PER_USERNAME: /^\d{1,3}$/,
};
const original: Record<string, string | undefined> = Object.fromEntries(Object.keys(OVERRIDABLE).map((k) => [k, process.env[k]]));
const restoreEnv = () => {
  for (const [k, v] of Object.entries(original)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
};

export const testHook = async (req: Request, res: Response, _ctx: unknown) => {
  if (!testHooksEnabled() || !hookCallerAllowed(req)) return res.status(404).json({ message: "Not found" });
  const body = (req.body ?? {}) as Record<string, unknown>;
  switch (req.params.hook) {
    case "reset":
      faults.clear();
      clearLimits();
      restoreEnv();
      setFixtureScenario(null);
      for (const k of Object.keys(fixtureCalls)) delete fixtureCalls[k];
      await resetCases(prisma);
      return res.json({ ok: true });
    case "fiber": {
      // Fixture mode only: choose how the fixture "API" behaves for the next calls.
      if (fiberConfig().mode !== "fixture") return res.status(409).json({ message: "Fiber is not in fixture mode on this server." });
      const scenario = String(body.scenario ?? "normal") as FixtureScenario;
      if (!FIXTURE_SCENARIOS.includes(scenario)) return res.status(400).json({ message: `scenario must be one of ${FIXTURE_SCENARIOS.join(", ")}` });
      setFixtureScenario(scenario);
      return res.json({ ok: true, scenario, calls: { ...fixtureCalls } });
    }
    case "fiberCalls":
      // `mode` lets a test suite refuse to run against a server that could make real (paid) Fiber calls.
      return res.json({ ok: true, mode: fiberConfig().mode, calls: { ...fixtureCalls } });
    case "discover":
      // Runs a queued discovery now (the job would run it too; the claim makes the second one a no-op).
      if (typeof body.discoveryId !== "string") return res.status(400).json({ message: "discoveryId is required" });
      return res.json({ ok: true, result: await runDiscovery(body.discoveryId) });
    case "deliver":
      // { now: true } skips the retry backoff, so a test can walk through the attempts without waiting.
      if (body.now === true) await prisma.notification.updateMany({ where: { channel: "EMAIL", status: "PENDING" }, data: { nextAttemptAt: null } });
      return res.json({ ok: true, result: await deliverNow() });
    case "env": {
      const set = (body.set ?? {}) as Record<string, unknown>;
      for (const [k, v] of Object.entries(set)) {
        if (!OVERRIDABLE[k] || typeof v !== "string" || !OVERRIDABLE[k].test(v)) return res.status(400).json({ message: `${k} cannot be set to that in tests.` });
      }
      const modeAfter = typeof set.FIBER_MODE === "string" ? set.FIBER_MODE : fiberConfig().mode;
      if (Object.keys(set).some((k) => FIBER_SPEND.has(k)) && !["fixture", "off"].includes(modeAfter)) return res.status(409).json({ message: "Fiber budget settings can only be changed in tests while Fiber is in fixture mode or off." });
      for (const [k, v] of Object.entries(set)) process.env[k] = v as string;
      return res.json({ ok: true });
    }
    case "sweep": {
      const now = typeof body.now === "string" ? new Date(body.now) : new Date();
      if (Number.isNaN(now.getTime())) return res.status(400).json({ message: "now is not a date" });
      return res.json({ ok: true, result: await sweepDeadlines(now, { deliverEmail: body.deliverEmail !== false }) });
    }
    case "fault":
      if (typeof body.point !== "string") return res.status(400).json({ message: "point is required" });
      faults.arm(body.point, typeof body.times === "number" ? body.times : 1);
      return res.json({ ok: true });
    default:
      return res.status(404).json({ message: "Unknown test hook" });
  }
};
