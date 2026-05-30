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

async function fetchJson(url) {
  const res = await fetch(url, { headers: { Authorization: `Bot ${DISCORD_TOKEN}` } });
  if (res.status === 429) {
    const retryAfter = parseFloat(res.headers.get("retry-after") ?? "1");
    await new Promise((r) => setTimeout(r, Math.min(5000, retryAfter * 1000)));
    return fetchJson(url);
  }
  if (res.status === 404) return null;
  if (!res.ok) {
    console.warn(`Discord ${res.status}: ${await res.text()}`);
    return null;
  }
  return res.json();
}

// Try guild member (server-specific nick) first, then global user (works
// regardless of guild membership). Returns the best name we can find or null.
async function resolveName(userId) {
  const m = await fetchJson(`https://discord.com/api/v10/guilds/${GUILD_ID}/members/${userId}`);
  if (m) {
    const n = (m.nick || m.user?.username || "").trim();
    if (n) return n;
  }
  const u = await fetchJson(`https://discord.com/api/v10/users/${userId}`);
  if (u) return (u.global_name || u.username || "").trim() || null;
  return null;
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
    let unknown = 0;
    const unknownNames = [];

    for (const p of players) {
      const liveName = await resolveName(p.discordId);
      if (!liveName) {
        unknown++;
        unknownNames.push(`${p.displayName} (${p.discordId})`);
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
    console.log(`Updated:           ${updated}${dryRun ? " (would be)" : ""}`);
    console.log(`Already in sync:   ${unchanged}`);
    console.log(`No Discord record: ${unknown}`);
    if (unknownNames.length > 0 && unknownNames.length <= 20) {
      console.log("");
      console.log("Unknown details:");
      for (const n of unknownNames) console.log(`  - ${n}`);
    } else if (unknownNames.length > 20) {
      console.log(`(${unknownNames.length} unknown; sample below)`);
      for (const n of unknownNames.slice(0, 20)) console.log(`  - ${n}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
