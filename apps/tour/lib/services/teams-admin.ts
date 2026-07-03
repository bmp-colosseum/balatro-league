// Admin team management: list every team-season with its footprint, and force-delete
// one (with all its references) — for cleaning up stale/phantom/mis-parsed teams that the
// import's upsert-by-name never removes. Centralized service; the admin page/action only
// call these. Destructive: the action is admin-gated + confirmed.
import { prisma } from "../db";

export interface AdminTeamRow {
  teamSeasonId: string;
  teamId: string;
  team: string;
  season: string;
  players: number;
  sets: number;
  series: number;
}

// Every team-season with how much real data hangs off it, so an admin can spot phantoms
// (0 players, 0 sets) vs real teams.
export async function listTeamsAdmin(): Promise<AdminTeamRow[]> {
  const tss = await prisma.teamSeason.findMany({ include: { team: true, season: { select: { name: true } } } });
  const rows: AdminTeamRow[] = [];
  for (const ts of tss) {
    const [players, sets, series] = await Promise.all([
      prisma.rosterEntry.count({ where: { roster: { teamSeasonId: ts.id } } }),
      prisma.tourSet.count({ where: { OR: [{ teamSeasonAId: ts.id }, { teamSeasonBId: ts.id }] } }),
      prisma.playoffSeries.count({ where: { OR: [{ teamSeasonAId: ts.id }, { teamSeasonBId: ts.id }] } }),
    ]);
    rows.push({ teamSeasonId: ts.id, teamId: ts.teamId, team: ts.team.name, season: ts.season.name, players, sets, series });
  }
  return rows.sort((a, b) => a.season.localeCompare(b.season) || a.team.localeCompare(b.team));
}

// ── Manual team building (the SIGNUPS_CLOSED committee window) ──────────────

// The captain pool for the create-team picker: approved signups, captain-interested
// first, with a flag for who already captains a team this season.
export async function captainPool(seasonName: string) {
  const season = await prisma.tourSeason.findUnique({ where: { name: seasonName }, select: { id: true } });
  if (!season) throw new Error(`No season "${seasonName}"`);
  const [approved, teamSeasons] = await Promise.all([
    prisma.signup.findMany({ where: { seasonId: season.id, status: "APPROVED" }, orderBy: [{ createdAt: "asc" }] }),
    prisma.teamSeason.findMany({ where: { seasonId: season.id }, select: { captainPlayerId: true } }),
  ]);
  const players = await prisma.player.findMany({ where: { discordId: { in: approved.map((a) => a.discordId) } }, select: { id: true, discordId: true } });
  const playerByDiscord = new Map(players.map((p) => [p.discordId, p.id]));
  const captainIds = new Set(teamSeasons.map((t) => t.captainPlayerId));
  const rank = (ci: string | null) => (ci === "Yes, I would love to!" ? 0 : ci === "I will if it is needed" ? 1 : 2);
  return approved
    .map((s) => ({
      discordId: s.discordId,
      name: s.displayName ?? s.discordId,
      captainInterest: s.captainInterest,
      alreadyCaptain: captainIds.has(playerByDiscord.get(s.discordId) ?? ""),
    }))
    .sort((a, b) => rank(a.captainInterest) - rank(b.captainInterest) || a.name.localeCompare(b.name));
}

