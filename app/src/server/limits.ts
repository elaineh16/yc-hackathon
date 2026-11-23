// Per-user limits on the paths that cost money (model calls, voice sessions) or create work for people (reports), and a
// throttle on failed sign-ins. Sliding windows kept in memory: right for one server process. With several processes
// each enforces its own window, so the effective limit multiplies; a shared store would be needed then.
import type { NextFunction, Request, Response } from "express";
import { HttpError, type MiddlewareConfigFn } from "wasp/server";

const hits = new Map<string, number[]>();
const num = (v: string | undefined, d: number) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

export const LIMITS = {
  reports: () => ({ max: num(process.env.LIMIT_REPORTS_PER_HOUR, 20), windowMs: 3600_000, what: "You have sent a lot of reports in the last hour." }),
  chat: () => ({ max: num(process.env.LIMIT_CHAT_MESSAGES_PER_HOUR, 60), windowMs: 3600_000, what: "You have sent a lot of messages to Relay's assistant in the last hour." }),
  voice: () => ({ max: num(process.env.LIMIT_VOICE_SESSIONS_PER_HOUR, 10), windowMs: 3600_000, what: "You have started a lot of voice reports in the last hour." }),
};

/** Counts one use of `kind` by this user, or refuses (429) when the window is full. */
export function useLimit(kind: keyof typeof LIMITS, userId: number | null) {
  const { max, windowMs, what } = LIMITS[kind]();
  const key = `${kind}:${userId ?? "anon"}`;
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= max) {
    const minutes = Math.max(1, Math.ceil((windowMs - (now - recent[0])) / 60_000));
    throw new HttpError(429, `${what} Try again in ${minutes} minute${minutes === 1 ? "" : "s"}, or ask your property manager for help.`, { code: "rate_limited" });
  }
  recent.push(now);
  hits.set(key, recent);
}

/** Test hooks: a reset starts every window afresh. */
export const clearLimits = () => {
  hits.clear();
  failures.clear();
};

// ───────────────────────── sign-in throttle ─────────────────────────

const failures = new Map<string, number[]>();
const LOGIN_WINDOW_MS = 15 * 60_000;
const MAX_FAILURES_PER_USERNAME = () => num(process.env.LIMIT_LOGIN_FAILURES_PER_USERNAME, 10);
const MAX_FAILURES_PER_ADDRESS = () => num(process.env.LIMIT_LOGIN_FAILURES_PER_ADDRESS, 50);

const recentFailures = (key: string, now: number) => (failures.get(key) ?? []).filter((t) => now - t < LOGIN_WINDOW_MS);

/**
 * Express middleware in front of Wasp's username sign-in: after too many failed attempts for one username (or from one
 * address) in 15 minutes, further attempts are refused until the window passes. Successful sign-ins are not counted.
 */
export function loginThrottle(req: Request, res: Response, next: NextFunction) {
  // Wasp mounts the global middleware per router ("/auth", "/operations"...), so the full path is baseUrl + path.
  if (req.method !== "POST" || !/^\/auth\/username\/login\/?$/.test(`${req.baseUrl}${req.path}`)) return next();
  const username = String((req.body as { username?: unknown } | undefined)?.username ?? "")
    .trim()
    .toLowerCase()
    .slice(0, 80);
  const keys = [`u:${username}`, `a:${req.socket.remoteAddress ?? "?"}`];
  const now = Date.now();
  if (recentFailures(keys[0], now).length >= MAX_FAILURES_PER_USERNAME() || recentFailures(keys[1], now).length >= MAX_FAILURES_PER_ADDRESS()) {
    return res.status(429).json({ message: "Too many failed sign-in attempts. Wait 15 minutes and try again, or ask your property manager to reset your password." });
  }
  res.on("finish", () => {
    if (res.statusCode < 400 || res.statusCode === 429) return;
    const t = Date.now();
    for (const k of keys) failures.set(k, [...recentFailures(k, t), t]);
  });
  return next();
}

/** Wasp server middlewareConfigFn: the default middleware (body parsing first), then the sign-in throttle. */
export const serverMiddleware: MiddlewareConfigFn = (config) => {
  config.set("relay.loginThrottle", loginThrottle);
  return config;
};
