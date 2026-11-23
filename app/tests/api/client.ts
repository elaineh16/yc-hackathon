// HTTP client for the API tests: real sign-in, real operations, against a running dev server with
// RELAY_TEST_HOOKS=true (the hooks reset cases, move the sweep clock and inject a database failure).
export const BASE = process.env.RELAY_API_URL ?? "http://localhost:3001";
export const PASSWORD = "relay-demo-2026";

const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
export type Res<T = any> = { status: number; data: T; message?: string; code?: string };

async function parse(res: Response): Promise<Res> {
  const text = await res.text();
  let body: any = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { message: text.slice(0, 200) };
  }
  if (res.ok) return { status: res.status, data: body.json !== undefined ? body.json : body };
  const data = body.data?.json ?? body.data ?? null;
  return { status: res.status, data, message: body.message, code: data?.code };
}

export async function login(username: string): Promise<User> {
  const res = await fetch(`${BASE}/auth/username/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password: PASSWORD }) });
  if (!res.ok) throw new Error(`login ${username} failed: ${res.status}`);
  const { sessionId } = (await res.json()) as { sessionId: string };
  return user(sessionId);
}

export type User = { op: <T = any>(name: string, args?: unknown) => Promise<Res<T>>; must: <T = any>(name: string, args?: unknown) => Promise<T> };
export function user(sessionId: string | null): User {
  const op = async (name: string, args?: unknown) =>
    parse(
      await fetch(`${BASE}/operations/${kebab(name)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(sessionId ? { Authorization: `Bearer ${sessionId}` } : {}) },
        body: JSON.stringify({ json: args ?? null }),
      }),
    );
  return {
    op,
    /** Like op, but throws unless the call succeeded. */
    must: async (name, args) => {
      const r = await op(name, args);
      if (r.status >= 300) throw new Error(`${name} -> ${r.status} ${r.message ?? ""}`);
      return r.data;
    },
  };
}

export async function hook(name: "reset" | "sweep" | "fault" | "fiber" | "fiberCalls" | "discover" | "deliver" | "env", body: Record<string, unknown> = {}) {
  const res = await fetch(`${BASE}/api/test/${name}`, { method: "POST", headers: { "Content-Type": "application/json", ...(process.env.RELAY_TEST_HOOKS_TOKEN ? { "x-relay-test-token": process.env.RELAY_TEST_HOOKS_TOKEN } : {}) }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`test hook ${name} -> ${res.status}. Is the server running with RELAY_TEST_HOOKS=true?`);
  const out = await res.json();
  // Every test starts with a reset: refuse to go on against a server that could make real, paid Fiber AI calls.
  if (name === "reset") {
    const { mode } = (await hook("fiberCalls")) as { mode?: string };
    if (mode !== "fixture" && mode !== "off") throw new Error(`Refusing to run tests: the server's Fiber AI mode is "${mode}", so a test could spend real credits. Start it with FIBER_MODE=fixture.`);
  }
  return out;
}

export const slot = (daysAhead: number, hour: number, hours = 2) => {
  const start = new Date();
  start.setDate(start.getDate() + daysAhead);
  start.setHours(hour, 0, 0, 0);
  return { startAt: start.toISOString(), endAt: new Date(start.getTime() + hours * 3600_000).toISOString() };
};
export const rid = () => `test-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls fn until it returns something truthy, or fails after timeoutMs. */
export async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 30_000, what = "the condition"): Promise<T> {
  const until = Date.now() + timeoutMs;
  let last: unknown = null;
  while (Date.now() < until) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`Timed out waiting for ${what}${last ? ` (last error: ${(last as Error).message})` : ""}`);
}

// ───────── Mailpit (the local SMTP capture server) ─────────
export const MAILPIT = process.env.MAILPIT_URL ?? "http://localhost:8025";
export type Mail = { id: string; to: string[]; subject: string };
export async function mailbox(): Promise<Mail[]> {
  const res = await fetch(`${MAILPIT}/api/v1/messages?limit=500`);
  if (!res.ok) throw new Error(`Mailpit is not reachable at ${MAILPIT} (${res.status}).`);
  const d = (await res.json()) as { messages: { ID: string; To: { Address: string }[]; Subject: string }[] };
  return d.messages.map((m) => ({ id: m.ID, to: (m.To ?? []).map((t) => t.Address), subject: m.Subject }));
}
export async function clearMailbox() {
  await fetch(`${MAILPIT}/api/v1/messages`, { method: "DELETE" });
}
export async function mailText(id: string): Promise<string> {
  const res = await fetch(`${MAILPIT}/api/v1/message/${id}`);
  const d = (await res.json()) as { Text: string };
  return d.Text ?? "";
}
