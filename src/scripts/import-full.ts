// Rebuild the database from a full JSON export (export-full.ts). Inserts
// every model in FK-safe order with createMany(skipDuplicates), so it's
// safe to run against an empty DB to restore, or against an existing one to
// backfill missing rows. After a schema change, transform the JSON to match
// the new shape first, then run this.
//
// Dates were serialized as ISO strings — revived to Date here. JSON columns
// (game1/game2/game3, preset arrays) are passed through untouched.
//
// Usage:
//   npm run import:full -- backups/full-export-<ts>.json
//
// NOTE: destructive only in the sense that it ADDS rows. It never deletes.
// To restore into a clean slate, wipe first, then import.

import { readFileSync } from "node:fs";
import { prisma } from "../db.js";

// FK-safe insert order: parents before children.
const ORDER = [
  "player",
  "matchConfigPreset",
  "tierTemplate",
  "leagueRulesTemplate",
  "leagueConfig",
  "roleBinding",
  "season",
  "tier",
  "division",
  "divisionMember",
  "match",
  "game",
  "gameDeck",
  "matchSession",
  "signupRound",
  "signup",
  "playerMmrSnapshot",
  "divisionStandings",
  "seasonInterest",
  "easterEggVote",
  "adminAuditEvent",
] as const;

// Revive ISO date strings back into Date objects. The pattern is strict
// enough that ids/names/JSON-string columns (game1 etc.) won't match.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
function reviver(_key: string, value: unknown): unknown {
  return typeof value === "string" && ISO_DATE.test(value) ? new Date(value) : value;
}

type AnyDelegate = { createMany: (args: { data: unknown[]; skipDuplicates: boolean }) => Promise<{ count: number }> };
const client = prisma as unknown as Record<string, AnyDelegate>;

async function main(): Promise<void> {
  const path = process.argv[2];
  if (!path) {
    console.error("Usage: npm run import:full -- <path-to-full-export.json>");
    process.exit(1);
  }
  const data = JSON.parse(readFileSync(path, "utf-8"), reviver) as Record<string, unknown[]>;

  let total = 0;
  for (const model of ORDER) {
    const rows = data[model];
    if (!Array.isArray(rows) || rows.length === 0) continue;
    const { count } = await client[model]!.createMany({ data: rows, skipDuplicates: true });
    total += count;
    console.log(`imported ${count}/${rows.length} ${model}`);
  }
  console.log(`Done — inserted ${total} rows.`);
}

await main();