// Create a team for the season: captain from the approved pool (Player find-or-created,
// same as setupDraft), default name "Team {captain}", optional conference. Seed = next.
export async function createTeamForSeason(seasonName: string, input: { captainDiscordId: string; name?: string; conferenceId?: string }) {
  const season = await prisma.tourSeason.findUnique({ where: { name: seasonName }, select: { id: true, format: true } });
  if (!season) throw new Error(`No season "${seasonName}"`);
  if (!input.captainDiscordId) throw new Error("Pick a captain.");
  const signup = await prisma.signup.findUnique({ where: { seasonId_discordId: { seasonId: season.id, discordId: input.captainDiscordId } } });
  if (!signup || signup.status !== "APPROVED") throw new Error("That captain isn't an approved signup this season.");

  const captain = await prisma.player.upsert({
    where: { discordId: input.captainDiscordId },
    create: { discordId: input.captainDiscordId, displayName: signup.displayName ?? input.captainDiscordId },
    update: {},
    select: { id: true, displayName: true },
  });
  const existing = await prisma.teamSeason.findFirst({ where: { seasonId: season.id, captainPlayerId: captain.id }, include: { team: true } });
  if (existing) throw new Error(`${captain.displayName} already captains ${existing.team.name} this season.`);

  // Conference is OPTIONAL at creation — teams/captains often form DURING signups, before
  // the committee can know the format or conference count. Use the given one; else the
  // season's only real conference; else park in "Unassigned" (moved later via
  // setTeamConference once the structure is decided).
  let conferenceId = input.conferenceId;
  if (!conferenceId) {
    const confs = await prisma.conference.findMany({ where: { seasonId: season.id, NOT: { name: "Unassigned" } }, select: { id: true } });
    if (confs.length === 1) conferenceId = confs[0].id;
    else {
      conferenceId = (await prisma.conference.upsert({
        where: { seasonId_name: { seasonId: season.id, name: "Unassigned" } },
        create: { seasonId: season.id, name: "Unassigned" },
        update: {},
        select: { id: true },
      })).id;
    }
  }

  // Default name "Team {captain}"; Team.name is globally unique, so suffix on collision
  // ONLY for the default (an explicit name collision is an error the admin should see).
  const wanted = (input.name ?? "").trim() || `Team ${captain.displayName}`;
  let teamName = wanted;
  if (!input.name?.trim()) {
    for (let n = 2; await prisma.team.findUnique({ where: { name: teamName }, select: { id: true } }); n++) {
      teamName = `${wanted} ${n}`;
    }
  } else if (await prisma.team.findUnique({ where: { name: teamName }, select: { id: true } })) {
    throw new Error(`A team named "${teamName}" already exists.`);
  }

  const maxSeed = await prisma.teamSeason.aggregate({ where: { seasonId: season.id }, _max: { seed: true } });
  const team = await prisma.team.create({ data: { name: teamName } });
  const ts = await prisma.teamSeason.create({
    data: { seasonId: season.id, teamId: team.id, conferenceId, captainPlayerId: captain.id, seed: (maxSeed._max.seed ?? 0) + 1 },
  });
  return { teamSeasonId: ts.id, teamName, captain: captain.displayName };
}

// Rename a team (Team.name is the cross-season identity — pre-launch this is fine).
// Callers gate: TO / ROSTERS mod / the team's own captain or co-captain.
export async function renameTeam(teamSeasonId: string, newName: string) {
  const clean = newName.trim();
  if (!clean) throw new Error("A team name is required.");
  if (clean.length > 48) throw new Error("Keep it under 48 characters.");
  const ts = await prisma.teamSeason.findUnique({ where: { id: teamSeasonId }, include: { team: true } });
  if (!ts) throw new Error("No such team.");
  if (ts.team.name === clean) return { ok: true, name: clean };
  const clash = await prisma.team.findUnique({ where: { name: clean }, select: { id: true } });
  if (clash) throw new Error(`A team named "${clean}" already exists.`);
  await prisma.team.update({ where: { id: ts.teamId }, data: { name: clean } });
  return { ok: true, name: clean };
}

// Move a team to another conference (same season only).
export async function setTeamConference(teamSeasonId: string, conferenceId: string) {
  const [ts, conf] = await Promise.all([
    prisma.teamSeason.findUnique({ where: { id: teamSeasonId }, select: { seasonId: true } }),
    prisma.conference.findUnique({ where: { id: conferenceId }, select: { seasonId: true } }),
  ]);
  if (!ts || !conf) throw new Error("No such team or conference.");
  if (ts.seasonId !== conf.seasonId) throw new Error("That conference belongs to a different season.");
  await prisma.teamSeason.update({ where: { id: teamSeasonId }, data: { conferenceId } });
  return { ok: true };
}

