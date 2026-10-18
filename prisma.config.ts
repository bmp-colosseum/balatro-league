// Prisma 7 CLI config (migrate deploy, db push, generate). Prisma 7 does not
// load .env itself, so dotenv is imported here; a missing .env is non-fatal
// (dotenv ignores it), which keeps prod containers, integration tests and
// verify-env working when DATABASE_URL is injected directly.
//
// DATABASE_URL is read from process.env directly, NOT through the env() helper
// from "prisma/config": env() throws when the variable is unset, and the
// docker `npm ci` postinstall runs `prisma generate` with no DATABASE_URL.
import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env.DATABASE_URL,
  },
});
