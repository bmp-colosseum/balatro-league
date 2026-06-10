// Vitest globalSetup for integration tests: boot a throwaway real Postgres
// (downloaded binary, no Docker/install), push the Prisma schema into it, and
// write the connection URL to a file the per-worker setup reads. Torn down
// after the run. Tests hit a REAL database — high fidelity, fully local.

import EmbeddedPostgres from "embedded-postgres";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 54329;
const URL_FILE = join(process.cwd(), ".vitest-pg-url");

let pg: EmbeddedPostgres | null = null;
let dir: string | null = null;

export async function setup(): Promise<void> {
  dir = mkdtempSync(join(tmpdir(), "bl-itest-"));
  pg = new EmbeddedPostgres({
    databaseDir: dir,
    user: "postgres",
    password: "postgres",
    port: PORT,
    persistent: false,
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("test");

  const url = `postgresql://postgres:postgres@localhost:${PORT}/test`;
  writeFileSync(URL_FILE, url);

  // Create the schema. db push is fast and needs no migration history.
  execSync("npx prisma db push --schema=prisma/schema.prisma --skip-generate --accept-data-loss", {
    env: { ...process.env, DATABASE_URL: url },
    stdio: "ignore",
  });
}

export async function teardown(): Promise<void> {
  try { if (pg) await pg.stop(); } catch { /* best effort */ }
  try { if (dir) rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  try { rmSync(URL_FILE, { force: true }); } catch { /* best effort */ }
}
