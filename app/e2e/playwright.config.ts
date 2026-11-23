// Browser tests for Relay. They drive the running app (client :3000, server :3001 with RELAY_TEST_HOOKS=true)
// as three separate signed-in users. Run: cd app/e2e && npm install && npx playwright test
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests",
  timeout: 300_000,
  expect: { timeout: 45_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"], ["html", { open: "never", outputFolder: "report" }]],
  outputDir: "test-results",
  use: {
    baseURL: process.env.RELAY_WEB_URL ?? "http://localhost:3000",
    // Uses the Chrome installed on the machine; CI can switch to the bundled Chromium.
    channel: process.env.PW_CHANNEL === "chromium" ? undefined : "chrome",
    headless: true,
    viewport: { width: 1440, height: 900 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
