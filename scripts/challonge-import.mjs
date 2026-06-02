#!/usr/bin/env node
// Read scripts/out/{participants,matches}.csv and push to the DB.
//
// Usage:
//   node scripts/challonge-import.mjs --season="Season 7 (imported)" [--dry-run]
//   node scripts/challonge-import.mjs --season-id=cl... [--dry-run]
//
// Expects participants.csv with columns: division, challonge_name, discord_id
//          matches.csv      with columns: division, player1, player2, result, state
//
// What it does:
//   - For each unique division in participants.csv → find the Division row
//     in the target season by name (case-insensitive, whitespace-trimmed)
//   - For each participant with a Discord ID → upsert Player + ACTIVE
//     DivisionMember
//   - For each completed match → upsert CONFIRMED Pairing
//
// Skips silently:
//   - Participant rows with empty discord_id (you forgot to fill it in)
//   - Matches where one or both players have no discord_id mapping
//   - Matches whose 'state' isn't 'complete' or whose result isn't 2-0/1-1/0-2

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "out");

function parseArgs(argv) {
  let seasonNumber = null;
  let seasonId = null;
  let dryRun = false;
  for (const a of argv.slice(2)) {
    if (a === "--dry-run") dryRun = true;
    else if (a.startsWith("--season=")) {
      const raw = a.slice("--season=".length);
      const parsed = Number(raw);
      if (!Number.isInteger(parsed)) {
        console.error(`--season expects an integer season number, got ${raw}`);
        process.exit(1);
      }
      seasonNumber = parsed;
    }
    else if (a.startsWith("--season-id=")) seasonId = a.slice("--season-id=".length);
    else {
      console.error(`Unknown arg: ${a}`);
      process.exit(1);
    }
  }
  if (seasonNumber == null && !seasonId) {
    console.error("Pass --season=<integer> or --season-id=cl...");
    process.exit(1);
  }
  return { seasonNumber, seasonId, dryRun };
}

function seasonLabel(season) {
  const base = `Season ${season.number}`;
  return season.subtitle ? `${base} — ${season.subtitle}` : base;
}

// Minimal CSV parser that handles quoted fields with commas/quotes inside.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n" || c === "\r") {
        if (field !== "" || row.length > 0) { row.push(field); rows.push(row); row = []; field = ""; }
        if (c === "\r" && text[i + 1] === "\n") i++;
      } else field += c;
    }
  }
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  if (rows.length === 0) return { headers: [], data: [] };
  const headers = rows[0].map((h) => h.trim());
  const data = rows.slice(1).map((r) => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = (r[i] ?? "").trim(); });
    return obj;
  });
  return { headers, data };
}

function norm(s) {
  return String(s ?? "").trim().toLowerCase();
}

