// Roster exceptions service (B7): substitutions, drops, DQs — each recorded as a
// SeasonEvent (audit + the D2 timeline seed). Integrity rule: the only thing that
// MUTATES a roster is a substitution, and it does so on a forward week-block
// (cloning the prior block), so past blocks — and the stat attribution that joins
// TourSets through RosterEntry — stay intact. Drops and DQs are audit records; the
// TO adjusts the forward lineup via substitution.
import { prisma } from "../db";

// Standard 4-week bands + playoffs. Subs pick the block they take effect in.
export const WEEK_BLOCKS = ["W1-4", "W5-8", "W9-12", "PLAYOFFS"] as const;
const blockOrder = (b: string) => {
  const i = WEEK_BLOCKS.indexOf(b as (typeof WEEK_BLOCKS)[number]);
  return i === -1 ? 99 : i;
};

// Find a (teamSeason, weekBlock) roster, creating it from the latest prior block's
// entries when it doesn't exist yet (so a forward block starts as a clone).
async function ensureRoster(teamSeasonId: string, weekBlock: string) {
  const existing = await prisma.roster.findUnique({
    where: { teamSeasonId_weekBlock: { teamSeasonId, weekBlock } },
    include: { entries: true },
  });
  if (existing) return existing;

  const all = await prisma.roster.findMany({ where: { teamSeasonId }, include: { entries: true } });
  const source =
    [...all].filter((r) => blockOrder(r.weekBlock) <= blockOrder(weekBlock)).sort((a, b) => blockOrder(b.weekBlock) - blockOrder(a.weekBlock))[0] ??
    [...all].sort((a, b) => blockOrder(a.weekBlock) - blockOrder(b.weekBlock))[0];

  const roster = await prisma.roster.create({ data: { teamSeasonId, weekBlock } });
  if (source) {
    for (const e of source.entries) {
      await prisma.rosterEntry.create({ data: { rosterId: roster.id, playerId: e.playerId, seed: e.seed, isCaptain: e.isCaptain } });
    }
  }
  return prisma.roster.findUnique({ where: { id: roster.id }, include: { entries: true } });
}

export async function substitute(
  seasonName: string,
  teamSeasonId: string,
  outPlayerId: string,
  inPlayerId: string,
  weekBlock: string,
  reason: string,
  by?: string,
) {
  const season = await prisma.tourSeason.findUnique({ where: { name: seasonName }, select: { id: true } });
  if (!season) throw new Error(`No season "${seasonName}"`);
  if (!reason.trim()) throw new Error("A reason is required.");
  if (!outPlayerId || !inPlayerId) throw new Error("Pick the player going out and the player coming in.");
  if (outPlayerId === inPlayerId) throw new Error("Pick two different players.");
  if (!WEEK_BLOCKS.includes(weekBlock as (typeof WEEK_BLOCKS)[number])) throw new Error("Unknown week block.");

  const roster = await ensureRoster(teamSeasonId, weekBlock);
  if (!roster) throw new Error("Could not prepare the roster.");
  const outEntry = roster.entries.find((e) => e.playerId === outPlayerId);
  if (!outEntry) throw new Error("The outgoing player isn't on that week's roster.");
  if (roster.entries.some((e) => e.playerId === inPlayerId)) throw new Error("The incoming player is already on that roster.");

  // Keep the outgoing player's seed + captain flag; just swap who fills the slot.
  await prisma.rosterEntry.update({ where: { id: outEntry.id }, data: { playerId: inPlayerId } });
  await prisma.seasonEvent.create({
    data: { seasonId: season.id, kind: "SUBSTITUTION", teamSeasonId, playerId: outPlayerId, relatedPlayerId: inPlayerId, weekBlock, reason: reason.trim(), createdBy: by },
  });
  return { ok: true };
}

export async function recordDrop(seasonName: string, teamSeasonId: string, playerId: string, reason: string, by?: string) {
  const season = await prisma.tourSeason.findUnique({ where: { name: seasonName }, select: { id: true } });
  if (!season) throw new Error(`No season "${seasonName}"`);
  if (!reason.trim()) throw new Error("A reason is required.");
  if (!playerId) throw new Error("Pick the player who dropped.");
  await prisma.seasonEvent.create({ data: { seasonId: season.id, kind: "DROP", teamSeasonId, playerId, reason: reason.trim(), createdBy: by } });
  return { ok: true };
}

