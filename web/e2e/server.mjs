// E2E webserver for Playwright: boot a throwaway embedded Postgres, push the
// Prisma schema, then start Next against it with test env. Playwright's
// webServer runs this and waits for the URL; killing it tears everything down.

import EmbeddedPostgres from "embedded-postgres";
import { execSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findFreePort } from "./../scripts/lib/get-free-port.mjs";

// playwright.config.ts picks both ports up front (so it can set use.baseURL
// and webServer.url before spawning this process) and passes them down via
// env. Running this file standalone (`node e2e/server.mjs`, no Playwright)
// falls back to picking its own free ports so it still works on its own.
const PG_PORT = Number(process.env.E2E_PG_PORT) || (await findFreePort());
const WEB_PORT = Number(process.env.E2E_WEB_PORT) || (await findFreePort());
const DB_URL = `postgresql://postgres:postgres@localhost:${PG_PORT}/e2e`;

const dir = mkdtempSync(join(tmpdir(), "bl-e2e-"));
// --encoding=UTF8 --locale=C: embedded-postgres' default initdb on Windows
// picks up the OS codepage (WIN1252), which then fails on any schema push
// whose SQL contains a non-Latin1 character (e.g. a "↑/↓" arrow quoted out
// of a Prisma schema doc-comment into a generated COMMENT ON statement).
const pg = new EmbeddedPostgres({
  databaseDir: dir,
  user: "postgres",
  password: "postgres",
  port: PG_PORT,
  persistent: false,
  initdbFlags: ["--encoding=UTF8", "--locale=C"],
});

console.log(`[e2e] starting embedded postgres on port ${PG_PORT}…`);
await pg.initialise();
await pg.start();
await pg.createDatabase("e2e");

console.log("[e2e] pushing schema…");
execSync("npx prisma db push --schema=./prisma/schema.prisma", {
  env: { ...process.env, DATABASE_URL: DB_URL },
  stdio: "inherit",
});

const env = {
  ...process.env,
  DATABASE_URL: DB_URL,
  E2E_TEST_MODE: "true",
  AUTH_SECRET: "e2e-test-secret-not-for-prod",
  NEXTAUTH_URL: `http://localhost:${WEB_PORT}`,
  DISCORD_TOKEN: "e2e",
  DISCORD_CLIENT_ID: "0",
  DISCORD_CLIENT_SECRET: "0",
  LEAGUE_OWNER_DISCORD_ID: "e2e-owner",
  ADMIN_TOKEN: "e2e-admin-token-0123456789", // for seed endpoints used by create-league E2E
};

console.log(`[e2e] starting next dev on port ${WEB_PORT}…`);
const next = spawn("npx", ["next", "dev", "-p", String(WEB_PORT)], { env, stdio: "inherit", shell: true });

let cleaning = false;
async function cleanup() {
  if (cleaning) return;
  cleaning = true;
  try { next.kill(); } catch { /* ignore */ }
  try { await pg.stop(); } catch { /* ignore */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(0);
}
process.on("SIGTERM", cleanup);
process.on("SIGINT", cleanup);
next.on("exit", cleanup);