async function main() {
  const { seasonNumber, seasonId, dryRun } = parseArgs(process.argv);

  const participantsCsv = readFileSync(join(outDir, "participants.csv"), "utf8");
  const matchesCsv = readFileSync(join(outDir, "matches.csv"), "utf8");
  const { data: participantRows } = parseCsv(participantsCsv);
  const { data: matchRows } = parseCsv(matchesCsv);

  console.log(`Loaded ${participantRows.length} participant rows, ${matchRows.length} match rows from CSV`);
  if (dryRun) console.log("--- DRY RUN MODE — no DB writes ---");

  const prisma = new PrismaClient();
  try {
    const season = seasonId
      ? await prisma.season.findUnique({ where: { id: seasonId }, include: { divisions: true } })
      : await prisma.season.findUnique({ where: { number: seasonNumber }, include: { divisions: true } });
    if (!season) {
      console.error(`Season not found (${seasonId ?? `#${seasonNumber}`}). Create it on /admin/seasons first.`);
      process.exit(1);
    }
    console.log(`Target season: "${seasonLabel(season)}" (id ${season.id}) — ${season.divisions.length} divisions`);

    // division name (lowercased+trimmed) → Division row
    const divByName = new Map(season.divisions.map((d) => [norm(d.name), d]));

    // === PASS 1: participants → Player + DivisionMember ===
    // discordId → Player id (cached so we don't upsert twice across rows)
    const playerByDiscordId = new Map();
    // "discordId|divisionId" → present
    const membershipKey = (d, dv) => `${d}|${dv}`;
    const membershipsSeen = new Set();

    let participantsAdded = 0;
    let participantsSkipped = 0;
    const unknownDivisions = new Set();
    const unmappedNames = [];

    for (const row of participantRows) {
      const discordId = row.discord_id;
      if (!discordId) {
        unmappedNames.push(`${row.division} / ${row.challonge_name}`);
        participantsSkipped++;
        continue;
      }
      const div = divByName.get(norm(row.division));
      if (!div) {
        unknownDivisions.add(row.division);
        participantsSkipped++;
        continue;
      }

      if (!dryRun) {
        const player = await prisma.player.upsert({
          where: { discordId },
          create: { discordId, displayName: row.challonge_name.trim() },
          update: { displayName: row.challonge_name.trim() },
        });
        playerByDiscordId.set(discordId, player);
        await prisma.divisionMember.upsert({
          where: { divisionId_playerId: { divisionId: div.id, playerId: player.id } },
          create: { divisionId: div.id, playerId: player.id, status: "ACTIVE" },
          update: { status: "ACTIVE", droppedAt: null, dropoutReason: null },
        });
      } else {
        // dry-run: still build the mapping so pairings preview works
        playerByDiscordId.set(discordId, { id: `dry-${discordId}`, discordId });
      }
      membershipsSeen.add(membershipKey(discordId, div.id));
      participantsAdded++;
    }

    // === PASS 2: name → discordId per division ===
    // For matches, we look up player by (division, challonge_name) → discord_id
    const nameToDiscordByDivision = new Map();
    for (const row of participantRows) {
      const key = norm(row.division);
      if (!nameToDiscordByDivision.has(key)) nameToDiscordByDivision.set(key, new Map());
      if (row.discord_id) nameToDiscordByDivision.get(key).set(norm(row.challonge_name), row.discord_id);
    }

    // === PASS 3: matches → CONFIRMED Pairing ===
    let pairingsRecorded = 0;
    let pairingsSkipped = 0;
    const matchErrors = [];

    for (const row of matchRows) {
      if (norm(row.state) !== "complete") { pairingsSkipped++; continue; }
      const div = divByName.get(norm(row.division));
      if (!div) { pairingsSkipped++; continue; }
      const nameMap = nameToDiscordByDivision.get(norm(row.division));
      if (!nameMap) { pairingsSkipped++; continue; }

      const aDiscord = nameMap.get(norm(row.player1));
      const bDiscord = nameMap.get(norm(row.player2));
      if (!aDiscord || !bDiscord) {
        matchErrors.push(`${row.division} / ${row.player1} vs ${row.player2}: missing Discord ID`);
        pairingsSkipped++;
        continue;
      }
      const result = row.result;
      if (!["2-0", "1-1", "0-2"].includes(result)) {
        matchErrors.push(`${row.division} / ${row.player1} vs ${row.player2}: result "${result}" not a 2-game series`);
        pairingsSkipped++;
        continue;
      }

      const aPlayer = playerByDiscordId.get(aDiscord);
      const bPlayer = playerByDiscordId.get(bDiscord);
      if (!aPlayer || !bPlayer) { pairingsSkipped++; continue; }

      const games = result === "2-0" ? { a: 2, b: 0 } : result === "0-2" ? { a: 0, b: 2 } : { a: 1, b: 1 };
      const [canonA, canonB] = aPlayer.id < bPlayer.id ? [aPlayer.id, bPlayer.id] : [bPlayer.id, aPlayer.id];
      const aIsCanonA = aPlayer.id === canonA;
      const gamesWonA = aIsCanonA ? games.a : games.b;
      const gamesWonB = aIsCanonA ? games.b : games.a;

      if (!dryRun) {
        await prisma.pairing.upsert({
          where: { divisionId_playerAId_playerBId: { divisionId: div.id, playerAId: canonA, playerBId: canonB } },
          create: {
            divisionId: div.id,
            playerAId: canonA,
            playerBId: canonB,
            gamesWonA,
            gamesWonB,
            status: "CONFIRMED",
            reportedAt: new Date(),
            confirmedAt: new Date(),
          },
          update: {
            gamesWonA,
            gamesWonB,
            status: "CONFIRMED",
            confirmedAt: new Date(),
          },
        });
      }
      pairingsRecorded++;
    }

    // === Summary ===
    console.log("");
    console.log(`Participants: ${participantsAdded} placed${dryRun ? " (would be)" : ""}, ${participantsSkipped} skipped`);
    console.log(`Pairings:     ${pairingsRecorded} recorded${dryRun ? " (would be)" : ""}, ${pairingsSkipped} skipped`);

    if (unknownDivisions.size > 0) {
      console.log("");
      console.log(`⚠ Unknown divisions (no matching Division row in season "${seasonLabel(season)}"):`);
      for (const d of unknownDivisions) console.log(`  - "${d}"`);
      console.log("Fix: rename the divisions on the seasons page to match Challonge, or fix the CSV.");
    }
    if (unmappedNames.length > 0) {
      console.log("");
      console.log(`⚠ ${unmappedNames.length} participant(s) with empty discord_id (skipped):`);
      for (const n of unmappedNames.slice(0, 20)) console.log(`  - ${n}`);
      if (unmappedNames.length > 20) console.log(`  ... and ${unmappedNames.length - 20} more`);
    }
    if (matchErrors.length > 0) {
      console.log("");
      console.log(`⚠ ${matchErrors.length} match(es) skipped due to errors:`);
      for (const e of matchErrors.slice(0, 20)) console.log(`  - ${e}`);
      if (matchErrors.length > 20) console.log(`  ... and ${matchErrors.length - 20} more`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
