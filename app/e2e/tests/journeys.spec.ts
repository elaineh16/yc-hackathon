// Relay V1.1 journeys in real Chrome, each user in their own signed-in browser:
//   1. existing vendor (appliance) from report to RESOLVED
//   2. missing vendor (heating and cooling): vendor discovery, verification, onboarding, the case resumes
//   3. an ambiguous report: a person classifies it, then it routes
//   4. follow-up: completion asks the resident in-app and by email (captured by Mailpit); "still having problems" reopens
//   5. failures: a double-submitted report, the AI offline, the discovery provider down, email not configured
//   6. the chat safety net: a possible emergency is filed at once; a chat the assistant cannot answer reaches a manager
// Run: cd app/e2e && npx playwright test journeys   (server with RELAY_TEST_HOOKS=true, FIBER_MODE=fixture, Mailpit)
import { expect, type Page, test } from "@playwright/test";
import { api, hook, mailTo, resetCases, signIn } from "./helpers";

// Each journey resets the cases and stands alone; the steps inside a journey run in order.
const PHONE = { width: 390, height: 844 };

async function fileByForm(page: Page, category: string, text: string, answers: Record<string, string>) {
  await page.goto("/my/report");
  await page.getByRole("tab", { name: "Use the form" }).click();
  await page.getByLabel("What kind of problem?").selectOption(category);
  await page.getByLabel("Describe it").fill(text);
  for (const [key, value] of Object.entries(answers)) {
    const q = page.getByTestId(`q-${key}`);
    if (value === "Yes" || value === "No") await q.getByText(value, { exact: true }).click();
    else await q.getByRole("combobox").selectOption(value);
  }
  await page.getByRole("button", { name: "Submit report" }).click();
  await expect(page.getByText(/Your report is saved as RLY-\d{4}/)).toBeVisible();
  await page.getByRole("button", { name: "Follow this request" }).click();
  await expect(page).toHaveURL(/\/my\/cases\//);
  return new URL(page.url()).pathname.replace("/my/cases/", "");
}

test.describe("1. an existing vendor: an appliance from report to RESOLVED", () => {
  let resident: Page, manager: Page, contractor: Page, id = "";
  test.beforeAll(async ({ browser }) => {
    await resetCases();
    resident = await signIn(browser, "priya", PHONE);
    manager = await signIn(browser, "morgan");
    contractor = await signIn(browser, "ana", PHONE);
  });
  test("report, offer, accept within the threshold, visit, completion, confirmation", async () => {
    id = await fileByForm(resident, "APPLIANCE", "The dishwasher will not start. The panel lights up but nothing happens.", { appliance: "dishwasher", problem: "wont_start", burningOrSparks: "No", gasSmell: "No" });
    await manager.goto(`/ops/cases/${id}`);
    await expect(manager.getByRole("heading", { name: "Assign a vendor" })).toBeVisible();
    await manager.getByText("BrightSpark Appliance Repair", { exact: true }).click();
    await manager.getByRole("button", { name: "Send the job offer" }).click();
    await expect(manager.getByRole("heading", { name: "Offer sent" })).toBeVisible();
    await contractor.goto(`/jobs/${id}`);
    await expect(contractor.getByRole("heading", { name: "New job offer" })).toBeVisible();
    await contractor.getByLabel("Estimate (CAD, all in)").fill("150");
    await contractor.getByLabel("What it covers").fill("Diagnose and replace the door latch switch");
    await contractor.getByRole("button", { name: "Accept the job" }).click();
    await resident.goto(`/my/cases/${id}`);
    await expect(resident.getByRole("heading", { name: "Choose a visit time" })).toBeVisible();
    await resident.getByRole("button", { name: /Choose$/ }).first().click();
    await expect(resident.getByText(/Visit confirmed:/).first()).toBeVisible();
    await contractor.goto(`/jobs/${id}`);
    await contractor.getByRole("button", { name: "Start work" }).click();
    await expect(contractor.getByRole("heading", { name: "Work in progress" })).toBeVisible();
    await contractor.getByLabel("What did you do?").fill("Replaced the door latch switch. Ran a full cycle, it starts and finishes.");
    await contractor.getByRole("button", { name: "Mark work complete" }).click();
    await resident.goto(`/my/cases/${id}`);
    await expect(resident.getByRole("heading", { name: "Is it fixed?" })).toBeVisible();
    await resident.getByRole("button", { name: "Yes, resolved" }).click();
    await expect(resident.getByTestId("next-action")).toContainText("Resolved");
    await manager.goto(`/ops/cases/${id}`);
    await expect(manager.getByTestId("timeline")).toContainText("approved by policy");
    await expect(manager.getByTestId("timeline")).toContainText("confirmed the problem is fixed");
  });
});

test.describe("2. a missing vendor: discovery, verification, onboarding, resume", () => {
  let resident: Page, manager: Page, id = "";
  test.beforeAll(async ({ browser }) => {
    await resetCases();
    resident = await signIn(browser, "priya", PHONE);
    manager = await signIn(browser, "morgan");
  });
  test("no approved heating and cooling vendor: Relay finds local businesses and the manager onboards one", async () => {
    id = await fileByForm(resident, "HVAC", "The air conditioner in the living room is not cooling at all.", { system: "cooling", completelyOut: "Yes", burningOrGasSmell: "No", vulnerableOccupant: "No" });
    await manager.goto(`/ops/cases/${id}`);
    await expect(manager.getByText("No approved heating and cooling contractor for this property").first()).toBeVisible();
    const laurier = manager.getByTestId("candidate").filter({ hasText: "Laurier Climate Services" });
    await expect(laurier).toBeVisible({ timeout: 60_000 });
    await expect(manager.getByTestId("discovery-search").first()).toContainText("heating and cooling contractor");
    await expect(manager.getByText("Fixture data (fictional businesses)")).toBeVisible();
    await laurier.getByRole("button", { name: "Mark verified" }).click();
    await manager.getByLabel("What you checked").fill("Called the office: licensed, insured, can come Thursday.");
    await manager.getByRole("dialog").getByRole("button", { name: "Mark verified" }).click();
    await expect(laurier).toContainText("Verified by you");
    await laurier.getByRole("button", { name: "Approve for this property" }).click();
    await manager.getByRole("dialog").getByRole("button", { name: "Approve and add to vendors" }).click();
    await expect(laurier).toContainText("Approved for this property");
    await expect(manager.getByText("Laurier Climate Services", { exact: true }).first()).toBeVisible();
    await manager.getByRole("radio").first().check();
    await manager.getByRole("button", { name: "Send the job offer" }).click();
    await expect(manager.getByRole("heading", { name: "Offer sent" })).toBeVisible();
    await expect(manager.getByTestId("timeline")).toContainText("has no Relay login");
    await expect(manager.getByTestId("timeline")).toContainText("approved Laurier Climate Services for this property");
  });
});

test.describe("3. an ambiguous report: a person classifies it, then it routes", () => {
  let resident: Page, manager: Page, id = "";
  test.beforeAll(async ({ browser }) => {
    await resetCases();
    resident = await signIn(browser, "priya", PHONE);
    manager = await signIn(browser, "morgan");
  });
  test("a vague report goes to a person, who sets the category; it then follows the trade's path", async () => {
    // Deliberately vague: nothing in it names a trade, so the rules cannot route it and a person must.
    id = await fileByForm(resident, "OTHER", "Something is not right in my apartment since yesterday and I am not sure what it is.", { danger: "No" });
    await expect(resident.getByTestId("next-action")).toContainText("Waiting on the manager");
    await manager.goto(`/ops/cases/${id}`);
    await expect(manager.getByRole("heading", { name: "Review the report" })).toBeVisible();
    await manager.getByLabel("Category").selectOption("ELECTRICAL");
    await manager.getByLabel("Severity").selectOption("URGENT");
    await manager.getByRole("button", { name: "Save and route for a vendor" }).click();
    await expect(manager.getByRole("heading", { name: "Assign a vendor" })).toBeVisible();
    await expect(manager.getByTestId("timeline")).toContainText("Classified as electrical, urgent");
  });
});

test.describe("4. follow-up: completion is confirmed by the resident, and 'still having problems' reopens it", () => {
  let resident: Page, manager: Page, contractor: Page, id = "";
  test.beforeAll(async ({ browser }) => {
    await resetCases();
    await fetch(`${process.env.MAILPIT_URL ?? "http://localhost:8025"}/api/v1/messages`, { method: "DELETE" });
    // Setup the journey does not need to show: a washer job, accepted and scheduled.
    const unitId = (await api("priya", "getMe")).units[0].id;
    const r = await api("priya", "reportIssue", { unitId, clientRequestId: crypto.randomUUID(), description: "The washing machine will not drain.", categoryHint: "APPLIANCE", details: { appliance: "washer", problem: "wont_drain", burningOrSparks: false, gasSmell: false } });
    id = r.caseId;
    const vendors = await api("morgan", "getEligibleVendors", { caseId: id });
    await api("morgan", "assignVendor", { caseId: id, vendorId: vendors.find((v: { name: string }) => v.name.startsWith("BrightSpark")).id });
    const offer = (await api("ana", "getMyJobs")).offers.find((o: { id: string }) => o.id === id);
    const start = new Date(Date.now() + 48 * 3600_000);
    start.setMinutes(0, 0, 0);
    await api("ana", "respondToOffer", { assignmentId: offer.assignmentId, accept: true, estimateType: "FIXED", estimateCents: 16000, slots: [{ startAt: start.toISOString(), endAt: new Date(start.getTime() + 2 * 3600_000).toISOString() }] });
    await api("priya", "chooseVisitTime", { slotId: (await api("priya", "getCase", { caseId: id })).assignment.slots[0].id });
    await api("ana", "startWork", { caseId: id });
    resident = await signIn(browser, "priya", PHONE);
    manager = await signIn(browser, "morgan");
    contractor = await signIn(browser, "ana", PHONE);
  });
  test("the contractor completes; the resident is asked in-app and by email; no reopens it for the manager", async () => {
    await contractor.goto(`/jobs/${id}`);
    await contractor.getByLabel("What did you do?").fill("Cleared the drain pump filter and the hose.");
    await contractor.getByRole("button", { name: "Mark work complete" }).click();
    await expect(contractor.getByText("Waiting for the resident to confirm the fix.")).toBeVisible();
    await resident.goto(`/my/cases/${id}`);
    await expect(resident.getByRole("heading", { name: "Is it fixed?" })).toBeVisible();
    await resident.getByRole("button", { name: /Notifications/ }).click();
    await expect(resident.getByText(/Is this fixed\?/).first()).toBeVisible();
    await resident.keyboard.press("Escape");
    await hook("deliver", { now: true });
    expect((await mailTo("priya.nair@relay-demo.test")).some((m) => /^Is this fixed\?/.test(m.subject))).toBe(true);
    await resident.goto(`/my/cases/${id}`);
    await resident.getByLabel("What is still wrong").fill("Water still stays in the drum after the cycle.");
    await resident.getByRole("button", { name: "No, still having problems" }).click();
    await expect(resident.getByTestId("next-action")).toContainText("Reopened");
    await manager.goto("/ops");
    await expect(manager.getByText("Resident says it is not fixed").first()).toBeVisible();
    await manager.goto(`/ops/cases/${id}`);
    await expect(manager.getByTestId("followups")).toContainText("Captured (test server)");
    await expect(manager.getByTestId("followups")).toContainText("Not fixed");
  });
});

test.describe("5. failures are visible and never block the work", () => {
  test.describe.configure({ mode: "serial" });
  let resident: Page, manager: Page;
  test.beforeAll(async ({ browser }) => {
    await resetCases();
    resident = await signIn(browser, "priya", PHONE);
    manager = await signIn(browser, "morgan");
  });
  test.afterAll(async () => {
    await resetCases();
  });
  test("a double-submitted report creates one case", async () => {
    const before = (await api("priya", "getMyCases")).length;
    await resident.goto("/my/report");
    await resident.getByRole("tab", { name: "Use the form" }).click();
    await resident.getByLabel("What kind of problem?").selectOption("PLUMBING");
    await resident.getByLabel("Describe it").fill("The toilet keeps running after every flush.");
    await resident.getByTestId("q-fixture").getByRole("combobox").selectOption("toilet");
    for (const k of ["activeLeak", "spreading", "waterNearElectrical"]) await resident.getByTestId(`q-${k}`).getByText("No", { exact: true }).click();
    await resident.getByRole("button", { name: "Submit report" }).dblclick();
    await expect(resident.getByText(/Your report is saved as RLY-\d{4}/)).toBeVisible();
    expect((await api("priya", "getMyCases")).length).toBe(before + 1);
  });
  test("with the AI offline, the resident is told and the form works", async () => {
    const ai = await api("priya", "getAiStatus");
    test.skip(ai.available, "the model is available on this server");
    await resident.goto("/my/report");
    await resident.getByRole("tab", { name: "Chat with Relay" }).click();
    await expect(resident.getByText("Relay's assistant is offline").first()).toBeVisible();
  });
  test("the discovery provider is down: the failure is explained and a vendor can be added by hand", async () => {
    await hook("fiber", { scenario: "down" });
    const unitId = (await api("priya", "getMe")).units[0].id;
    const { caseId } = await api("priya", "reportIssue", { unitId, clientRequestId: crypto.randomUUID(), description: "Half the outlets in the bedroom stopped working.", categoryHint: "ELECTRICAL", details: { what: "outlets", burningOrSparks: false, waterNearby: false } });
    await manager.goto(`/ops/cases/${caseId}`);
    await expect(manager.getByText("Search failed").first()).toBeVisible({ timeout: 90_000 });
    await expect(manager.getByTestId("discovery-search").first()).toContainText(/could not be reached/);
    await manager.getByRole("button", { name: "Add a vendor you trust" }).click();
    await manager.getByLabel("Name").fill("Test vendor Brightline Electric");
    await manager.getByLabel("Phone").fill("519-555-0190");
    await manager.getByRole("button", { name: "Add and approve" }).click();
    await expect(manager.getByText("Test vendor Brightline Electric", { exact: true }).first()).toBeVisible();
    await manager.getByRole("radio").first().check();
    await manager.getByRole("button", { name: "Send the job offer" }).click();
    await expect(manager.getByRole("heading", { name: "Offer sent" })).toBeVisible();
  });
  test("email not configured: the manager is told notifications are in-app only", async () => {
    await hook("env", { set: { SMTP_HOST: "" } });
    await manager.goto("/ops/settings");
    await expect(manager.getByText(/Email is not configured on this server/)).toBeVisible();
    await hook("env", { set: { SMTP_HOST: "localhost" } });
  });
});

test.describe("6. the chat safety net: nothing a resident writes is left with no one", () => {
  let resident: Page, manager: Page;
  test.beforeAll(async ({ browser }) => {
    await resetCases();
    resident = await signIn(browser, "priya", PHONE);
    manager = await signIn(browser, "morgan");
  });
  test("a possible emergency typed into the chat is filed at once by the safety rules", async () => {
    await resident.goto("/my/report");
    await resident.getByRole("tab", { name: "Chat with Relay" }).click();
    await resident.getByLabel("Message to Relay").fill("There's a strong smell of gas in my kitchen.");
    await resident.getByRole("button", { name: "Send" }).click();
    await expect(resident.getByText(/passed it to your property manager straight away/)).toBeVisible();
    await expect(resident.getByText(/Leave the unit now/)).toBeVisible();
    await expect(resident.getByText(/Filed as RLY-\d{4}/)).toBeVisible();
  });
  test("with the assistant offline, a manager reads the chat and files it from the command center", async () => {
    const ai = await api("priya", "getAiStatus");
    test.skip(ai.available, "the model is available on this server");
    await resident.goto("/my/report");
    await resident.getByRole("tab", { name: "Chat with Relay" }).click();
    await resident.getByLabel("Message to Relay").fill("The bathroom fan has become very loud.");
    await resident.getByRole("button", { name: "Send" }).click();
    await expect(resident.getByText(/passed it to your property manager so a person reads it/)).toBeVisible({ timeout: 60_000 });
    await manager.goto("/ops");
    const panel = manager.getByTestId("unfinished-chats");
    await expect(panel).toContainText("Priya Nair");
    await expect(panel).toContainText("The bathroom fan has become very loud.");
    await panel.getByRole("button", { name: "File it as a case" }).click();
    await expect(manager).toHaveURL(/\/ops\/cases\//);
    await expect(manager.getByText("The bathroom fan has become very loud.").first()).toBeVisible();
    // The resident has usually left the chat by now: they are told in their inbox that a person filed it.
    await resident.goto("/my");
    await resident.getByRole("button", { name: /Notifications/ }).click();
    await expect(resident.getByText(/Your report was filed: RLY-\d{4}/).first()).toBeVisible();
    await resident.keyboard.press("Escape");
  });
});
