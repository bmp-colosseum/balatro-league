// Server-side end-to-end demo seeder — the endpoint version of the bot's
// scripts/seed-e2e.ts, so the whole flow is a single ADMIN_TOKEN curl with
// no host shell / local env. Runs entirely in the web service: fake signups
// → REAL build (buildSeasonFromRound) → persona-driven matches written
// straight to Match/Game/GameDeck → end-season (promo/relegation) → loop.
//
// NOTE: this duplicates the match-fabrication logic in src/seed-matches-core.ts
// (personas, pool gen). That duplication is intentional for now — it gets
// absorbed when the shared core/db workspace lands.

import { prisma } from "@/lib/prisma";
import { recordAudit, type AuditActor } from "@/lib/audit";
import { buildSeasonFromRound } from "@/lib/build-season";
import { endSeasonCore } from "@/lib/end-season";
import { recomputeDivisionStandings } from "@/lib/standings-cache";
import { writeMatchGames, type GameStateLike } from "@/lib/match-write";
import { performSeasonActivation } from "@/app/admin/seasons/actions";
import { enqueueAnnounceResult } from "@/lib/queue";
import defaults from "@/lib/match-defaults.json";

const DEMO_SUBTITLE = "E2E Demo";
const POOL_SIZE = 9;
const WRITE_CONCURRENCY = 12;

interface DeckEntry {
  deck: string;
  stake: string;
}

export interface SeedE2EOptions {
  players?: number;
  divisions?: number; // 0 / undefined → derive from divisionSize
  divisionSize?: number;
  seasons?: number;
  churn?: number;
  activateEach?: boolean;
  // Each season activates with REAL Discord (bootstrap channels/roles) and
  // tears them down on end — the full create→teardown cycle, every season.
  // Heavy Discord churn (drained by the bot worker, rate-limited).
  realDiscordEach?: boolean;
  // Fire a result-announce job per match (floods the announce queue; the
  // bot drains at ~1/sec — this is where you SEE the Discord bottleneck).
  announce?: boolean;
  playFraction?: number;
  reset?: boolean;
}

export interface SeedE2EResult {
  seasons: number;
  players: number;
  divisions: number;
  matches: number;
  games: number;
  shootouts: number;
  lastSeasonId: string | null;
  lastSeasonLabel: string;
}

// ---------- deterministic RNG + pool ----------
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
function shuffle<T>(arr: T[], rand: () => number): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}
function generatePool(decks: string[], stakes: string[], size: number, rand: () => number): DeckEntry[] {
  const combos: DeckEntry[] = [];
  for (const deck of decks) for (const stake of stakes) combos.push({ deck, stake });
  return shuffle(combos, rand).slice(0, size);
}

// ---------- personas ----------
const STAKE_RANK: Record<string, number> = { White: 0, Green: 1, Black: 2, Purple: 3, Gold: 4 };
function stakeRank(s: string): number {
  return STAKE_RANK[s] ?? 2;
}
interface Persona {
  pickStake: "high" | "low" | "any";
  banStake: "high" | "low" | "any";
  favoriteDeck: string | null;
  wildcard: boolean;
  banishDeck: string | null;
  banishStake: string | null;
  ghostbuster: boolean;
  randomLover: boolean;
}
const FAVE_DECKS = ["Plasma", "Erratic", "Nebula", "Zodiac", "Painted", "Anaglyph", "Magic", "Checkered"];
const BANISH_DECKS = ["Erratic", "Plasma", "Abandoned", "Ghost", "Black", "Red"];
const BANISH_STAKES = ["Gold", "Purple", "Black"];
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
      return { ...base, pickStake: "high", banStake: "low" };
    case 1:
      return { ...base, pickStake: "low", banStake: "high" };
    case 2:
      return { ...base, favoriteDeck: FAVE_DECKS[u % FAVE_DECKS.length]! };
    case 3:
      return { ...base, wildcard: true };
    case 4:
      return { ...base, ghostbuster: true };
    case 5:
      return { ...base, banishDeck: BANISH_DECKS[u % BANISH_DECKS.length]! };
    case 6:
      return { ...base, banishStake: BANISH_STAKES[u % BANISH_STAKES.length]! };
    default:
      return { ...base, randomLover: true };
  }
}
function pickScore(p: Persona, c: DeckEntry, rng: () => number): number {
  let s = rng() * 0.5;
  if (p.wildcard) s += rng() * 50;
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
  if (p.banStake === "low") s += (4 - stakeRank(c.stake)) * 8;
  if (p.banStake === "high") s += stakeRank(c.stake) * 8;
  return s;
}
function rankByScore(cands: number[], scorer: (i: number) => number): number[] {
  return cands
    .map((i) => ({ i, s: scorer(i) }))
    .sort((a, b) => b.s - a.s)
    .map((x) => x.i);
}
function generateGame(
  rng: () => number,
  pool: DeckEntry[],
  firstId: string,
  firstP: Persona,
  otherP: Persona,
  winnerId: string,
  dcByPlayerId?: string,
): GameStateLike {
  const all = Array.from({ length: pool.length }, (_, i) => i);
  const pickIdx = rankByScore(all, (i) => pickScore(otherP, pool[i]!, rng))[0]!;
  let bannable = all.filter((i) => i !== pickIdx);
  const b0 = rankByScore(bannable, (i) => banScore(firstP, pool[i]!, rng))[0]!;
  bannable = bannable.filter((i) => i !== b0);
  const otherBans = rankByScore(bannable, (i) => banScore(otherP, pool[i]!, rng)).slice(0, 3);
  bannable = bannable.filter((i) => !otherBans.includes(i));
  const firstRest = rankByScore(bannable, (i) => banScore(firstP, pool[i]!, rng)).slice(0, 3);
  const bans = [b0, ...otherBans, ...firstRest];
  const game: GameStateLike = { firstId, bans, pickedDeckIdx: pickIdx, winnerId, pool };
  if (dcByPlayerId) game.dcByPlayerId = dcByPlayerId;
  if (rng() < (firstP.randomLover ? 0.7 : 0.06)) game.firstBannedRandomly = true;
  if (rng() < (otherP.randomLover ? 0.7 : 0.06)) game.otherBannedRandomly = true;
  if (rng() < (otherP.randomLover ? 0.6 : 0.06)) game.pickedRandomly = true;
  return game;
}

