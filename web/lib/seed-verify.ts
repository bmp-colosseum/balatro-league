// Local verify-env seed — builds a realistic dataset shaped like production
// (Season 9 per .claude/knowledge/ux-audit: 4 tiers, 13 divisions) against
// the embedded Postgres scripts/verify-env.mjs boots, so agents can screenshot
// and measure every page (standings, a division, the archive, /join) without
// production DB access.
//
// Deliberately separate from runSeedE2E (lib/seed-e2e.ts): that one is a
// churn-loop generator for the create-league E2E test and always builds a
// single flat "Rare" tier. This one reuses its persona/match-fabrication
// engine (seedMatchesForSeason) but drives a production-shaped tier ladder
// (owenLadder), a finished+archived season for the /seasons page, and a
// hand-crafted points-tie so the net-lives tiebreak footnote actually renders
// (season.tiebreak = "lives", same as the real Season 9) instead of leaving
// that to chance.

import { prisma } from "@/lib/prisma";
import { recordAudit, type AuditActor } from "@/lib/audit";
import { buildSeasonFromRound } from "@/lib/build-season";
import { owenLadder } from "@/lib/season-plan";
import { endSeasonCore } from "@/lib/end-season";
import { recomputeDivisionStandings } from "@/lib/standings-cache";
import { performSeasonActivation } from "@/lib/season-activation";
import { seedMatchesForSeason } from "@/lib/seed-e2e";
import { writeMatchGames, type GameStateLike } from "@/lib/match-write";
import defaults from "@/lib/match-defaults.json";

const VERIFY_PREFIX = "verify-";
const VERIFY_SUBTITLE = "Verify";

export interface SeedVerifyOptions {
  // Total players across the active (current) season. owenLadder derives a
  // 1/4/4/4 = 13-division ladder for any count in [78, 96) — the same shape
  // ux-audit observed in production Season 9. Default 80.
  players?: number;
  // Leave an OPEN SignupRound behind (the /join "signups open" state) when
  // true (default); when false, signups are left closed, as between seasons.
  openSignups?: boolean;
  // Wipe any prior verify-* data first. Default true — safe because this
  // only ever runs against the disposable embedded Postgres verify-env.mjs
  // boots, never a shared DB.
  reset?: boolean;
}

export interface SeedVerifyResult {
  activeSeasonId: string;
  finishedSeasonId: string;
  divisionCount: number;
  players: number;
  // The division where the crafted points-tie + net-lives scenario lives —
  // useful as a direct "shoot this division" target.
  tieDivisionId: string;
  openSignupRoundId: string | null;
}

