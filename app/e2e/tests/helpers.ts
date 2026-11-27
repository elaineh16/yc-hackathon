import { type Browser, expect, type Page } from "@playwright/test";

/** Test hooks only answer from this machine, and need the shared token when the server sets RELAY_TEST_HOOKS_TOKEN. */
const HOOK_HEADERS: Record<string, string> = { "Content-Type": "application/json", ...(process.env.RELAY_TEST_HOOKS_TOKEN ? { "x-relay-test-token": process.env.RELAY_TEST_HOOKS_TOKEN } : {}) };

export const API = process.env.RELAY_API_URL ?? "http://localhost:3001";
export const PASSWORD = "relay-demo-2026";
export const SHOTS = process.env.RELAY_SHOTS_DIR ?? "../../docs/screenshots";

/** A signed-in browser for one user, in its own context (its own cookies and storage). */
export async function signIn(browser: Browser, username: string, viewport = { width: 1440, height: 900 }): Promise<Page> {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  await page.goto("/login");
  const field = page.getByLabel("Username");
  try {
    await field.waitFor({ timeout: 20_000 });
  } catch {
    // The Vite dev server occasionally serves a page that never renders (a dev-only "@vitejs/plugin-react can't
    // detect preamble" error, seen once in CI). One reload recovers it; anything else still fails on the next line.
    await page.reload();
  }
  await field.fill(username);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
  return page;
}

export async function resetCases() {
  const res = await fetch(`${API}/api/test/reset`, { method: "POST", headers: HOOK_HEADERS, body: "{}" });
  if (!res.ok) throw new Error(`reset failed (${res.status}): run the server with RELAY_TEST_HOOKS=true`);
  // Refuse to go on against a server that could make real, paid Fiber AI calls.
  const { mode } = await hook("fiberCalls");
  if (mode !== "fixture" && mode !== "off") throw new Error(`Refusing to run tests: the server's Fiber AI mode is "${mode}", so a test could spend real credits. Start it with FIBER_MODE=fixture.`);
}

export const shot = (page: Page, name: string) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });

/** Calls a Relay operation as a user (for setup the journey does not need to show, and for checks). */
export async function api<T = any>(username: string, op: string, args: unknown = null): Promise<T> {
  const login = await (await fetch(`${API}/auth/username/login`, { method: "POST", headers: HOOK_HEADERS, body: JSON.stringify({ username, password: PASSWORD }) })).json();
  const res = await fetch(`${API}/operations/${op.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${login.sessionId}` }, body: JSON.stringify({ json: args }) });
  const body = await res.json();
  if (!res.ok) throw new Error(`${op} -> ${res.status} ${body.message ?? ""}`);
  return body.json;
}
export async function hook(name: string, body: Record<string, unknown> = {}) {
  const res = await fetch(`${API}/api/test/${name}`, { method: "POST", headers: HOOK_HEADERS, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`hook ${name} -> ${res.status}`);
  return res.json();
}
export const MAILPIT = process.env.MAILPIT_URL ?? "http://localhost:8025";
export async function mailTo(address: string): Promise<{ subject: string }[]> {
  const d = await (await fetch(`${MAILPIT}/api/v1/messages?limit=200`)).json();
  return d.messages.filter((m: { To: { Address: string }[] }) => m.To.some((t) => t.Address === address)).map((m: { Subject: string }) => ({ subject: m.Subject }));
}
