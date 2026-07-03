// Simulation harness — dry-run whole seasons through the REAL service layer (league
// seed-script tradition: scripts are thin callers; all logic lives here, and this file
// only orchestrates other services). Everything is guarded to seasons whose name starts
// with "Sim" so it can never touch real data.
//
//   seedScratchSeason  — season + N fake approved signups (realistic numeric ids)
//   simulateDraft      — auto-pick every pick (optionally paced) via makePick
//   simulateWeek       — pair the current week's matchups + report random results
//   simulatePredictors — N fake pick'em predictions on open sets
//   teardownSim        — delete the season + its fake players
import { prisma } from "../db";
import { createSeason, deleteSeason } from "./seasons";
import { addSignup } from "./signups";
import { setupDraft, getDraft, makePick } from "./draft";
import { generateSeasonSchedule } from "./schedule";
import { getPairingConsole, makePair, setSendFirst } from "./pairing";
import { reportSet } from "./report";
import { makePick as makePickemPick } from "./pickem";

const SIM_PREFIX = "Sim";
// Fake-but-realistic Discord snowflakes, far above real ranges we use. (BigInt()
// constructor — the tour tsconfig target predates bigint literals.)
const SIM_DISCORD_BASE = BigInt("900000000000000000");
const SIM_FAN_BASE = SIM_DISCORD_BASE + BigInt(10000);

function assertSim(seasonName: string): void {
  if (!seasonName.startsWith(SIM_PREFIX)) {
    throw new Error(`Simulation only operates on seasons named "${SIM_PREFIX} ..." (got "${seasonName}").`);
  }
}

const FIRST = ["Blaze", "Chip", "Lucky", "Stone", "Glass", "Gold", "Wee", "Baron", "Mime", "Juggler", "Fibo", "Cavendish", "Hack", "Idol", "Scholar", "Duo", "Trio", "Astro", "Comet", "Seltzer"];
const LAST = ["Joker", "Blind", "Ante", "Flush", "Straight", "Tarot", "Planet", "Spectral", "Voucher", "Boss"];
const simName = (i: number) => `${FIRST[i % FIRST.length]}${LAST[Math.floor(i / FIRST.length) % LAST.length]}${i >= FIRST.length * LAST.length ? i : ""}`;

export async function seedScratchSeason(seasonName: string, playerCount = 24, opts?: { teamSize?: number; conferenceCount?: number }) {
  assertSim(seasonName);
  const teamSize = opts?.teamSize ?? 4;
  await createSeason({
    name: seasonName,
    format: "CONFERENCES",
    teamSize,
    conferenceCount: opts?.conferenceCount ?? 2,
    playoffTeams: 4,
    defaultBestOf: 3,
  });
  // Teams sized to the pool: captains x teamSize <= players (leftovers stay free agents).
  const captains = Math.max(2, Math.floor(playerCount / teamSize));
  for (let i = 0; i < playerCount; i++) {
    const discordId = (SIM_DISCORD_BASE + BigInt(i)).toString();
    const row = await addSignup(seasonName, {
      discordId,
      displayName: simName(i),
      timezone: "America/New_York",
      availability: "sim — always free",
      captainInterest: i < captains ? "Yes, I would love to!" : "Not interested",
      scheduleAgency: "Yes, I have commitments but I mostly control my freetime",
      englishOk: true,
      discordActivity: 8,
      bmpMmr: 200 + Math.floor(Math.random() * 500),
      bmpTier: "Gold",
    });
    await prisma.signup.update({ where: { id: row.id }, data: { status: "APPROVED" } });
  }
  return { seasonName, players: playerCount, captains };
}

// One pick (random pool player) via the real makePick — draft posts / role syncs /
// live refresh all fire exactly like a real pick. Returns done=true when the draft ends.
export async function simulateOnePick(seasonName: string): Promise<{ done: boolean; picked?: string; team?: string }> {
  assertSim(seasonName);
  const board = await getDraft(seasonName);
  if (!board || !board.current) return { done: true };
  const pool = board.pool;
  if (!pool.length) return { done: true };
  const choice = pool[Math.floor(Math.random() * pool.length)];
  const r = await makePick(seasonName, choice.id);
  return { done: r.done, picked: choice.displayName, team: board.current.team?.name };
}

// Set up (if needed) + run the whole draft, optionally pausing between picks so a human
// can WATCH boards/overlays/predictions update live.
export async function simulateDraft(seasonName: string, delayMs = 0): Promise<{ picks: number }> {
  assertSim(seasonName);
  const existing = await getDraft(seasonName);
  if (!existing) await setupDraft(seasonName);
  let picks = 0;
  for (;;) {
    const r = await simulateOnePick(seasonName);
    if (r.picked) {
      picks++;
      console.log(`[sim] ${r.team ?? "?"} select ${r.picked}`);
    }
    if (r.done) break;
    if (delayMs > 0) await new Promise((res) => setTimeout(res, delayMs));
  }
  return { picks };
}