export async function recordDQ(seasonName: string, teamSeasonId: string, playerId: string, reason: string, by?: string) {
  const season = await prisma.tourSeason.findUnique({ where: { name: seasonName }, select: { id: true } });
  if (!season) throw new Error(`No season "${seasonName}"`);
  if (!reason.trim()) throw new Error("A reason is required.");
  if (!teamSeasonId && !playerId) throw new Error("Pick a team or a player to disqualify.");
  await prisma.seasonEvent.create({
    data: { seasonId: season.id, kind: "DQ", teamSeasonId: teamSeasonId || null, playerId: playerId || null, reason: reason.trim(), createdBy: by },
  });
  return { ok: true };
}

export async function removeEvent(eventId: string) {
  await prisma.seasonEvent.delete({ where: { id: eventId } });
}

export async function getRosterOps(seasonName: string) {
  const season = await prisma.tourSeason.findUnique({ where: { name: seasonName }, select: { id: true, name: true } });
  if (!season) return null;

  const [teamSeasons, approved, events] = await Promise.all([
    prisma.teamSeason.findMany({ where: { seasonId: season.id }, include: { team: true, rosters: { include: { entries: true } } } }),
    prisma.signup.findMany({ where: { seasonId: season.id, status: "APPROVED" }, select: { discordId: true } }),
    prisma.seasonEvent.findMany({ where: { seasonId: season.id }, orderBy: { createdAt: "desc" } }),
  ]);

  // Active lineup = each team's latest week-block.
  const latestRosterOf = (rosters: (typeof teamSeasons)[number]["rosters"]) =>
    [...rosters].sort((a, b) => blockOrder(b.weekBlock) - blockOrder(a.weekBlock))[0];

  const rosteredIds = new Set(teamSeasons.flatMap((t) => t.rosters.flatMap((r) => r.entries.map((e) => e.playerId))));
  const approvedPlayers = await prisma.player.findMany({ where: { discordId: { in: approved.map((a) => a.discordId) } }, select: { id: true, displayName: true } });
  const freeAgents = approvedPlayers.filter((p) => !rosteredIds.has(p.id)).sort((a, b) => a.displayName.localeCompare(b.displayName));

  // Names for everything we render.
  const allPlayerIds = [
    ...rosteredIds,
    ...approvedPlayers.map((p) => p.id),
    ...events.flatMap((e) => [e.playerId, e.relatedPlayerId]).filter((x): x is string => !!x),
    ...teamSeasons.map((t) => t.captainPlayerId),
  ];
  const players = await prisma.player.findMany({ where: { id: { in: [...new Set(allPlayerIds)] } }, select: { id: true, displayName: true } });
  const nameOf = new Map(players.map((p) => [p.id, p.displayName]));
  const teamNameOf = new Map(teamSeasons.map((t) => [t.id, t.team.name]));

  const teams = teamSeasons.map((t) => {
    const latest = latestRosterOf(t.rosters);
    return {
      teamSeasonId: t.id,
      name: t.team.name,
      activeBlock: latest?.weekBlock ?? null,
      roster: (latest?.entries ?? [])
        .slice()
        .sort((a, b) => a.seed - b.seed)
        .map((e) => ({ playerId: e.playerId, name: nameOf.get(e.playerId) ?? e.playerId, seed: e.seed, isCaptain: e.isCaptain })),
    };
  });

  const KIND_LABEL: Record<string, string> = { SUBSTITUTION: "Sub", DROP: "Drop", DQ: "DQ" };
  return {
    seasonName: season.name,
    weekBlocks: [...WEEK_BLOCKS],
    teams,
    freeAgents: freeAgents.map((p) => ({ id: p.id, name: p.displayName })),
    events: events.map((e) => ({
      id: e.id,
      kind: e.kind,
      kindLabel: KIND_LABEL[e.kind] ?? e.kind,
      team: e.teamSeasonId ? teamNameOf.get(e.teamSeasonId) ?? null : null,
      player: e.playerId ? nameOf.get(e.playerId) ?? e.playerId : null,
      relatedPlayer: e.relatedPlayerId ? nameOf.get(e.relatedPlayerId) ?? e.relatedPlayerId : null,
      weekBlock: e.weekBlock,
      reason: e.reason,
      createdBy: e.createdBy,
    })),
  };
}
