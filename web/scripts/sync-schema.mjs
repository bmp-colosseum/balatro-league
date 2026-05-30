// Copy the root prisma/schema.prisma into web/prisma/ so the web's Prisma
// client always matches the bot's. Runs in postinstall (before prisma generate).
//
// If the root schema isn't present (e.g. a Railway build that only ships
// the web subtree), this falls back silently and uses whatever's already in
// web/prisma/schema.prisma — better than failing the deploy.

import { copyFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, "..", "..", "prisma", "schema.prisma");
const dest = resolve(here, "..", "prisma", "schema.prisma");

if (!existsSync(source)) {
  console.log(`[sync-schema] source schema not found at ${source}; skipping (using existing web/prisma/schema.prisma)`);
  process.exit(0);
}

copyFileSync(source, dest);
console.log(`[sync-schema] copied ${source} -> ${dest}`);
