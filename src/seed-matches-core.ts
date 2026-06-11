// Core of the match-data seed, factored out so both the CLI
// (scripts/seed-test-matches.ts) and the end-to-end runner
// (scripts/seed-e2e.ts) drive the SAME fabrication logic.
//
// Fabricates realistic COMPLETED matches for a built season so the stats
// pages (most-banned decks, deck usage/win-rate, DCs, shootouts) and the
// profile traits have data to show. Mirrors how the real flow stores
// results: a CONFIRMED Pairing plus a linked MatchSession whose
// game1/game2(/game3) JSON carries the ban/pick GameState the loaders read.
//
// For each division it round-robins the members, plays ~most pairs, and
// for each played pair generates per-game state following the real ban
// policy (pool of 9 → 7 bans → 2 remain → 1 picked). A slice of games are
// disconnect-forfeits (dcByPlayerId set + hadDc on the Pairing), some use
// the 🎲 random buttons (so the Rando Brando trait can surface), and a few
// drawn pairs also get a Shootout row. Deterministic (seeded RNG).

import { prisma } from "./db.js";
import { generatePool, presetForSeason } from "./match-config.js";
import { recomputeDivisionStandings } from "./standings-cache.js";
import { writeMatchGames } from "./match-write.js";
import defaults from "./data/match-defaults.json" with { type: "json" };
import type { GameState } from "./match-session.js";
import type { DeckEntry } from "./match-config.js";

const POOL_SIZE = 9;
const TOTAL_BANS = 7; // 1 (first) + 3 (second) + 3 (first) → 2 remain, second picks 1
// How many match writes to have in flight at once. Bounded low so a big
// multi-season run coexists with the web + bot Prisma pools under the DB's
// max_connections (higher values were quick to exhaust a small Postgres).
const WRITE_CONCURRENCY = 5;

interface PreparedMatch {
  divisionId: string;
  pA: string;
  pB: string;
  canonA: string;
  canonB: string;
  games: GameState[];
  winsA: number;
  winsB: number;
  hadDc: boolean;
  playedAt: Date;
}

// Run `fn` over `items` with at most `limit` promises in flight. Workers
// pull from a shared cursor until the list is drained.
async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<unknown>,
): Promise<void> {
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const i = cursor++;
      await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
}

export interface SeedMatchesOptions {
  // Pick the target season by id (preferred), by number, or fall back to
  // the active season when neither is given.
  seasonId?: string | null;
  seasonNumber?: number | null;
  reset?: boolean;
  playFraction?: number; // 0..1, default 0.8
}