async function runWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<unknown>): Promise<void> {
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < items.length) await fn(items[cursor++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
}

interface PreparedMatch {
  divisionId: string;
  canonA: string;
  canonB: string;
  games: GameStateLike[];
  winsA: number;
  winsB: number;
  hadDc: boolean;
  playedAt: Date;
  shootoutWinnerId: string | null;
  shootoutGame: GameStateLike | null;
}

// Fabricate + write matches for a built season. Returns counts.
async function seedMatchesForSeason(
  seasonId: string,
  playFraction: number,
  announce: boolean,
): Promise<{ matches: number; games: number; shootouts: number }> {
  const season = await prisma.season.findUnique({ where: { id: seasonId } });
  if (!season) return { matches: 0, games: 0, shootouts: 0 };
  const divisions = await prisma.division.findMany({
    where: { seasonId },
    include: { members: { where: { status: "ACTIVE" }, select: { playerId: true } } },
  });
  const decks = defaults.decks;
  const stakes = defaults.stakes;
  const baseTime = (season.startedAt ?? new Date()).getTime();
  const prepared: PreparedMatch[] = [];

  for (const division of divisions) {
    const memberIds = division.members.map((m) => m.playerId);
    const rng = makeRng(`matches:${season.id}:${division.id}`);
    for (let i = 0; i < memberIds.length; i++) {
      for (let j = i + 1; j < memberIds.length; j++) {
        if (rng() > playFraction) continue;
        const pA = memberIds[i]!;
        const pB = memberIds[j]!;
        const [canonA, canonB] = pA < pB ? [pA, pB] : [pB, pA];
        const personaA = personaFor(pA);
        const personaB = personaFor(pB);
        const games: GameStateLike[] = [];
        let winsA = 0;
        let winsB = 0;
        for (let g = 0; g < 2; g++) {
          const firstId = rng() < 0.5 ? pA : pB;
          const otherId = firstId === pA ? pB : pA;
          const firstP = firstId === pA ? personaA : personaB;
          const otherP = otherId === pA ? personaA : personaB;
          const winnerId = rng() < 0.5 ? pA : pB;
          const isDc = rng() < 0.15;
          const dcBy = isDc ? (winnerId === pA ? pB : pA) : undefined;
          games.push(generateGame(rng, generatePool(decks, stakes, POOL_SIZE, rng), firstId, firstP, otherP, winnerId, dcBy));
          if (winnerId === canonA) winsA++;
          else winsB++;
        }
        const hadDc = games.some((g) => g.dcByPlayerId);
        const playedAt = new Date(baseTime + Math.floor(rng() * 20) * 86400000);
        let shootoutWinnerId: string | null = null;
        let shootoutGame: GameStateLike | null = null;
        if (winsA === 1 && winsB === 1 && rng() < 0.5) {
          shootoutWinnerId = rng() < 0.5 ? canonA : canonB;
          const sFirst = rng() < 0.5 ? canonA : canonB;
          const sOther = sFirst === canonA ? canonB : canonA;
          shootoutGame = generateGame(
            rng,
            generatePool(decks, stakes, POOL_SIZE, rng),
            sFirst,
            personaFor(sFirst),
            personaFor(sOther),
            shootoutWinnerId,
          );
        }
        prepared.push({ divisionId: division.id, canonA, canonB, games, winsA, winsB, hadDc, playedAt, shootoutWinnerId, shootoutGame });
      }
    }
  }

  let shootouts = 0;
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
    if (announce) await enqueueAnnounceResult(match.id).catch(() => {});
    if (p.shootoutWinnerId) {
      const sWinA = p.shootoutWinnerId === p.canonA ? 1 : 0;
      const sWinB = p.shootoutWinnerId === p.canonB ? 1 : 0;
      const shootout = await prisma.match.create({
        data: {
          divisionId: p.divisionId,
          playerAId: p.canonA,
          playerBId: p.canonB,
          format: "SHOOTOUT_BO1",
          gamesWonA: sWinA,
          gamesWonB: sWinB,
          winnerId: p.shootoutWinnerId,
          status: "CONFIRMED",
          reportedAt: p.playedAt,
          confirmedAt: p.playedAt,
          recordedBy: "seed-e2e",
        },
      });
      if (p.shootoutGame) await writeMatchGames(shootout.id, p.canonA, p.canonB, [p.shootoutGame]);
      shootouts++;
    }
  });
  await runWithConcurrency(divisions, WRITE_CONCURRENCY, (d) => recomputeDivisionStandings(d.id));
  return { matches: prepared.length, games: prepared.length * 2, shootouts };
}

