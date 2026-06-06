// Fabricates realistic COMPLETED matches for a built season so the stats
// pages (most-banned decks, deck usage/win-rate, DCs, shootouts) have data
// to show. Mirrors how the real flow stores results: a CONFIRMED Pairing
// plus a linked MatchSession whose game1/game2(/game3) JSON carries the
// ban/pick GameState the stats loader reads.
//
// For each division it round-robins the members, plays ~most pairs, and
// for each played pair generates per-game state that follows the real ban
// policy (pool of 9 → 7 bans → 2 remain → 1 picked). A slice of games are
// disconnect-forfeits (dcByPlayerId set + hadDc on the Pairing), and a few
// drawn pairs also get a Shootout row.
//
// Deterministic (seeded RNG) so reruns are stable. Safe: only touches the
// target season's divisions, and --reset clears this season's seeded
// pairings / sessions / shootouts first.
//
// Usage:
//   npm run seed:test-matches                 # active season
//   npm run seed:test-matches -- --season 3   # by season number
//   npm run seed:test-matches -- --reset      # clear this season's matches first
//   npm run seed:test-matches -- --play 0.8   # fraction of pairs played (default 0.8)

import { MatchSessionState } from "@prisma/client";
import { prisma } from "../db.js";
import { generatePool } from "../match-config.js";
import { presetForSeason } from "../match-config.js";
import { recomputeDivisionStandings } from "../standings-cache.js";
import defaults from "../data/match-defaults.json" with { type: "json" };
import type { GameState } from "../match-session.js";
import type { DeckEntry } from "../match-config.js";

interface Args {
  seasonNumber: number | null;
  reset: boolean;
  playFraction: number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | null => {
    const idx = argv.indexOf(flag);
    if (idx === -1 || idx === argv.length - 1) return null;
    return argv[idx + 1] ?? null;
  };
  const seasonRaw = get("--season");
  const playRaw = get("--play");
  return {
    seasonNumber: seasonRaw != null ? parseInt(seasonRaw, 10) : null,
    reset: argv.includes("--reset"),
    playFraction: playRaw != null ? Math.min(1, Math.max(0, parseFloat(playRaw))) : 0.8,
  };
}