export interface SeedMatchesResult {
  seasonLabel: string;
  divisionCount: number;
  pairingsMade: number;
  gamesMade: number;
  dcGames: number;
  shootoutsMade: number;
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

// --- Personas -------------------------------------------------------------
// Uniform-random bans/picks produce NO detectable tendencies, so the profile
// traits (which look for patterns) never fire on seeded data. Instead each
// player gets a STABLE persona derived from their id — so the same player
// keeps the same tendencies across every season and the signal accumulates.
// The bans are emitted in real chronological/attribution order (NOT sorted):
//   bans[0]       = first player's first ban
//   bans[1,2,3]   = other (non-first) player's bans  (bans[1] = their first)
//   bans[4,5,6]   = first player's remaining bans
// …which is exactly what loadPlayerTraits attributes positionally and what
// the live ban flow stores (match-buttons appends bans in turn order).

const STAKE_RANK: Record<string, number> = { White: 0, Green: 1, Black: 2, Purple: 3, Gold: 4 };
function stakeRank(s: string): number {
  return STAKE_RANK[s] ?? 2;
}

interface Persona {
  pickStake: "high" | "low" | "any"; // Dr. Spectre / White Stake Warrior
  banStake: "high" | "low" | "any";
  favoriteDeck: string | null; // Deck Loyalist
  wildcard: boolean; // Wildcard — picks all over the place
  banishDeck: string | null; // {Deck} Banisher (first-ban)
  banishStake: string | null; // {Stake} Banisher (first-ban)
  ghostbuster: boolean; // bans Ghost on sight
  randomLover: boolean; // Rando Brando — leans on the 🎲 buttons
}

const FAVE_DECKS = ["Plasma", "Erratic", "Nebula", "Zodiac", "Painted", "Anaglyph", "Magic", "Checkered"];
const BANISH_DECKS = ["Erratic", "Plasma", "Abandoned", "Ghost", "Black", "Red"];
const BANISH_STAKES = ["Gold", "Purple", "Black"];

// Pure hash → stable persona for a given player id.
function personaFor(playerId: string): Persona {
  let h = 2166136261;
  for (let i = 0; i < playerId.length; i++) {
    h ^= playerId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const u = h >>> 0;
  const base: Persona = {
    pickStake: "any",
    banStake: "any",
    favoriteDeck: null,
    wildcard: false,
    banishDeck: null,
    banishStake: null,
    ghostbuster: false,
    randomLover: false,
  };
  switch (u % 8) {
    case 0:
      return { ...base, pickStake: "high", banStake: "low" }; // Dr. Spectre
    case 1:
      return { ...base, pickStake: "low", banStake: "high" }; // White Stake Warrior
    case 2:
      return { ...base, favoriteDeck: FAVE_DECKS[u % FAVE_DECKS.length]! }; // Deck Loyalist
    case 3:
      return { ...base, wildcard: true }; // Wildcard
    case 4:
      return { ...base, ghostbuster: true }; // Ghostbuster
    case 5:
      return { ...base, banishDeck: BANISH_DECKS[u % BANISH_DECKS.length]! }; // {Deck} Banisher
    case 6:
      return { ...base, banishStake: BANISH_STAKES[u % BANISH_STAKES.length]! }; // {Stake} Banisher
    default:
      return { ...base, randomLover: true }; // Rando Brando
  }
}

function pickScore(p: Persona, c: DeckEntry, rng: () => number): number {
  let s = rng() * 0.5;
  if (p.wildcard) s += rng() * 50; // strong randomness → maximal deck diversity
  if (p.favoriteDeck && c.deck === p.favoriteDeck) s += 100;
  if (p.pickStake === "high") s += stakeRank(c.stake) * 8;
  if (p.pickStake === "low") s += (4 - stakeRank(c.stake)) * 8;
  return s;
}
function banScore(p: Persona, c: DeckEntry, rng: () => number): number {
  let s = rng() * 0.5;
  if (p.ghostbuster && c.deck === "Ghost") s += 100;
  if (p.banishDeck && c.deck === p.banishDeck) s += 80;
  if (p.banishStake && c.stake === p.banishStake) s += 80;
  if (p.banStake === "low") s += (4 - stakeRank(c.stake)) * 8; // Spectre bans the gentle stakes
  if (p.banStake === "high") s += stakeRank(c.stake) * 8; // White bans the brutal stakes
  return s;
}
// Rank candidate indices by a scorer (descending). Each candidate is scored
// exactly once, so RNG consumption stays deterministic.
function rankByScore(cands: number[], scorer: (i: number) => number): number[] {
  return cands
    .map((i) => ({ i, s: scorer(i) }))
    .sort((a, b) => b.s - a.s)
    .map((x) => x.i);
}

// Build one game's GameState following the real ban policy, biased by each
// player's persona. The OTHER (non-first) player makes the final pick.
function generateGame(
  rng: () => number,
  pool: DeckEntry[],
  firstId: string,
  otherId: string,
  firstP: Persona,
  otherP: Persona,
  winnerId: string,
  dcByPlayerId?: string,
): GameState {
  void otherId;
  const all = Array.from({ length: pool.length }, (_, i) => i);

  // Other player's final pick — chosen first and excluded from the ban pool
  // so it always survives (matches "ban down to the pick" in spirit).
  const pickIdx = rankByScore(all, (i) => pickScore(otherP, pool[i]!, rng))[0]!;
  let bannable = all.filter((i) => i !== pickIdx); // pool.length - 1

  // First player's first ban → bans[0].
  const b0 = rankByScore(bannable, (i) => banScore(firstP, pool[i]!, rng))[0]!;
  bannable = bannable.filter((i) => i !== b0);

  // Other player's 3 bans → bans[1,2,3] (bans[1] is their first ban).
  const otherBans = rankByScore(bannable, (i) => banScore(otherP, pool[i]!, rng)).slice(0, 3);
  bannable = bannable.filter((i) => !otherBans.includes(i));

  // First player's remaining 3 bans → bans[4,5,6] (1 index left over = the
  // second survivor, never banned).
  const firstRest = rankByScore(bannable, (i) => banScore(firstP, pool[i]!, rng)).slice(0, 3);

  const bans = [b0, ...otherBans, ...firstRest];
  const game: GameState = { firstId, bans, pickedDeckIdx: pickIdx, winnerId, pool };
  if (dcByPlayerId) game.dcByPlayerId = dcByPlayerId;

  // 🎲 random-button usage — heavy for randomLovers, a sprinkle otherwise.
  if (rng() < (firstP.randomLover ? 0.7 : 0.06)) game.firstBannedRandomly = true;
  if (rng() < (otherP.randomLover ? 0.7 : 0.06)) game.otherBannedRandomly = true;
  if (rng() < (otherP.randomLover ? 0.6 : 0.06)) game.pickedRandomly = true;
  return game;
}

export async function seedTestMatches(opts: SeedMatchesOptions): Promise<SeedMatchesResult> {
  const playFraction = opts.playFraction != null ? Math.min(1, Math.max(0, opts.playFraction)) : 0.8;

  const season = opts.seasonId
    ? await prisma.season.findUnique({ where: { id: opts.seasonId } })
    : opts.seasonNumber != null
      ? await prisma.season.findFirst({ where: { number: opts.seasonNumber } })
      : await prisma.season.findFirst({ where: { isActive: true } });
  if (!season) {
    throw new Error(
      opts.seasonId
        ? `No season ${opts.seasonId}.`
        : opts.seasonNumber != null
          ? `No season #${opts.seasonNumber}.`
          : "No active season.",
    );
  }

  const divisions = await prisma.division.findMany({
    where: { seasonId: season.id },
    include: { members: { where: { status: "ACTIVE" }, select: { playerId: true } } },
  });
  if (divisions.length === 0) {
    throw new Error("That season has no divisions yet — build it from signups first.");
  }

  if (opts.reset) {
    const divIds = divisions.map((d) => d.id);
    await prisma.matchSession.deleteMany({ where: { divisionId: { in: divIds } } });
    await prisma.match.deleteMany({ where: { divisionId: { in: divIds } } });
  }

  // Deck/stake pool source: the season's preset, else the canonical defaults.
  const preset = await presetForSeason(season.id);
  const decks = preset?.decks?.length ? preset.decks : defaults.decks;
  const stakes = preset?.stakes?.length ? preset.stakes : defaults.stakes;

  // Phase A — deterministic, in-memory: consume the RNG in a fixed order
  // (per division) to fabricate every played pair's game state. Keeping all
  // RNG draws here (no DB awaits interleaved) means the parallel write phase
  // below can't perturb determinism: same seed → same data, every run.
  const baseTime = (season.startedAt ?? new Date()).getTime();
  let dcGames = 0;
  const prepared: PreparedMatch[] = [];

  for (const division of divisions) {
    const memberIds = division.members.map((m) => m.playerId);
    const rng = makeRng(`matches:${season.id}:${division.id}`);

    for (let i = 0; i < memberIds.length; i++) {
      for (let j = i + 1; j < memberIds.length; j++) {
        if (rng() > playFraction) continue; // leave some pairs unplayed
        const pA = memberIds[i]!;
        const pB = memberIds[j]!;
        const [canonA, canonB] = pA < pB ? [pA, pB] : [pB, pA];

        const personaA = personaFor(pA);
        const personaB = personaFor(pB);
        const games: GameState[] = [];
        let winsA = 0;
        let winsB = 0;
        for (let g = 0; g < 2; g++) {
          const firstId = rng() < 0.5 ? pA : pB;
          const otherId = firstId === pA ? pB : pA;
          const firstP = firstId === pA ? personaA : personaB;
          const otherP = otherId === pA ? personaA : personaB;
          const winnerId = rng() < 0.5 ? pA : pB;
          const isDc = rng() < 0.15;
          const dcByPlayerId = isDc ? (winnerId === pA ? pB : pA) : undefined;
          const game = generateGame(
            rng,
            generatePool(decks, stakes, POOL_SIZE, rng),
            firstId,
            otherId,
            firstP,
            otherP,
            winnerId,
            dcByPlayerId,
          );
          games.push(game);
          if (isDc) dcGames++;
          if (winnerId === canonA) winsA++;
          else winsB++;
        }
        const hadDc = games.some((g) => g.dcByPlayerId);
        const playedAt = new Date(baseTime + Math.floor(rng() * 20) * 86400000);

        prepared.push({
          divisionId: division.id,
          pA,
          pB,
          canonA,
          canonB,
          games,
          winsA,
          winsB,
          hadDc,
          playedAt,
        });
      }
    }
  }

  // Phase B — parallel writes. Each prepared match becomes a Match (+ its
  // Game/GameDeck rows via writeMatchGames), plus an optional shootout Match.
  // Bounded concurrency keeps the Prisma connection pool from being swamped.
  await runWithConcurrency(prepared, WRITE_CONCURRENCY, async (p) => {
    const winnerId = p.winsA > p.winsB ? p.canonA : p.winsB > p.winsA ? p.canonB : null;
    const match = await prisma.match.create({
      data: {
        divisionId: p.divisionId,
        playerAId: p.canonA,
        playerBId: p.canonB,
        format: "LEAGUE_BO2",
        gamesWonA: p.winsA,
        gamesWonB: p.winsB,
        winnerId,
        status: "CONFIRMED",
        reporterId: p.canonA,
        reportedAt: p.playedAt,
        confirmedAt: p.playedAt,
        hadDc: p.hadDc,
      },
    });
    await writeMatchGames(match.id, p.canonA, p.canonB, p.games);
  });

  // Showdowns are a TIEBREAKER, not a coin-flip on every draw: create one only
  // for a pair that drew their head-to-head (1-1) AND finished tied on total
  // points — the real condition for a showdown. Points are from regular
  // matches only (showdowns don't score).
  const pointsByPlayer = new Map<string, number>();
  const addPts = (id: string, pts: number) => pointsByPlayer.set(id, (pointsByPlayer.get(id) ?? 0) + pts);
  for (const p of prepared) {
    if (p.winsA === 2) addPts(p.canonA, 3);
    else if (p.winsB === 2) addPts(p.canonB, 3);
    else {
      addPts(p.canonA, 1);
      addPts(p.canonB, 1);
    }
  }
  const showdownPairs = prepared.filter(
    (p) => p.winsA === 1 && p.winsB === 1 && pointsByPlayer.get(p.canonA) === pointsByPlayer.get(p.canonB),
  );
  await runWithConcurrency(showdownPairs, WRITE_CONCURRENCY, async (p) => {
    const rng = makeRng(`showdown:${p.divisionId}:${p.canonA}:${p.canonB}`);
    const winnerId = rng() < 0.5 ? p.canonA : p.canonB;
    const sFirst = rng() < 0.5 ? p.canonA : p.canonB;
    const sOther = sFirst === p.canonA ? p.canonB : p.canonA;
    const game = generateGame(rng, generatePool(decks, stakes, POOL_SIZE, rng), sFirst, sOther, personaFor(sFirst), personaFor(sOther), winnerId);
    const shootout = await prisma.match.create({
      data: {
        divisionId: p.divisionId,
        playerAId: p.canonA,
        playerBId: p.canonB,
        format: "SHOOTOUT_BO1",
        gamesWonA: winnerId === p.canonA ? 1 : 0,
        gamesWonB: winnerId === p.canonB ? 1 : 0,
        winnerId,
        status: "CONFIRMED",
        reportedAt: p.playedAt,
        confirmedAt: p.playedAt,
        recordedBy: "seed-test-matches",
      },
    });
    await writeMatchGames(shootout.id, p.canonA, p.canonB, [game]);
  });
  const shootoutsMade = showdownPairs.length;
  const pairingsMade = prepared.length;
  const gamesMade = prepared.length * 2;

  // Phase C — recompute the standings CACHE for every division (the
  // standings page reads the cache; it only refreshes on result writes).
  // Independent per division, so run them concurrently too.
  await runWithConcurrency(divisions, WRITE_CONCURRENCY, (d) => recomputeDivisionStandings(d.id));

  const seasonLabel = season.subtitle
    ? `Season ${season.number} — ${season.subtitle}`
    : `Season ${season.number}`;

  return { seasonLabel, divisionCount: divisions.length, pairingsMade, gamesMade, dcGames, shootoutsMade };
}