async function resetDemos(): Promise<void> {
  const seasons = await prisma.season.findMany({
    where: { subtitle: { startsWith: DEMO_SUBTITLE } },
    select: { id: true, divisions: { select: { id: true } } },
  });
  const seasonIds = seasons.map((s) => s.id);
  const divIds = seasons.flatMap((s) => s.divisions.map((d) => d.id));
  if (divIds.length) {
    await prisma.match.deleteMany({ where: { divisionId: { in: divIds } } });
    await prisma.matchSession.deleteMany({ where: { divisionId: { in: divIds } } });
    await prisma.divisionStandings.deleteMany({ where: { divisionId: { in: divIds } } });
  }
  if (seasonIds.length) {
    await prisma.divisionMember.deleteMany({ where: { seasonId: { in: seasonIds } } });
    await prisma.division.deleteMany({ where: { seasonId: { in: seasonIds } } });
    await prisma.tier.deleteMany({ where: { seasonId: { in: seasonIds } } });
    await prisma.season.deleteMany({ where: { id: { in: seasonIds } } });
  }
  await prisma.signup.deleteMany({ where: { discordId: { startsWith: "e2e-" } } });
  await prisma.signupRound.deleteMany({ where: { name: { startsWith: DEMO_SUBTITLE } } });
  await prisma.player.deleteMany({ where: { discordId: { startsWith: "e2e-" } } });
}

interface Roster {
  discordId: string;
  displayName: string;
}

async function nextRoster(prevSeasonId: string, churn: number, rng: () => number, allocId: () => number): Promise<Roster[]> {
  const members = await prisma.divisionMember.findMany({
    where: { seasonId: prevSeasonId, status: "ACTIVE" },
    include: { player: { select: { discordId: true, displayName: true, rating: true } } },
  });
  const returners = members.map((m) => m.player).sort((a, b) => (a.rating ?? 1e9) - (b.rating ?? 1e9));
  const keepMin = Math.max(3, returners.length - Math.floor(returners.length * churn));
  const shuffled = returners.slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }
  const kept = shuffled.slice(0, keepMin);
  const dropCount = returners.length - kept.length;
  const maxRating = kept.reduce((mx, p) => Math.max(mx, p.rating ?? 0), 0);
  const newcomers: Roster[] = [];
  for (let k = 0; k < dropCount; k++) {
    const idx = allocId();
    const discordId = `e2e-${idx}`;
    const displayName = `Demo Player ${idx + 1}`;
    await prisma.player.upsert({
      where: { discordId },
      create: { discordId, displayName, rating: maxRating + 1 + k },
      update: { displayName, rating: maxRating + 1 + k },
    });
    newcomers.push({ discordId, displayName });
  }
  return [...kept.map((p) => ({ discordId: p.discordId, displayName: p.displayName })), ...newcomers];
}

