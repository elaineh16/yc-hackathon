import { type Browser, expect, type Page } from "@playwright/test";

export const API = process.env.RELAY_API_URL ?? "http://localhost:3001";
export const PASSWORD = "relay-demo-2026";
export const SHOTS = process.env.RELAY_SHOTS_DIR ?? "../../docs/screenshots";

/** A signed-in browser for one user, in its own context (its own cookies and storage). */
export async function signIn(browser: Browser, username: string, viewport = { width: 1440, height: 900 }): Promise<Page> {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  await page.goto("/login");
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
  return page;
}

export async function resetCases() {
  const res = await fetch(`${API}/api/test/reset`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  if (!res.ok) throw new Error(`reset failed (${res.status}): run the server with RELAY_TEST_HOOKS=true`);
}

export const shot = (page: Page, name: string) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
