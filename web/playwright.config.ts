import { defineConfig, devices } from "@playwright/test";

// E2E against a real browser + real (embedded) Postgres. e2e/server.mjs boots
// the DB and Next; Playwright drives Chromium. Run: npm run e2e
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:3210",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "node e2e/server.mjs",
    url: "http://localhost:3210",
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