// Wait until the bot has finished bootstrapping a season's Discord channels
// (every member-bearing division has a discordChannelId). Used by
// realDiscordEach so we don't tear a season down before its async bootstrap
// finished (which would orphan channels). Best-effort: returns on timeout so
// a stuck bootstrap doesn't hang the whole seed.
async function waitForSeasonBootstrap(seasonId: string, timeoutMs = 4 * 60 * 1000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const divs = await prisma.division.findMany({
      where: { seasonId, members: { some: { status: "ACTIVE" } } },
      select: { discordChannelId: true },
    });
    if (divs.length > 0 && divs.every((d) => d.discordChannelId)) return;
    await new Promise((r) => setTimeout(r, 3000));
  }
}

export async function runSeedE2E(opts: SeedE2EOptions, actor: AuditActor): Promise<SeedE2EResult> {
  const players = Math.max(2, opts.players ?? 12);
  const divisionSize = Math.max(2, opts.divisionSize ?? 6);
  const divisions = opts.divisions && opts.divisions > 0 ? opts.divisions : Math.max(1, Math.round(players / divisionSize));
  const seasons = Math.max(1, opts.seasons ?? 1);
  const churn = Math.min(0.9, Math.max(0, opts.churn ?? 0.1));
  const playFraction = opts.playFraction != null ? Math.min(1, Math.max(0, opts.playFraction)) : 0.8;

  if (opts.reset) await resetDemos();

  const rng = makeRng("e2e-loop");
  let idCounter = 0;
  const allocId = () => idCounter++;

  let roster: Roster[] = [];
  for (let i = 0; i < players; i++) {
    const idx = allocId();
    const discordId = `e2e-${idx}`;
    const displayName = `Demo Player ${idx + 1}`;
    await prisma.player.upsert({
      where: { discordId },
      create: { discordId, displayName, rating: idx + 1 },
      update: { displayName, rating: idx + 1 },
    });
    roster.push({ discordId, displayName });
  }

  let prevSeasonId: string | null = null;
  let lastSeasonId: string | null = null;
  let lastSeasonLabel = "";
  let totalMatches = 0;
  let totalGames = 0;
  let totalShootouts = 0;

  for (let s = 1; s <= seasons; s++) {
    const isLast = s === seasons;
    if (prevSeasonId) roster = await nextRoster(prevSeasonId, churn, rng, allocId);

    const round = await prisma.signupRound.create({
      data: {
        name: `${DEMO_SUBTITLE} round (loop ${s})`,
        guildId: "e2e-guild",
        channelId: "e2e-channel",
        messageId: "pending",
        status: "CLOSED",
        closedAt: new Date(),
      },
    });
    await prisma.signup.createMany({
      data: roster.map((r) => ({ roundId: round.id, discordId: r.discordId, displayName: r.displayName, signedUpAt: new Date() })),
    });

    const built = await buildSeasonFromRound({
      roundId: round.id,
      subtitle: `${DEMO_SUBTITLE} #${s}`,
      config: JSON.stringify([{ name: "Rare", divisionCount: divisions }]),
      targetGroupSize: Math.max(2, Math.ceil(roster.length / divisions)),
      actor,
    });
    if (!built) throw new Error(`build failed for loop ${s}`);
    lastSeasonId = built.seasonId;
    lastSeasonLabel = `Season ${built.seasonNumber} — ${DEMO_SUBTITLE} #${s}`;

    const activate = isLast || !!opts.activateEach || !!opts.realDiscordEach;
    if (activate) {
      // realDiscordEach → real bootstrap every season; otherwise only the
      // final season touches Discord (intermediates skip it).
      const skipDiscord = opts.realDiscordEach ? false : !isLast;
      await performSeasonActivation(built.seasonId, actor, "manual", { skipDiscord });
      // Wait for the bot to finish creating this season's channels before we
      // move on (and later tear them down) — otherwise teardown races the
      // async bootstrap and orphans channels. Only when a guild is configured.
      if (opts.realDiscordEach && process.env.DISCORD_GUILD_ID) {
        await waitForSeasonBootstrap(built.seasonId);
      }
    }

    const m = await seedMatchesForSeason(built.seasonId, playFraction, !!opts.announce);
    totalMatches += m.matches;
    totalGames += m.games;
    totalShootouts += m.shootouts;

    if (!isLast) {
      await endSeasonCore(built.seasonId, actor);
    }
    prevSeasonId = built.seasonId;
  }

  recordAudit({
    actor,
    action: "seed.e2e",
    targetType: "Season",
    targetId: lastSeasonId ?? "none",
    summary: `Seeded ${seasons} demo season(s): ${totalMatches} matches, ${totalShootouts} shootouts`,
    metadata: { seasons, players, divisions, matches: totalMatches, shootouts: totalShootouts },
  });

  return {
    seasons,
    players,
    divisions,
    matches: totalMatches,
    games: totalGames,
    shootouts: totalShootouts,
    lastSeasonId,
    lastSeasonLabel,
  };
}
