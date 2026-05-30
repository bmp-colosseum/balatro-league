#!/usr/bin/env node
// One-shot exporter: pulls participants + matches from N Challonge brackets
// and dumps two CSVs into ./scripts/out/. Edit participants.csv to fill in
// Discord IDs, then feed it into the importer.
//
// Usage:
//   CHALLONGE_API_KEY=xxx node scripts/challonge-export.mjs <slug-or-url> [<slug-or-url> ...]
//
// Or with the key inline:
//   node scripts/challonge-export.mjs --key=xxx mzegd4q9 16jp5uuk
//
// Output:
//   scripts/out/participants.csv   division, challonge_name, discord_id
//   scripts/out/matches.csv        division, player1, player2, result, state
//   scripts/out/raw.json           full fetched data, for debugging

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = "https://api.challonge.com/v1";

function parseArgs(argv) {
  const slugs = [];
  let apiKey = process.env.CHALLONGE_API_KEY ?? "";
  for (const a of argv.slice(2)) {
    if (a.startsWith("--key=")) {
      apiKey = a.slice("--key=".length);
    } else if (a.startsWith("--")) {
      console.error(`Unknown flag: ${a}`);
      process.exit(1);
    } else {
      slugs.push(normalizeSlug(a));
    }
  }
  return { slugs, apiKey };
}

function normalizeSlug(input) {
  const m = input.match(/challonge\.com\/(?:tournaments\/)?([a-zA-Z0-9_-]+)/);
  return m ? m[1] : input;
}

async function get(path, apiKey) {
  const sep = path.includes("?") ? "&" : "?";
  const url = `${BASE}${path}${sep}api_key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Challonge API ${res.status} on ${path}: ${await res.text()}`);
  }
  return res.json();
}

function interpretScore(scoresCsv, winnerId, player1Id) {
  const raw = (scoresCsv ?? "").trim();
  if (!raw) return { ok: false, reason: "no score" };
  const matches = [...raw.matchAll(/(\d+)-(\d+)/g)];
  if (matches.length === 0) return { ok: false, reason: `unparseable: ${raw}` };
  const last = matches[matches.length - 1];
  const a = parseInt(last[1], 10);
  const b = parseInt(last[2], 10);
  if (a === 2 && b === 0) return { ok: true, result: "2-0" };
  if (a === 0 && b === 2) return { ok: true, result: "0-2" };
  if (a === 1 && b === 1) return { ok: true, result: "1-1" };
  if (winnerId != null && player1Id != null) {
    return { ok: true, result: winnerId === player1Id ? "2-0" : "0-2" };
  }
  return { ok: false, reason: `non-standard "${raw}"` };
}

// CSV-escape: wrap in quotes if value contains a comma, quote, or newline.
function csv(value) {
  const s = String(value ?? "");
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

async function main() {
  const { slugs, apiKey } = parseArgs(process.argv);
  if (!apiKey) {
    console.error("Missing API key — set CHALLONGE_API_KEY env var or pass --key=...");
    process.exit(1);
  }
  if (slugs.length === 0) {
    console.error("No tournament slugs provided. Usage:");
    console.error("  node scripts/challonge-export.mjs <slug-or-url> [<slug-or-url> ...]");
    process.exit(1);
  }

  console.log(`Fetching ${slugs.length} tournament(s)...`);

  const fetched = await Promise.all(
    slugs.map(async (slug) => {
      try {
        const [tWrap, pWrap, mWrap] = await Promise.all([
          get(`/tournaments/${slug}.json`, apiKey),
          get(`/tournaments/${slug}/participants.json`, apiKey),
          get(`/tournaments/${slug}/matches.json`, apiKey),
        ]);
        const tournament = tWrap.tournament;
        const participants = pWrap.map((w) => w.participant);
        const matches = mWrap.map((w) => w.match);
        return { slug, tournament, participants, matches };
      } catch (e) {
        return { slug, error: e.message };
      }
    }),
  );

  const here = dirname(fileURLToPath(import.meta.url));
  const outDir = join(here, "out");
  mkdirSync(outDir, { recursive: true });

  // raw.json for debugging
  writeFileSync(join(outDir, "raw.json"), JSON.stringify(fetched, null, 2));

  // participants.csv — header + one row per participant per tournament
  const participantLines = ["division,challonge_name,discord_id"];
  // matches.csv — header + one row per completed match
  const matchLines = ["division,player1,player2,result,state"];

  let totalParticipants = 0;
  let totalMatches = 0;
  let totalErrors = 0;

  for (const t of fetched) {
    if (t.error) {
      console.error(`✗ ${t.slug}: ${t.error}`);
      totalErrors++;
      continue;
    }
    const divName = t.tournament.name;
    const byId = new Map(t.participants.map((p) => [p.id, p.name]));
    console.log(`✓ ${t.slug} → "${divName}" — ${t.participants.length} players, ${t.matches.filter((m) => m.state === "complete").length}/${t.matches.length} matches done`);

    for (const p of t.participants) {
      participantLines.push(`${csv(divName)},${csv(p.name)},`);
      totalParticipants++;
    }

    for (const m of t.matches) {
      const p1 = byId.get(m.player1_id) ?? "?";
      const p2 = byId.get(m.player2_id) ?? "?";
      const interp = m.state === "complete"
        ? interpretScore(m.scores_csv, m.winner_id, m.player1_id)
        : { ok: false, reason: "not played" };
      const result = interp.ok ? interp.result : `(${interp.reason})`;
      matchLines.push(`${csv(divName)},${csv(p1)},${csv(p2)},${csv(result)},${csv(m.state)}`);
      if (interp.ok) totalMatches++;
    }
  }

  writeFileSync(join(outDir, "participants.csv"), participantLines.join("\n") + "\n");
  writeFileSync(join(outDir, "matches.csv"), matchLines.join("\n") + "\n");

  console.log("");
  console.log(`Wrote ${outDir}/`);
  console.log(`  participants.csv  — ${totalParticipants} player rows (fill in discord_id column)`);
  console.log(`  matches.csv       — ${totalMatches} completed match rows`);
  console.log(`  raw.json          — full fetch dump`);
  if (totalErrors > 0) console.log(`  (${totalErrors} tournament(s) failed — see errors above)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
