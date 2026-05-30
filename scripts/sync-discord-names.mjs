#!/usr/bin/env node
// One-shot: for every Player whose hasCustomDisplayName=false, look up
// their Discord guild member and overwrite displayName with the live
// Discord name (nick || username). Skips players who set their own
// custom name via /me.
//
// Use after the season-wide bulk import to retroactively flip
// "Hidden Level" → their actual Discord username for everyone who
// hasn't yet logged in to /me (which would auto-sync them anyway).
//
// Usage:
//   node scripts/sync-discord-names.mjs            # apply to all players
//   node scripts/sync-discord-names.mjs --dry-run  # preview only
//
// Reads DISCORD_TOKEN + DISCORD_GUILD_ID + DATABASE_URL from .env.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";

// dotenv-style load — Prisma client also reads DATABASE_URL but we need
// the Discord vars too.
const here = dirname(fileURLToPath(import.meta.url));
try {
  const envFile = readFileSync(join(here, "..", ".env"), "utf8");
  for (const line of envFile.split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!m) continue;
    if (process.env[m[1]] === undefined) {
      // Strip optional surrounding quotes
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
} catch {
  // No .env? Rely on whatever's already in process.env.
}

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
if (!DISCORD_TOKEN || !GUILD_ID) {
  console.error("Missing DISCORD_TOKEN or DISCORD_GUILD_ID in env.");
  process.exit(1);
}

const dryRun = process.argv.includes("--dry-run");

async function fetchMember(userId) {
  const res = await fetch(`https://discord.com/api/v10/guilds/${GUILD_ID}/members/${userId}`, {
    headers: { Authorization: `Bot ${DISCORD_TOKEN}` },
  });
  if (res.status === 429) {
    const retryAfter = parseFloat(res.headers.get("retry-after") ?? "1");
    await new Promise((r) => setTimeout(r, Math.min(5000, retryAfter * 1000)));
    return fetchMember(userId);
  }
  if (res.status === 404) return null;
  if (!res.ok) {
    console.warn(`[${userId}] Discord ${res.status}: ${await res.text()}`);
    return null;
  }
  return res.json();
}

async function main() {
  const prisma = new PrismaClient();
  try {
    const players = await prisma.player.findMany({
      where: { hasCustomDisplayName: false },
      orderBy: { displayName: "asc" },
    });
    console.log(`${players.length} player(s) eligible for sync (hasCustomDisplayName=false)`);
    if (dryRun) console.log("--- DRY RUN — no DB writes ---");

    let updated = 0;
    let unchanged = 0;
    let notInGuild = 0;
    const notFoundNames = [];

    for (const p of players) {
      const m = await fetchMember(p.discordId);
      if (!m) {
        notInGuild++;
        notFoundNames.push(`${p.displayName} (${p.discordId})`);
        continue;
      }
      const liveName = (m.nick || m.user?.username || "").trim();
      if (!liveName) {
        notInGuild++;
        continue;
      }
      if (liveName === p.displayName) {
        unchanged++;
        continue;
      }
      console.log(`  ${p.displayName.padEnd(30)} → ${liveName}`);
      if (!dryRun) {
        await prisma.player.update({
          where: { id: p.id },
          data: { displayName: liveName },
        });
      }
      updated++;
    }

    console.log("");
    console.log(`Updated:        ${updated}${dryRun ? " (would be)" : ""}`);
    console.log(`Already in sync: ${unchanged}`);
    console.log(`Not in guild:   ${notInGuild}`);
    if (notFoundNames.length > 0 && notFoundNames.length <= 20) {
      console.log("");
      console.log("Not-in-guild details:");
      for (const n of notFoundNames) console.log(`  - ${n}`);
    } else if (notFoundNames.length > 20) {
      console.log(`(${notFoundNames.length} not-in-guild; sample below)`);
      for (const n of notFoundNames.slice(0, 20)) console.log(`  - ${n}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
