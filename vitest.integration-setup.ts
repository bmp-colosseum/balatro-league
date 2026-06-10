// Per-worker setup for integration tests: load .env (so env validation passes),
// then OVERRIDE DATABASE_URL to point at the embedded test Postgres that
// globalSetup booted. Runs before any test imports the Prisma client.
import { config } from "dotenv";
import { readFileSync } from "node:fs";
import { join } from "node:path";

config();
process.env.DATABASE_URL = readFileSync(join(process.cwd(), ".vitest-pg-url"), "utf8").trim();
