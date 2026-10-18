// Prisma 7 CLI config for the web project (generate, db push). Web never
// migrates: the bot owns migrations (root prisma.config.ts), so there is no
// migrations path here.
//
// DATABASE_URL is read from process.env directly, NOT through the env() helper
// from "prisma/config": env() throws when the variable is unset, and both the
// docker `npm ci` postinstall (prisma generate) and `next build` run with no
// DATABASE_URL. dotenv is optional: a missing .env is non-fatal.
import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url: process.env.DATABASE_URL,
  },
});
