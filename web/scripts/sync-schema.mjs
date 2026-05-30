// Sync files from the bot's source tree into web/ so both projects can import
// shared content locally without escaping their respective tsconfig roots.
// Runs in web's postinstall (before prisma generate).
//
// Synced files:
//   prisma/schema.prisma         -> web/prisma/schema.prisma
//   src/data/match-defaults.json -> web/lib/match-defaults.json
//
// If a source file isn't present (e.g. a Railway build that somehow only ships
// the web subtree), the existing committed copy is used — never fail the deploy
// because of a missing optional sync.

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const webRoot = resolve(here, "..");

const SYNC = [
  { from: ["prisma", "schema.prisma"], to: ["prisma", "schema.prisma"] },
  { from: ["src", "data", "match-defaults.json"], to: ["lib", "match-defaults.json"] },
];

for (const { from, to } of SYNC) {
  const source = resolve(repoRoot, ...from);
  const dest = resolve(webRoot, ...to);
  if (!existsSync(source)) {
    console.log(`[sync] skipping ${from.join("/")} — not found (using committed ${to.join("/")})`);
    continue;
  }
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(source, dest);
  console.log(`[sync] ${from.join("/")} -> ${to.join("/")}`);
}
