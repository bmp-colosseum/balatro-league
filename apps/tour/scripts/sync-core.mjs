// Copy the shared core schema fragment into this app's prisma/schema folder so
// Prisma's multi-file merge sees one source of truth. Run after editing
// packages/match-core/prisma/core.prisma. (Mirrors the league's sync-schema.mjs.)
import { copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, "../../../packages/match-core/prisma/core.prisma");
const dest = resolve(here, "../prisma/schema/core.prisma");
copyFileSync(src, dest);
console.log(`[sync:core] ${src} -> ${dest}`);
