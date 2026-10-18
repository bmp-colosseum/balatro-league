#!/usr/bin/env node
// Export every REAL league player (name + Discord ID) to league-players.csv.
// This is the reference Team Tour uses to auto-fill Discord IDs for imported
// players (most TT players also play the league, so this resolves the bulk
// without hand-mapping). Run it against the live league DB, then drop the CSV
// into apps/tour/ and run the TT export.
//
// Usage:
//   node scripts/export-league-players.mjs
//
// Reads DATABASE_URL from .env. Skips seeded/fake players (non-snowflake ids).

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

const here = dirname(fileURLToPath(import.meta.url));
try {
  const envFile = readFileSync(join(here, "..", ".env"), "utf8");
  for (const line of envFile.split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!m) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {
  // no .env — assume DATABASE_URL is already in the environment
}

const SNOWFLAKE = /^\d{17,20}$/;
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, max: 5, connectionTimeoutMillis: 20000, idleTimeoutMillis: 10000 }) });

const players = await prisma.player.findMany({ select: { displayName: true, discordId: true } });
const real = players.filter((p) => SNOWFLAKE.test(p.discordId));
real.sort((a, b) => a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" }));

// displayName first, discordId last (snowflake has no comma; a name with commas
// is still recoverable as everything between the first comma and the last).
const lines = ["displayName,discordId", ...real.map((p) => `${p.displayName},${p.discordId}`)];
const out = join(here, "..", "league-players.csv");
writeFileSync(out, lines.join("\n") + "\n");
console.log(`[export-league] wrote ${real.length} real players (skipped ${players.length - real.length} seeded/fake) → ${out}`);
await prisma.$disconnect();