async function resetVerifyData(): Promise<void> {
  const seasons = await prisma.season.findMany({
    where: { subtitle: { startsWith: VERIFY_SUBTITLE } },
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
  await prisma.signup.deleteMany({ where: { discordId: { startsWith: VERIFY_PREFIX } } });
  await prisma.signupRound.deleteMany({ where: { name: { startsWith: "Verify " } } });
  await prisma.player.deleteMany({ where: { discordId: { startsWith: VERIFY_PREFIX } } });
}

function canonPair(x: string, y: string): [string, string] {
  return x < y ? [x, y] : [y, x];
}

// A tiny fixed pool is enough for the crafted scenario's three games — no
// persona RNG needed, every pick/ban here is scripted.
function craftedPool(): Array<{ deck: string; stake: string }> {
  const decks: string[] = defaults.decks;
  const stakes: string[] = defaults.stakes;
  return [0, 1, 2, 3].map((i) => ({ deck: decks[i]!, stake: stakes[i % stakes.length]! }));
}

function craftedGame(firstId: string, winnerId: string, winnerLives: number): GameStateLike {
  return {
    firstId,
    pool: craftedPool(),
    pickedDeckIdx: 0,
    bans: [1, 2, 3],
    winnerId,
    winnerLives,
  };
}

// Hand-crafts a deterministic 3-player scenario inside one division of the
// just-built active season: A beats C 2-0, B beats C 2-0, A and B split 1-1 —
// so A and B land on equal points (4 each) via a drawn head-to-head, which is
// exactly the case Season.tiebreak="lives" exists for (LIVES_RULE: "if that
// match was 1-1, the lives from that match decide"). A's winning game carries
// more winnerLives than B's, so A ranks above B and the standings page has a
// real tie footnote + a net-lives number to show, not just luck of the RNG.
async function forceTieScenario(seasonId: string): Promise<string> {
  const division = await prisma.division.findFirst({
    where: { seasonId },
    include: { members: { where: { status: "ACTIVE" }, select: { playerId: true } } },
    orderBy: [{ tier: { position: "asc" } }, { groupNumber: "asc" }],
  });
  if (!division || division.members.length < 3) {
    throw new Error("seed-verify: no division with 3+ active members for the tie scenario");
  }
  const [a, b, c] = division.members.map((m) => m.playerId) as [string, string, string, ...string[]];
  const divisionId = division.id;

  // A and B must land EXACTLY tied on points for the footnote to reliably
  // render, regardless of what seedMatchesForSeason's RNG already gave them
  // against the division's other members -- so wipe every match either of
  // them is in (not just the 3-way subset) before writing the crafted ones.
  // Their row will show fewer games played than the rest of the table; that's
  // consistent with this dataset's normal "mix of played/unplayed" look.
  await prisma.match.deleteMany({
    where: { divisionId, OR: [{ playerAId: { in: [a, b] } }, { playerBId: { in: [a, b] } }] },
  });

  const now = new Date();
  async function write2_0(winnerId: string, loserId: string, livesHi: number, livesLo: number): Promise<void> {
    const [canonA, canonB] = canonPair(winnerId, loserId);
    const match = await prisma.match.create({
      data: {
        divisionId,
        playerAId: canonA,
        playerBId: canonB,
        format: "LEAGUE_BO2",
        gamesWonA: canonA === winnerId ? 2 : 0,
        gamesWonB: canonB === winnerId ? 2 : 0,
        winnerId,
        status: "CONFIRMED",
        reporterId: winnerId,
        reportedAt: now,
        confirmedAt: now,
      },
    });
    await writeMatchGames(match.id, canonA, canonB, [
      craftedGame(winnerId, winnerId, livesHi),
      craftedGame(loserId, winnerId, livesLo),
    ]);
  }
  async function writeDraw(xId: string, xLives: number, yId: string, yLives: number): Promise<void> {
    const [canonA, canonB] = canonPair(xId, yId);
    const match = await prisma.match.create({
      data: {
        divisionId,
        playerAId: canonA,
        playerBId: canonB,
        format: "LEAGUE_BO2",
        gamesWonA: 1,
        gamesWonB: 1,
        winnerId: null,
        status: "CONFIRMED",
        reporterId: xId,
        reportedAt: now,
        confirmedAt: now,
      },
    });
    await writeMatchGames(match.id, canonA, canonB, [craftedGame(xId, xId, xLives), craftedGame(yId, yId, yLives)]);
  }

  await write2_0(a, c, 6, 4);
  await write2_0(b, c, 6, 4);
  await writeDraw(a, 5, b, 3); // A's winning game (5 lives) beats B's (3) on the lives-from-that-match rule

  await recomputeDivisionStandings(division.id);
  return division.id;
}

export async function runSeedVerify(opts: SeedVerifyOptions, actor: AuditActor): Promise<SeedVerifyResult> {
  if (opts.reset !== false) await resetVerifyData();

  const playerCount = Math.max(20, opts.players ?? 80);
  const ladder = owenLadder(playerCount); // 1/4/4/4 = 13 divisions for 78-95 signups
  const divisionCount = ladder.reduce((sum, t) => sum + t.divisionCount, 0);

  const roster = Array.from({ length: playerCount }, (_, i) => ({
    discordId: `${VERIFY_PREFIX}${i}`,
    displayName: `Verify Player ${i + 1}`,
    rating: i + 1,
  }));
  await prisma.player.createMany({ data: roster, skipDuplicates: true });

  // Builds a season but does NOT activate it -- activation (performSeasonActivation)
  // calls lockDivisionSchedules, which pre-creates PENDING matches for a
  // 4-regular opponent graph. seedMatchesForSeason (lib/seed-e2e.ts) blind-
  // prisma.match.create()s a result for every played pair instead of
  // find-or-updating, so if the schedule were already locked it would collide
  // on any pair the graph happened to also pick, with a unique-constraint
  // error (reproduced while building this script). lockDivisionSchedules
  // itself is documented idempotent ("existing matches ... never touched"),
  // so the safe order is: build -> seed results -> THEN activate/lock. The
  // lock then only fills in PENDING fixtures for the pairs that are still
  // unplayed -- which is more realistic, not less.
  async function build(label: string, subtitle: string): Promise<string> {
    const round = await prisma.signupRound.create({
      data: {
        name: `Verify ${label} Signups`,
        guildId: "verify-guild",
        channelId: "verify-channel",
        messageId: "verify",
        status: "CLOSED",
        closedAt: new Date(),
      },
    });
    await prisma.signup.createMany({
      data: roster.map((r) => ({ roundId: round.id, discordId: r.discordId, displayName: r.displayName, signedUpAt: new Date() })),
    });
    const built = await buildSeasonFromRound({
      roundId: round.id,
      subtitle,
      config: JSON.stringify(ladder),
      targetGroupSize: Math.max(2, Math.ceil(playerCount / divisionCount)),
      actor,
    });
    if (!built) throw new Error(`seed-verify: build failed for ${label}`);
    return built.seasonId;
  }

  // Finished season — fully played, THEN activated/locked (see build()'s
  // comment on ordering), then ended, so /seasons has a FINISHED card with a
  // champion and /hall-of-fame has an entry.
  const finishedSeasonId = await build("Past", `${VERIFY_SUBTITLE} Past`);
  await seedMatchesForSeason(finishedSeasonId, 1, false);
  await performSeasonActivation(finishedSeasonId, actor, "manual", { skipDiscord: true });
  await endSeasonCore(finishedSeasonId, actor);

  // Active season — the one agents actually poke at: mixed played/unplayed
  // (playFraction 0.65, so the schedule lock below fills in real PENDING
  // fixtures for whoever's left), net-lives tiebreak on, plus the crafted tie.
  const activeSeasonId = await build("Current", `${VERIFY_SUBTITLE} Current`);
  await prisma.season.update({ where: { id: activeSeasonId }, data: { tiebreak: "lives" } });
  await seedMatchesForSeason(activeSeasonId, 0.65, false);
  const tieDivisionId = await forceTieScenario(activeSeasonId);
  await performSeasonActivation(activeSeasonId, actor, "manual", { skipDiscord: true });

  // Open-signups toggle: when on, leave one OPEN SignupRound (the /join
  // "signups open" state) with its own small newcomer roster; when off,
  // leave none (the "between seasons" state).
  let openSignupRoundId: string | null = null;
  if (opts.openSignups !== false) {
    const newcomers = Array.from({ length: 8 }, (_, i) => ({
      discordId: `${VERIFY_PREFIX}new-${i}`,
      displayName: `Verify Newcomer ${i + 1}`,
      rating: playerCount + i + 1,
    }));
    await prisma.player.createMany({ data: newcomers, skipDuplicates: true });
    const openRound = await prisma.signupRound.create({
      data: {
        name: "Verify Next Season Signups",
        guildId: "verify-guild",
        channelId: "verify-channel",
        messageId: "verify-open",
        status: "OPEN",
      },
    });
    await prisma.signup.createMany({
      data: newcomers.map((r) => ({ roundId: openRound.id, discordId: r.discordId, displayName: r.displayName, signedUpAt: new Date() })),
    });
    openSignupRoundId = openRound.id;
  }

  recordAudit({
    actor,
    action: "seed.verify",
    targetType: "Season",
    targetId: activeSeasonId,
    summary: `Seeded verify-env dataset: ${divisionCount} divisions, ${playerCount} players`,
    metadata: { divisionCount, playerCount, finishedSeasonId, activeSeasonId },
  });

  return {
    activeSeasonId,
    finishedSeasonId,
    divisionCount,
    players: playerCount,
    tieDivisionId,
    openSignupRoundId,
  };
}
