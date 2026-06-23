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

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const webRoot = resolve(here, "..");

const SYNC = [
  { from: ["prisma", "schema.prisma"], to: ["prisma", "schema.prisma"] },
  { from: ["src", "data", "match-defaults.json"], to: ["lib", "match-defaults.json"] },
  { from: ["src", "data", "balatro-info.json"], to: ["lib", "balatro-info.json"] },
  // Pure "Elowen" hidden-MMR engine (Owen's server formula) — shared by the bot
  // (per-match updates) and the web (seeding + preview).
  { from: ["src", "elowen.ts"], to: ["lib", "elowen.ts"] },
  // Pure schedule generator (SoS-balanced 4-regular opponent graph) — shared by
  // the bot and the web (preview + season setup).
  { from: ["src", "schedule.ts"], to: ["lib", "schedule.ts"] },
  // Pure season-build placement (Owen's promotion/relegation + rookie GLB +
  // overflow). Shared by the bot and the web (preview + real build).
  { from: ["src", "owen-placement.ts"], to: ["lib", "owen-placement.ts"] },
];

for (const { from, to } of SYNC) {
  const source = resolve(repoRoot, ...from);
  const dest = resolve(webRoot, ...to);
  if (!existsSync(source)) {
    console.log(`[sync] skipping ${from.join("/")} — not found (using committed ${to.join("/")})`);
    continue;
  }
  mkdirSync(dirname(dest), { recursive: true });
  if (dest.endsWith(".ts")) {
    // The bot's TS uses NodeNext ".js" import extensions; web uses bundler
    // resolution, which can't resolve an explicit ".js" specifier to its ".ts"
    // file (Turbopack build fails). Strip the extension off relative imports so
    // the synced copy builds under Turbopack. (tsc accepted it; the bundler won't.)
    const content = readFileSync(source, "utf8").replace(/(\bfrom\s+["'])(\.\.?\/[^"']*?)\.js(["'])/g, "$1$2$3");
    writeFileSync(dest, content);
  } else {
    copyFileSync(source, dest);
  }
  console.log(`[sync] ${from.join("/")} -> ${to.join("/")}`);
}

// Sync the Balatro PNG assets from src/assets/balatro/{decks,stakes}/ to
// web/public/balatro/{decks,stakes}/ so the web app can serve them as
// static images. The bot also reads them locally for application-emoji
// upload, so source-of-truth lives on the bot side.
const ASSET_DIRS = ["decks", "stakes"];
for (const sub of ASSET_DIRS) {
  const sourceDir = resolve(repoRoot, "src", "assets", "balatro", sub);
  const destDir = resolve(webRoot, "public", "balatro", sub);
  if (!existsSync(sourceDir)) {
    console.log(`[sync] skipping balatro/${sub} — source dir not found`);
    continue;
  }
  mkdirSync(destDir, { recursive: true });
  const files = readdirSync(sourceDir).filter((f) => f.endsWith(".png"));
  for (const file of files) {
    copyFileSync(resolve(sourceDir, file), resolve(destDir, file));
  }
  console.log(`[sync] balatro/${sub}: ${files.length} PNG(s) copied`);
}
