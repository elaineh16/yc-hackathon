// The acceptance journey in real browsers: a resident, a manager and a contractor work the same persisted case
// from report to RESOLVED. Each step is done through the UI; nothing is called behind the pages' backs.
import { type Page, expect, test } from "@playwright/test";
import { resetCases, shot, signIn } from "./helpers";

test.describe.configure({ mode: "serial" });

let resident: Page, manager: Page, contractor: Page;
let casePath = "";

test.beforeAll(async ({ browser }) => {
  await resetCases();
  resident = await signIn(browser, "priya", { width: 430, height: 932 });
  manager = await signIn(browser, "morgan");
  contractor = await signIn(browser, "sam", { width: 430, height: 932 });
});

test("1-2. the resident reports a leaking kitchen sink and it is saved", async () => {
  await expect(resident).toHaveURL(/\/my$/);
  await resident.getByRole("main").getByRole("link", { name: "Report a problem" }).first().click();
  await expect(resident).toHaveURL(/\/my\/report$/);
  await resident.getByRole("tab", { name: "Use the form" }).click();
  await resident.getByLabel("What kind of problem?").selectOption("PLUMBING");
  await resident.getByLabel("Describe it").fill("The kitchen sink is leaking under the cabinet. Water is pooling inside the cabinet.");
  await resident.getByTestId("q-fixture").getByRole("combobox").selectOption("kitchen_sink");
  await resident.getByTestId("q-activeLeak").getByText("Yes", { exact: true }).click();
  await resident.getByTestId("q-spreading").getByText("No", { exact: true }).click();
  await resident.getByTestId("q-waterNearElectrical").getByText("No", { exact: true }).click();
  await resident.getByTestId("q-canShutOff").getByText("Yes", { exact: true }).click();
  await resident.getByLabel("The vendor may enter if I am not home").check();
  await shot(resident, "resident-report-form");
  await resident.getByRole("button", { name: "Submit report" }).click();
  await expect(resident.getByText(/Your report is saved as RLY-\d{4}/)).toBeVisible();
  await resident.getByRole("button", { name: "Follow this request" }).click();
  await expect(resident).toHaveURL(/\/my\/cases\//);
  casePath = new URL(resident.url()).pathname.replace("/my/cases/", "");
  await expect(resident.getByTestId("next-action")).toContainText("Waiting on the manager");
  await shot(resident, "resident-case-submitted");
});

test("3-4. the manager sees the real case and assigns an approved plumber", async () => {
  await manager.goto("/ops");
  await expect(manager.getByRole("heading", { name: "Your move" })).toBeVisible();
  await manager.getByRole("link", { name: /Leak at the kitchen sink/ }).first().click();
  await expect(manager).toHaveURL(new RegExp(`/ops/cases/${casePath}`));
  await expect(manager.getByTestId("next-action")).toContainText("Your move");
  await expect(manager.getByRole("heading", { name: "Assign a vendor" })).toBeVisible();
  await shot(manager, "manager-case-new");
  await manager.getByText("Northside Plumbing", { exact: true }).click();
  await manager.getByRole("button", { name: "Send the job offer" }).click();
  await expect(manager.getByRole("heading", { name: "Offer sent" })).toBeVisible();
});

test("5-6. the contractor receives it and responds with an estimate and availability", async () => {
  await contractor.goto("/jobs");
  await expect(contractor.getByRole("heading", { name: /New offers/ })).toBeVisible();
  await contractor.getByRole("link", { name: /Leak at the kitchen sink/ }).click();
  await expect(contractor.getByRole("heading", { name: "New job offer" })).toBeVisible();
  await contractor.getByLabel("Estimate (CAD, all in)").fill("320");
  await contractor.getByLabel("What it covers").fill("Replace the P-trap and the supply line, parts and labour");
  await shot(contractor, "contractor-offer");
  await contractor.getByRole("button", { name: "Accept the job" }).click();
  await expect(contractor.getByRole("heading", { name: "Waiting for the resident" })).toBeVisible();
});

test("the resident chooses a time; it waits for the manager's approval", async () => {
  await resident.goto(`/my/cases/${casePath}`);
  await expect(resident.getByRole("heading", { name: "Choose a visit time" })).toBeVisible();
  await resident.getByRole("button", { name: /Choose$/ }).first().click();
  await expect(resident.getByText(/Waiting for the manager's approval/)).toBeVisible();
});

test("7-8. the manager approves; the visit is confirmed because everyone agreed", async () => {
  await manager.goto(`/ops/cases/${casePath}`);
  await expect(manager.getByRole("heading", { name: "Approve the estimate" })).toBeVisible();
  await expect(manager.getByText(/already chosen a visit time/)).toBeVisible();
  await shot(manager, "manager-approval");
  await manager.getByRole("button", { name: /^Approve \$/ }).click();
  await expect(manager.getByTestId("next-action")).toContainText("Scheduled");
});

test("9. the resident sees the confirmed visit and the timeline", async () => {
  await resident.goto(`/my/cases/${casePath}`);
  await expect(resident.getByText(/Visit confirmed:/)).toBeVisible();
  await expect(resident.getByTestId("timeline")).toContainText("Visit confirmed with Northside Plumbing");
  await shot(resident, "resident-visit-confirmed");
});

test("10. the contractor does the work and reports it complete", async () => {
  await contractor.goto(`/jobs/${casePath}`);
  await contractor.getByRole("button", { name: "Start work" }).click();
  await expect(contractor.getByRole("heading", { name: "Work in progress" })).toBeVisible();
  await contractor.getByLabel("Progress update").fill("Old trap was cracked; replacing it now.");
  await contractor.getByRole("button", { name: "Post" }).click();
  await contractor.getByLabel("What did you do?").fill("Replaced the cracked P-trap and the supply line. No leaks after a 20 minute test.");
  await contractor.getByLabel("Final cost (CAD, optional)").fill("310");
  await contractor.getByRole("button", { name: "Mark work complete" }).click();
  await expect(contractor.getByText("Waiting for the resident to confirm the fix.")).toBeVisible();
  await shot(contractor, "contractor-complete");
});

test("11-12. the resident verifies and the case is RESOLVED with its full history", async () => {
  await resident.goto(`/my/cases/${casePath}`);
  await expect(resident.getByRole("heading", { name: "Is it fixed?" })).toBeVisible();
  await resident.getByRole("button", { name: "Yes, it's fixed" }).click();
  await expect(resident.getByTestId("next-action")).toContainText("This case is closed.");
  await shot(resident, "resident-resolved");
  await manager.goto(`/ops/cases/${casePath}`);
  await expect(manager.getByTestId("next-action")).toContainText("Resolved");
  const history = manager.getByTestId("timeline");
  for (const text of ["reported", "Triaged as plumbing", "Offered to Northside Plumbing", "accepted with an estimate of $320", "approved up to", "Visit confirmed", "started work", "reported the work complete", "confirmed the problem is fixed"]) {
    await expect(history).toContainText(text);
  }
  await shot(manager, "manager-case-resolved");
});
