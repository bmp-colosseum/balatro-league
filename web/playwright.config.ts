import { defineConfig, devices } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

// E2E against a real browser + real (embedded) Postgres. e2e/server.mjs boots
// the DB and Next; Playwright drives Chromium. Run: npm run e2e
//
// Ports are picked HERE (synchronously, via a child-process call into
// scripts/lib/get-free-port.mjs — this config file doesn't use top-level
// await since it's loaded ambiguously CJS/ESM depending on the Playwright
// version) rather than inside e2e/server.mjs, because Playwright needs
// use.baseURL / webServer.url before it spawns the server command. The
// chosen ports are handed to e2e/server.mjs via webServer.env so both sides
// agree — this is what lets two concurrent `npm run e2e` runs (two agents,
// same machine) use different ports instead of colliding on a hardcoded one.
// Memoized through process.env: Playwright appears to re-evaluate this config
// module more than once within a single `npx playwright test` invocation (observed
// directly -- without this guard, each test ended up with a DIFFERENT baseURL
// port than the one e2e/server.mjs was actually told to bind, since each
// evaluation picked a fresh free port). Caching the chosen ports in process.env
// the first time makes every re-evaluation within this process see the same
// values, while a genuinely separate process (a second concurrent `playwright
// test` run) still starts with an empty env and picks its own free ports.
const portScript = resolve(process.cwd(), "scripts/lib/get-free-port.mjs");
function pickPort(): number {
  return Number(execFileSync(process.execPath, [portScript]).toString().trim());
}
function memoizedPort(envKey: string): number {
  const existing = process.env[envKey];
  if (existing) return Number(existing);
  const port = pickPort();
  process.env[envKey] = String(port);
  return port;
}
const WEB_PORT = memoizedPort("__VERIFY_E2E_WEB_PORT");
const PG_PORT = memoizedPort("__VERIFY_E2E_PG_PORT");

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "node e2e/server.mjs",
    url: `http://localhost:${WEB_PORT}`,
    env: { E2E_WEB_PORT: String(WEB_PORT), E2E_PG_PORT: String(PG_PORT) },
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
