// Full JSON export — every row of every model, for rebuilding data after a
// schema change or between seasons. Unlike league-export.ts (a curated,
// human-readable seasons+standings snapshot), this dumps the WHOLE database
// table-by-table so it can be re-imported (see import-full.ts) or
// transformed by hand if the schema moved.
//
// Dates serialize as ISO strings; import-full.ts revives them. JSON columns
// (game1/game2/game3, preset decks/stakes) round-trip as-is.
//
// Usage:
//   npm run export:full                       # → backups/full-export-<ts>.json
//   npm run export:full -- backups/mine.json  # explicit path

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { buildFullExport } from "../league-export.js";

async function main(): Promise<void> {
  const { data, rowCount } = await buildFullExport();
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const path = process.argv[2] ?? `backups/full-export-${ts}.json`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");
  console.log(`Exported ${rowCount} rows → ${path}`);
}

await main();
