// E2E webserver for Playwright: boot a throwaway embedded Postgres, push the
// Prisma schema, then start Next against it with test env. Playwright's
// webServer runs this and waits for the URL; killing it tears everything down.

import EmbeddedPostgres from "embedded-postgres";
import { execSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PG_PORT = 54330;
const WEB_PORT = 3210;
const DB_URL = `postgresql://postgres:postgres@localhost:${PG_PORT}/e2e`;

const dir = mkdtempSync(join(tmpdir(), "bl-e2e-"));
const pg = new EmbeddedPostgres({
  databaseDir: dir,
  user: "postgres",
  password: "postgres",
  port: PG_PORT,
  persistent: false,
});

console.log("[e2e] starting embedded postgres…");
await pg.initialise();
await pg.start();
await pg.createDatabase("e2e");

console.log("[e2e] pushing schema…");
execSync("npx prisma db push --schema=./prisma/schema.prisma --skip-generate --accept-data-loss", {
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

console.log("[e2e] starting next dev…");
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