// Which approved players already captain a team this season, keyed by discordId — lets the
// signups review show a "Captain · Team X" badge and hide the "Make captain" button for them.
export async function captainedTeamsByDiscord(seasonName: string): Promise<Map<string, { team: string; teamSeasonId: string }>> {
  const season = await prisma.tourSeason.findUnique({ where: { name: seasonName }, select: { id: true } });
  if (!season) return new Map();
  const tss = await prisma.teamSeason.findMany({ where: { seasonId: season.id }, include: { team: { select: { name: true } } } });
  const caps = await prisma.player.findMany({ where: { id: { in: tss.map((t) => t.captainPlayerId) } }, select: { id: true, discordId: true } });
  const discOf = new Map(caps.map((c) => [c.id, c.discordId]));
  const out = new Map<string, { team: string; teamSeasonId: string }>();
  for (const t of tss) {
    const d = discOf.get(t.captainPlayerId);
    if (d) out.set(d, { team: t.team.name, teamSeasonId: t.id });
  }
  return out;
}

// The season's teams for the manual-management page.
export async function listSeasonTeams(seasonName: string) {
  const season = await prisma.tourSeason.findUnique({ where: { name: seasonName }, select: { id: true } });
  if (!season) throw new Error(`No season "${seasonName}"`);
  const tss = await prisma.teamSeason.findMany({
    where: { seasonId: season.id },
    include: { team: true, conference: true },
    orderBy: { seed: "asc" },
  });
  const capIds = [...new Set(tss.map((t) => t.captainPlayerId))];
  const caps = await prisma.player.findMany({ where: { id: { in: capIds } }, select: { id: true, displayName: true } });
  const capName = new Map(caps.map((c) => [c.id, c.displayName]));
  return tss.map((t) => ({
    teamSeasonId: t.id,
    name: t.team.name,
    seed: t.seed,
    conferenceId: t.conferenceId,
    conference: t.conference.name,
    captain: capName.get(t.captainPlayerId) ?? t.captainPlayerId,
  }));
}

// Force-delete a team-season and everything that references it (sets + their matches,
// playoff series, draft picks, roster moves, rival pointers; rosters/entries cascade via
// FK), then the Team itself if it has no seasons left. Returns what was removed.
export async function deleteTeamSeason(teamSeasonId: string): Promise<{ team: string; setsDeleted: number }> {
  if (!teamSeasonId) throw new Error("No team selected.");
  const ts = await prisma.teamSeason.findUnique({ where: { id: teamSeasonId }, include: { team: true } });
  if (!ts) throw new Error("No such team-season.");

  const sets = await prisma.tourSet.findMany({
    where: { OR: [{ teamSeasonAId: teamSeasonId }, { teamSeasonBId: teamSeasonId }] },
    select: { id: true, matchId: true },
  });
  if (sets.length) {
    await prisma.tourSet.deleteMany({ where: { id: { in: sets.map((s) => s.id) } } });
    const matchIds = sets.map((s) => s.matchId).filter((x): x is string => !!x);
    if (matchIds.length) await prisma.match.deleteMany({ where: { id: { in: matchIds } } });
  }
  await prisma.playoffSeries.deleteMany({ where: { OR: [{ teamSeasonAId: teamSeasonId }, { teamSeasonBId: teamSeasonId }] } });
  await prisma.draftPick.deleteMany({ where: { teamSeasonId } });
  await prisma.rosterMove.deleteMany({ where: { teamSeasonId } });
  await prisma.teamSeason.updateMany({ where: { rivalTeamSeasonId: teamSeasonId }, data: { rivalTeamSeasonId: null } });
  await prisma.teamSeason.delete({ where: { id: teamSeasonId } }); // cascades rosters + entries

  const remaining = await prisma.teamSeason.count({ where: { teamId: ts.teamId } });
  if (remaining === 0) await prisma.team.delete({ where: { id: ts.teamId } });
  return { team: ts.team.name, setsDeleted: sets.length };
}