// Pair every matchup in the earliest open week (random legal pairings via the real
// captain engine), then report random results — standings/announcements/pickem scoring
// all flow. Call repeatedly to advance week by week.
export async function simulateWeek(seasonName: string, opts?: { report?: boolean }): Promise<{ week: number | null; paired: number; reported: number }> {
  const doReport = opts?.report ?? true;
  assertSim(seasonName);
  const season = await prisma.tourSeason.findUnique({ where: { name: seasonName }, select: { id: true } });
  if (!season) throw new Error("No such season.");
  if (!(await prisma.week.findFirst({ where: { seasonId: season.id } }))) await generateSeasonSchedule(seasonName);

  const weeks = await prisma.week.findMany({ where: { seasonId: season.id }, include: { matchups: true }, orderBy: { number: "asc" } });
  const week = weeks.find((w) => w.matchups.some((mu) => mu.setsWonA == null));
  if (!week) return { week: null, paired: 0, reported: 0 };

  let paired = 0;
  let reported = 0;
  for (const mu of week.matchups) {
    await setSendFirst(mu.id, Math.random() < 0.5 ? "A" : "B");
    // Pair until the console says complete: random unpaired proposer from the on-turn
    // team, random legal (±window) responder — exactly like two lazy captains.
    for (let guard = 0; guard < 50; guard++) {
      const c = await getPairingConsole(mu.id);
      if (!c || c.complete || c.deadlocked || !c.proposerTeam) break;
      const mine = (c.proposerTeam === "A" ? c.teamA : c.teamB).players.filter((p) => !p.paired);
      const theirs = (c.proposerTeam === "A" ? c.teamB : c.teamA).players.filter((p) => !p.paired);
      let made = false;
      for (const prop of [...mine].sort(() => Math.random() - 0.5)) {
        const legal = theirs.filter((r) => Math.abs(r.seed - prop.seed) <= c.windowSize);
        if (!legal.length) continue;
        const resp = legal[Math.floor(Math.random() * legal.length)];
        await makePair(mu.id, prop.playerId, resp.playerId);
        paired++;
        made = true;
        break;
      }
      if (!made) break; // genuine dead end — a TO would override, the sim leaves it
    }
    // Report every set with a random BO3-ish score (skip with report:false to leave the
    // week OPEN — the state pick'em / predictions / nudges operate on).
    if (doReport) {
      const sets = await prisma.tourSet.findMany({ where: { matchupId: mu.id }, select: { id: true, status: true } });
      for (const s of sets) {
        if (s.status !== "PROPOSED" && s.status !== "SCHEDULED") continue;
        const aWins = Math.random() < 0.5;
        await reportSet(s.id, aWins ? 2 : Math.floor(Math.random() * 2), aWins ? Math.floor(Math.random() * 2) : 2);
        reported++;
      }
    }
  }
  return { week: week.number, paired, reported };
}

// N fake predictors making random pick'em picks on open sets — fills leaderboards +
// consensus views so overlays/pages have something to show.
export async function simulatePredictors(seasonName: string, predictors = 10): Promise<{ picks: number }> {
  assertSim(seasonName);
  const season = await prisma.tourSeason.findUnique({ where: { name: seasonName }, select: { id: true } });
  if (!season) throw new Error("No such season.");
  const open = await prisma.tourSet.findMany({ where: { seasonId: season.id, status: { in: ["PROPOSED", "SCHEDULED"] } }, select: { id: true, playerAId: true, playerBId: true } });
  let picks = 0;
  for (let p = 0; p < predictors; p++) {
    const discordId = (SIM_FAN_BASE + BigInt(p)).toString();
    for (const s of open) {
      if (Math.random() < 0.25) continue; // not everyone picks every set
      await makePickemPick(discordId, `SimFan${p}`, s.id, Math.random() < 0.5 ? s.playerAId : s.playerBId);
      picks++;
    }
  }
  return { picks };
}

// Remove the sim season AND its fake players/predictions (players created by the draft
// materialization from sim signups; identified by the reserved id range).
export async function teardownSim(seasonName: string): Promise<{ playersDeleted: number }> {
  assertSim(seasonName);
  await deleteSeason(seasonName);
  const simPlayers = await prisma.player.findMany({ where: { discordId: { gte: SIM_DISCORD_BASE.toString() } }, select: { id: true, discordId: true } });
  const simIds = simPlayers.filter((p) => /^\d+$/.test(p.discordId) && BigInt(p.discordId) >= SIM_DISCORD_BASE).map((p) => p.id);
  const simDiscordIds = simPlayers.filter((p) => simIds.includes(p.id)).map((p) => p.discordId);
  if (simDiscordIds.length) await prisma.prediction.deleteMany({ where: { predictorDiscordId: { in: simDiscordIds } } });
  await prisma.prediction.deleteMany({ where: { predictorDiscordId: { gte: SIM_FAN_BASE.toString() } } });
  if (simIds.length) {
    await prisma.rosterMove.deleteMany({ where: { playerId: { in: simIds } } });
    await prisma.player.deleteMany({ where: { id: { in: simIds } } });
  }
  return { playersDeleted: simIds.length };
}
