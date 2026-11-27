// Screenshots of the populated app at desktop, tablet and phone sizes, for review and the docs. Not part of the
// normal test run: SCREENS=1 npx playwright test screens   (after `npx tsx scripts/demo-data.ts` from app/)
import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

const DIR = process.env.RELAY_SHOTS_DIR ?? "../../docs/screenshots/v1.1";
const SIZES = { desktop: { width: 1440, height: 900 }, tablet: { width: 834, height: 1112 }, mobile: { width: 390, height: 844 } } as const;
const API = process.env.RELAY_API_URL ?? "http://localhost:3001";

test.skip(!process.env.SCREENS, "screenshots run only with SCREENS=1");

/** Looks a case up through the manager's search (residents and contractors cannot search). */
async function caseIdByTitle(_viewer: string, title: RegExp): Promise<string> {
  const username = "morgan";
  const login = await (await fetch(`${API}/auth/username/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password: "relay-demo-2026" }) })).json();
  const res = await fetch(`${API}/operations/search-cases`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${login.sessionId}` }, body: JSON.stringify({ json: { pageSize: 100 } }) });
  const page = (await res.json()).json;
  const hit = page.items.find((c: { title: string }) => title.test(c.title));
  if (!hit) throw new Error(`no case matching ${title}`);
  return hit.id;
}

async function caseIdByStatus(status: string): Promise<string> {
  const login = await (await fetch(`${API}/auth/username/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "morgan", password: "relay-demo-2026" }) })).json();
  const res = await fetch(`${API}/operations/search-cases`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${login.sessionId}` }, body: JSON.stringify({ json: { status: [status], pageSize: 10 } }) });
  return (await res.json()).json.items[0].id;
}

for (const [size, viewport] of Object.entries(SIZES)) {
  test(`manager screens, ${size}`, async ({ browser }) => {
    const page = await signIn(browser, "morgan", viewport);
    await page.goto("/ops");
    await expect(page.getByRole("heading", { name: "Your move" })).toBeVisible();
    await page.screenshot({ path: `${DIR}/manager-command-center-${size}.png`, fullPage: true });
    const ac = await caseIdByTitle("morgan", /air conditioner|cooling/i);
    await page.goto(`/ops/cases/${ac}`);
    await expect(page.getByTestId("candidate").first()).toBeVisible();
    await page.screenshot({ path: `${DIR}/manager-case-discovery-${size}.png`, fullPage: true });
    const pipe = await caseIdByStatus("IN_PROGRESS");
    await page.goto(`/ops/cases/${pipe}`);
    await expect(page.getByRole("heading", { name: /More money requested/ })).toBeVisible();
    await page.screenshot({ path: `${DIR}/manager-case-budget-${size}.png`, fullPage: true });
    if (size === "desktop") {
      const leak = await caseIdByTitle("morgan", /kitchen sink/i);
      await page.goto(`/ops/cases/${leak}`);
      await expect(page.getByRole("heading", { name: "Approve the estimate" })).toBeVisible();
      await page.screenshot({ path: `${DIR}/manager-case-approval-${size}.png`, fullPage: true });
      await page.goto("/ops/vendors");
      await expect(page.getByRole("heading", { name: "Vendors", exact: true })).toBeVisible();
      await page.screenshot({ path: `${DIR}/manager-vendors-${size}.png`, fullPage: true });
      await page.goto("/ops/settings");
      await page.screenshot({ path: `${DIR}/manager-settings-${size}.png`, fullPage: true });
      await page.goto("/ops/cases");
      await page.screenshot({ path: `${DIR}/manager-inbox-${size}.png`, fullPage: true });
    }
  });
  test(`resident screens, ${size}`, async ({ browser }) => {
    const page = await signIn(browser, "priya", viewport);
    await page.goto("/my");
    await page.screenshot({ path: `${DIR}/resident-requests-${size}.png`, fullPage: true });
    const leak = await caseIdByTitle("priya", /kitchen sink/i);
    await page.goto(`/my/cases/${leak}`);
    await expect(page.getByTestId("next-action")).toBeVisible();
    await page.screenshot({ path: `${DIR}/resident-case-${size}.png`, fullPage: true });
    await page.goto("/my/report");
    await page.screenshot({ path: `${DIR}/resident-report-${size}.png`, fullPage: true });
  });
  test(`contractor screens, ${size}`, async ({ browser }) => {
    const page = await signIn(browser, "jo", viewport);
    await page.goto("/jobs");
    await page.screenshot({ path: `${DIR}/contractor-jobs-${size}.png`, fullPage: true });
    const pipe = await caseIdByStatus("IN_PROGRESS");
    await page.goto(`/jobs/${pipe}`);
    await expect(page.getByTestId("next-action")).toBeVisible();
    await page.screenshot({ path: `${DIR}/contractor-job-${size}.png`, fullPage: true });
  });
}