// Deterministic PRNG (FNV-1a seed → mulberry32) so seeds are reproducible.
function makeRng(seedStr: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seedStr.length; i++) {
    h ^= seedStr.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let a = h >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(arr: T[], rng: () => number): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

const POOL_SIZE = 9;
const TOTAL_BANS = 7; // 1 (first) + 3 (second) + 3 (first) → 2 remain, second picks 1

// Build one game's GameState following the real ban policy. A DC game
// still carries bans/pick (the ban phase happened, then someone dropped),
// plus dcByPlayerId — the stats loader skips DC games for deck stats but
// the Pairing's hadDc flag still flips.
function generateGame(
  rng: () => number,
  pool: DeckEntry[],
  firstId: string,
  winnerId: string,
  dcByPlayerId?: string,
): GameState {
  const order = shuffle(
    Array.from({ length: pool.length }, (_, i) => i),
    rng,
  );
  const bans = order.slice(0, TOTAL_BANS).sort((x, y) => x - y);
  const remaining = order.slice(TOTAL_BANS);
  const pickedDeckIdx = remaining[Math.floor(rng() * remaining.length)]!;
  const game: GameState = { firstId, bans, pickedDeckIdx, winnerId, pool };
  if (dcByPlayerId) game.dcByPlayerId = dcByPlayerId;
  return game;
}

async function main(): Promise<void> {
  const { seasonNumber, reset, playFraction } = parseArgs();

  const season = seasonNumber != null
    ? await prisma.season.findFirst({ where: { number: seasonNumber } })
    : await prisma.season.findFirst({ where: { isActive: true } });
  if (!season) {
    console.error(seasonNumber != null ? `No season #${seasonNumber}.` : "No active season.");
    process.exit(1);
  }

  const divisions = await prisma.division.findMany({
    where: { seasonId: season.id },
    include: { members: { where: { status: "ACTIVE" }, select: { playerId: true } } },
  });
  if (divisions.length === 0) {
    console.error("That season has no divisions yet — build it from signups first.");
    process.exit(1);
  }

  if (reset) {
    const divIds = divisions.map((d) => d.id);
    const delSessions = await prisma.matchSession.deleteMany({ where: { divisionId: { in: divIds } } });
    const delPairings = await prisma.pairing.deleteMany({ where: { divisionId: { in: divIds } } });
    const delShootouts = await prisma.shootout.deleteMany({ where: { divisionId: { in: divIds } } });
    console.log(`[reset] removed ${delSessions.count} sessions, ${delPairings.count} pairings, ${delShootouts.count} shootouts`);
  }

  // Deck/stake pool source: the season's preset, else the canonical defaults.
  const preset = await presetForSeason(season.id);
  const decks = preset?.decks?.length ? preset.decks : defaults.decks;
  const stakes = preset?.stakes?.length ? preset.stakes : defaults.stakes;

  let pairingsMade = 0;
  let gamesMade = 0;
  let dcGames = 0;
  let shootoutsMade = 0;

  for (const division of divisions) {
    const memberIds = division.members.map((m) => m.playerId);
    const rng = makeRng(`matches:${season.id}:${division.id}`);

    for (let i = 0; i < memberIds.length; i++) {
      for (let j = i + 1; j < memberIds.length; j++) {
        if (rng() > playFraction) continue; // leave some pairs unplayed
        const pA = memberIds[i]!;
        const pB = memberIds[j]!;
        // Canonical order for Pairing/Shootout rows.
        const [canonA, canonB] = pA < pB ? [pA, pB] : [pB, pA];

        // BO2: generate two games. firstId alternates between games.
        const games: GameState[] = [];
        let winsA = 0;
        let winsB = 0;
        for (let g = 0; g < 2; g++) {
          const firstId = rng() < 0.5 ? pA : pB;
          const winnerId = rng() < 0.5 ? pA : pB;
          // ~15% of games are a disconnect forfeit (loser dropped).
          const isDc = rng() < 0.15;
          const dcByPlayerId = isDc ? (winnerId === pA ? pB : pA) : undefined;
          const game = generateGame(rng, generatePool(decks, stakes, POOL_SIZE, rng), firstId, winnerId, dcByPlayerId);
          games.push(game);
          if (isDc) dcGames++;
          if (winnerId === canonA) winsA++;
          else winsB++;
        }
        const hadDc = games.some((g) => g.dcByPlayerId);

        // Create the linked MatchSession (COMPLETE) carrying the game state.
        const baseTime = (season.startedAt ?? new Date()).getTime();
        const playedAt = new Date(baseTime + Math.floor(rng() * 20) * 86400000);
        const sessionRow = await prisma.matchSession.create({
          data: {
            divisionId: division.id,
            playerAId: pA,
            playerBId: pB,
            state: MatchSessionState.COMPLETE,
            bestOf: 2,
            game1: JSON.stringify(games[0]),
            game2: JSON.stringify(games[1]),
            completedAt: playedAt,
          },
        });
        const pairing = await prisma.pairing.create({
          data: {
            divisionId: division.id,
            playerAId: canonA,
            playerBId: canonB,
            gamesWonA: winsA,
            gamesWonB: winsB,
            status: "CONFIRMED",
            reporterId: canonA,
            reportedAt: playedAt,
            confirmedAt: playedAt,
            hadDc,
          },
        });
        await prisma.matchSession.update({
          where: { id: sessionRow.id },
          data: { pairingId: pairing.id },
        });
        pairingsMade++;
        gamesMade += 2;

        // A drawn set (1-1) sometimes goes to a shootout tiebreaker.
        if (winsA === 1 && winsB === 1 && rng() < 0.5) {
          await prisma.shootout.create({
            data: {
              divisionId: division.id,
              playerAId: canonA,
              playerBId: canonB,
              winnerId: rng() < 0.5 ? canonA : canonB,
              recordedBy: "seed-test-matches",
            },
          });
          shootoutsMade++;
        }
      }
    }
  }

  // Recompute the standings CACHE for every division — the standings page
  // reads the cache (it's only refreshed when a result is written), so
  // without this the seeded matches wouldn't show up in standings.
  for (const division of divisions) {
    await recomputeDivisionStandings(division.id);
  }

  console.log(
    `Seeded ${pairingsMade} matches (${gamesMade} games, ${dcGames} DC forfeits) + ${shootoutsMade} shootouts ` +
      `across ${divisions.length} divisions of ${season.subtitle ? `Season ${season.number} — ${season.subtitle}` : `Season ${season.number}`}.`,
  );
  console.log("Standings recomputed — check /standings and /stats.");
}

await main();
