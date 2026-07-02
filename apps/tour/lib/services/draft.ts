// Draft service. Setup materializes the approved-signup pool into core Players,
// creates a Team + TeamSeason per willing captain, splits them across the season's
// conferences, and builds the snake draft board (tour-core buildDraft) as PENDING
// Draft + DraftPick rows. The live board (making picks) is the next layer.
//
// Defaults are intentionally simple for v1 — draft order = captain add order,
// conferences split round-robin, captain self-picks in round 1 (= seed 1). The TO
// refines later; nothing here is irreversible (resetDraft wipes it).
import { prisma } from "../db";
import { buildDraft } from "@balatro/tour-core";
import { getAllTimePlayers } from "../stats";
import { notifyLive } from "../notify";

export async function getDraftSetup(seasonName: string) {
  const season = await prisma.tourSeason.findUnique({
    where: { name: seasonName },
    include: { draft: { select: { id: true, state: true } } },
  });
  if (!season) return null;
  const approved = await prisma.signup.findMany({
    where: { seasonId: season.id, status: "APPROVED" },
    orderBy: { createdAt: "asc" },
  });
  return { season, approved, captains: approved.filter((s) => s.willingToCaptain) };
}

export async function setupDraft(seasonName: string) {
  const season = await prisma.tourSeason.findUnique({
    where: { name: seasonName },
    include: { draft: { select: { id: true } } },
  });
  if (!season) throw new Error(`No season "${seasonName}"`);
  if (season.draft) throw new Error("A draft already exists for this season — reset it first.");

  const approved = await prisma.signup.findMany({
    where: { seasonId: season.id, status: "APPROVED" },
    orderBy: { createdAt: "asc" },
  });
  const captains = approved.filter((s) => s.willingToCaptain);
  if (captains.length < 2) throw new Error("Need at least 2 approved, willing captains to set up a draft.");
  if (approved.length < captains.length) throw new Error("Pool is smaller than the captain count.");

  const rounds = season.teamSize; // players per team, incl. the captain

  // 1. Materialize every approved signup into a core Player (find-or-create by discordId).
  const playerByDiscord = new Map<string, string>();
  for (const s of approved) {
    const p = await prisma.player.upsert({
      where: { discordId: s.discordId },
      create: { discordId: s.discordId, displayName: s.displayName ?? s.discordId },
      update: {},
      select: { id: true },
    });
    playerByDiscord.set(s.discordId, p.id);
  }

  // 2. Conferences (SWISS = one pool).
  const confCount = season.format === "SWISS" ? 1 : Math.max(1, season.conferenceCount);
  const confIds: string[] = [];
  for (let i = 0; i < confCount; i++) {
    const cname = confCount === 1 ? "Main" : `Conference ${i + 1}`;
    const c = await prisma.conference.upsert({
      where: { seasonId_name: { seasonId: season.id, name: cname } },
      create: { seasonId: season.id, name: cname },
      update: {},
      select: { id: true },
    });
    confIds.push(c.id);
  }

  // 3. Team + TeamSeason per captain. Order = add order (seed = i+1); conference round-robin.
  const teamSeasonIds: string[] = [];
  const captainOf = new Map<string, string>();
  for (let i = 0; i < captains.length; i++) {
    const cap = captains[i];
    const captainPlayerId = playerByDiscord.get(cap.discordId)!;
    const teamName = cap.displayName ?? cap.discordId;
    const team = await prisma.team.upsert({
      where: { name: teamName },
      create: { name: teamName },
      update: {},
      select: { id: true },
    });
    const ts = await prisma.teamSeason.create({
      data: {
        seasonId: season.id,
        teamId: team.id,
        conferenceId: confIds[i % confIds.length],
        captainPlayerId,
        seed: i + 1,
      },
      select: { id: true },
    });
    teamSeasonIds.push(ts.id);
    captainOf.set(ts.id, captainPlayerId);
  }

  // 4. Build the snake board (captain self-picks round 1) + persist Draft + picks.
  const selfPickRound: Record<string, number> = {};
  for (const tsId of teamSeasonIds) selfPickRound[tsId] = 1;
  const slots = buildDraft(teamSeasonIds, rounds, selfPickRound);

  await prisma.draft.create({
    data: {
      seasonId: season.id,
      state: "PENDING",
      orderJson: JSON.stringify(teamSeasonIds),
      picks: {
        create: slots.map((s) => ({
          round: s.round,
          pickIndex: s.pickIndex,
          teamSeasonId: s.teamSeasonId,
          // Self-pick slots are pre-filled with the captain.
          playerId: s.isSelfPick ? captainOf.get(s.teamSeasonId) ?? null : null,
          pickedAt: s.isSelfPick ? new Date() : null,
        })),
      },
    },
  });
  await prisma.tourSeason.update({ where: { id: season.id }, data: { state: "DRAFTING" } });

  return { teams: teamSeasonIds.length, players: playerByDiscord.size, rounds, picks: slots.length };
}

// The live board: teams (with picks so far), the remaining pool, and who's on the
// clock. Server-rendered — each pool player is a pick form, no client state.
export async function getDraft(seasonName: string) {
  const season = await prisma.tourSeason.findUnique({ where: { name: seasonName }, include: { draft: true } });
  if (!season || !season.draft) return null;

  const [picks, teamSeasons] = await Promise.all([
    prisma.draftPick.findMany({ where: { draftId: season.draft.id }, orderBy: { pickIndex: "asc" } }),
    prisma.teamSeason.findMany({ where: { seasonId: season.id }, include: { team: true, conference: true }, orderBy: { seed: "asc" } }),
  ]);

  const approved = await prisma.signup.findMany({
    where: { seasonId: season.id, status: "APPROVED" },
    orderBy: [{ displayName: "asc" }],
  });
  const approvedPlayers = await prisma.player.findMany({
    where: { discordId: { in: approved.map((a) => a.discordId) } },
    select: { id: true, displayName: true, discordId: true },
  });
  const nameById = new Map<string, string>(approvedPlayers.map((p) => [p.id, p.displayName]));
  const caps = await prisma.player.findMany({
    where: { id: { in: [...teamSeasons.map((t) => t.captainPlayerId), ...picks.map((p) => p.playerId).filter((x): x is string => !!x)] } },
    select: { id: true, displayName: true },
  });
  for (const c of caps) nameById.set(c.id, c.displayName);

  const drafted = new Set(picks.map((p) => p.playerId).filter((x): x is string => !!x));
  const undrafted = approvedPlayers.filter((p) => !drafted.has(p.id));
  const current = picks.find((p) => !p.playerId) ?? null;

  // Draft helper: BMP rank (pulled at signup), career quick-stats, avg seed, and where any
  // pre-season PLAYER power rankings had each pool player — so captains draft informed.
  const signupByDiscord = new Map(approved.map((a) => [a.discordId, a]));
  const poolIds = undrafted.map((p) => p.id);
  const [careerStats, careers, playerRankings] = await Promise.all([
    prisma.playerCareerStat.findMany({ where: { playerId: { in: poolIds } }, select: { playerId: true, avgSeed: true } }),
    poolIds.length ? getAllTimePlayers() : Promise.resolve([]),
    prisma.powerRanking.findMany({ where: { seasonId: season.id, kind: "PLAYER" }, include: { entries: { select: { playerId: true, position: true } } }, orderBy: { postedAt: "asc" } }),
  ]);
  const avgSeedOf = new Map(careerStats.map((c) => [c.playerId, c.avgSeed]));
  const careerOf = new Map(careers.map((c) => [c.playerId, c]));
  const ranksOf = new Map<string, string[]>();
  for (const r of playerRankings) {
    const author = r.author ?? r.title;
    for (const e of r.entries) {
      if (!e.playerId) continue;
      const arr = ranksOf.get(e.playerId) ?? [];
      arr.push(`#${e.position} ${author}`);
      ranksOf.set(e.playerId, arr);
    }
  }
  const pool = undrafted.map((p) => {
    const su = signupByDiscord.get(p.discordId);
    const career = careerOf.get(p.id);
    const setTotal = career ? career.setW + career.setL : 0;
    return {
      id: p.id,
      displayName: p.displayName,
      bmp: su?.bmpTier ? `${su.bmpTier}${su.bmpMmr != null ? ` ${su.bmpMmr}` : ""}` : null,
      seasons: career?.seasons ?? 0,
      setPct: setTotal ? Math.round((100 * career!.setW) / setTotal) : null,
      avgSeed: avgSeedOf.get(p.id) ?? null,
      ranks: ranksOf.get(p.id) ?? [],
    };
  });

  const teams = teamSeasons.map((ts) => ({
    id: ts.id,
    name: ts.team.name,
    conference: ts.conference.name,
    seed: ts.seed,
    captainName: nameById.get(ts.captainPlayerId) ?? ts.captainPlayerId,
    onClock: current?.teamSeasonId === ts.id,
    picks: picks
      .filter((p) => p.teamSeasonId === ts.id && p.playerId)
      .map((p) => ({ round: p.round, name: nameById.get(p.playerId!) ?? p.playerId!, overall: p.pickIndex + 1 })),
  }));

  const currentTeam = current ? teams.find((t) => t.id === current.teamSeasonId) ?? null : null;
  // "Round R, Pick P — Nth overall": pick-in-round derives from position within the round.
  const pickInRound = current ? picks.filter((p) => p.round === current.round && p.pickIndex <= current.pickIndex).length : 0;
  // Sports-draft ticker: the next few teams coming up after the current pick (snake order
  // is fully known), so everyone can see who's on deck.
  const teamNameOf = new Map(teamSeasons.map((ts) => [ts.id, ts.team.name]));
  const upcoming = picks
    .filter((p) => !p.playerId && (!current || p.pickIndex > current.pickIndex))
    .slice(0, 5)
    .map((p) => ({ round: p.round, overall: p.pickIndex + 1, team: teamNameOf.get(p.teamSeasonId) ?? "?" }));
  return {
    season,
    state: season.draft.state,
    teams,
    pool,
    current: current ? { round: current.round, pickIndex: current.pickIndex, pickInRound, overall: current.pickIndex + 1, team: currentTeam } : null,
    upcoming,
    totalPicks: picks.length,
    madePicks: picks.filter((p) => p.playerId).length,
  };
}

// ── Draft-pick EDITOR (fix an imported/completed draft) ────────────────────
// The live board's pool is the approved-signup set (empty for imported seasons), so
// editing a finished draft needs its own path: list every pick + a pool of everyone
// rostered that season, and reassign a pick to a different player.
export async function getDraftEditData(seasonName: string) {
  const season = await prisma.tourSeason.findUnique({ where: { name: seasonName }, include: { draft: { select: { id: true } } } });
  if (!season?.draft) return null;
  const picks = await prisma.draftPick.findMany({ where: { draftId: season.draft.id }, orderBy: [{ teamSeasonId: "asc" }, { round: "asc" }] });
  const tsIds = [...new Set(picks.map((p) => p.teamSeasonId))];
  const teamSeasons = await prisma.teamSeason.findMany({ where: { id: { in: tsIds } }, include: { team: true } });
  const tName = new Map(teamSeasons.map((t) => [t.id, t.team.name]));
  const entries = await prisma.rosterEntry.findMany({ where: { roster: { teamSeason: { seasonId: season.id } } }, select: { playerId: true } });
  const pids = [...new Set([...entries.map((e) => e.playerId), ...picks.map((p) => p.playerId).filter((x): x is string => !!x)])];
  const players = await prisma.player.findMany({ where: { id: { in: pids } }, select: { id: true, displayName: true } });
  const pName = new Map(players.map((p) => [p.id, p.displayName]));
  return {
    picks: picks
      .map((p) => ({ id: p.id, sort: `${tName.get(p.teamSeasonId) ?? ""}${p.round}`, label: `${tName.get(p.teamSeasonId) ?? "?"} · R${p.round} · ${p.playerId ? pName.get(p.playerId) ?? "?" : "(empty)"}` }))
      .sort((a, b) => a.sort.localeCompare(b.sort)),
    players: players.map((p) => ({ id: p.id, name: p.displayName })).sort((a, b) => a.name.localeCompare(b.name)),
  };
}

// Reassign a single draft pick to a different player (fixes the draft board / heatmap /
// R# display). Roster membership is separate — use Roster ops for who's actually on a team.
export async function reassignDraftPick(pickId: string, newPlayerId: string) {
  if (!pickId) throw new Error("Pick a slot to fix.");
  if (!newPlayerId) throw new Error("Pick the player it should be.");
  const player = await prisma.player.findUnique({ where: { id: newPlayerId }, select: { id: true } });
  if (!player) throw new Error("No such player.");
  await prisma.draftPick.update({ where: { id: pickId }, data: { playerId: newPlayerId } });
  return { ok: true };
}

// The teamSeason currently on the clock (the next unfilled pick), or null — used to let that
// team's captain make their own pick.
export async function onClockTeam(seasonName: string): Promise<string | null> {
  const season = await prisma.tourSeason.findUnique({ where: { name: seasonName }, include: { draft: true } });
  if (!season?.draft) return null;
  const next = await prisma.draftPick.findFirst({ where: { draftId: season.draft.id, playerId: null }, orderBy: { pickIndex: "asc" }, select: { teamSeasonId: true } });
  return next?.teamSeasonId ?? null;
}

// Assign the on-the-clock pick to a player from the approved pool, then advance.
// When the last slot fills, mark the draft DONE + materialize rosters.
export async function makePick(seasonName: string, playerId: string) {
  const season = await prisma.tourSeason.findUnique({ where: { name: seasonName }, include: { draft: true } });
  if (!season?.draft) throw new Error("No draft for this season.");
  if (season.draft.state === "DONE") throw new Error("The draft is already complete.");

  const picks = await prisma.draftPick.findMany({ where: { draftId: season.draft.id }, orderBy: { pickIndex: "asc" } });
  const current = picks.find((p) => !p.playerId);
  if (!current) throw new Error("No open pick — the draft is complete.");

  const taken = new Set(picks.map((p) => p.playerId).filter((x): x is string => !!x));
  if (taken.has(playerId)) throw new Error("That player is already drafted.");

  const player = await prisma.player.findUnique({ where: { id: playerId }, select: { discordId: true } });
  if (!player) throw new Error("No such player.");
  const inPool = await prisma.signup.findFirst({
    where: { seasonId: season.id, discordId: player.discordId, status: "APPROVED" },
    select: { id: true },
  });
  if (!inPool) throw new Error("Player is not in the approved pool.");

  await prisma.draftPick.update({ where: { id: current.id }, data: { playerId, pickedAt: new Date() } });

  const stillOpen = picks.filter((p) => !p.playerId && p.id !== current.id).length;
  if (stillOpen === 0) {
    await prisma.draft.update({ where: { id: season.draft.id }, data: { state: "DONE" } });
    await materializeRosters(season.id, season.draft.id);
  } else if (season.draft.state === "PENDING") {
    await prisma.draft.update({ where: { id: season.draft.id }, data: { state: "ACTIVE" } });
  }
  await notifyLive(`draft:${season.id}`); // live refresh (C5)
  return { done: stillOpen === 0 };
}

// Turn the completed picks into the initial roster block (RosterEntry seed = round,
// captain flag from TeamSeason). Team/player pages + standings read Roster, not picks.
async function materializeRosters(seasonId: string, draftId: string) {
  const picks = await prisma.draftPick.findMany({
    where: { draftId, NOT: { playerId: null } },
    orderBy: { pickIndex: "asc" },
  });
  const teamSeasons = await prisma.teamSeason.findMany({ where: { seasonId }, select: { id: true, captainPlayerId: true } });
  const capOf = new Map(teamSeasons.map((t) => [t.id, t.captainPlayerId]));

  for (const ts of teamSeasons) {
    const roster = await prisma.roster.upsert({
      where: { teamSeasonId_weekBlock: { teamSeasonId: ts.id, weekBlock: "W1-4" } },
      create: { teamSeasonId: ts.id, weekBlock: "W1-4" },
      update: {},
      select: { id: true },
    });
    for (const p of picks.filter((x) => x.teamSeasonId === ts.id)) {
      await prisma.rosterEntry.upsert({
        where: { rosterId_playerId: { rosterId: roster.id, playerId: p.playerId! } },
        create: { rosterId: roster.id, playerId: p.playerId!, seed: p.round, isCaptain: capOf.get(ts.id) === p.playerId },
        update: { seed: p.round, isCaptain: capOf.get(ts.id) === p.playerId },
      });
      // Seed the weekly roster log: every drafted player is a DRAFTED move at week 1
      // (the lineup-over-time derivation + timeline read this; see roster-ops.ts).
      const exists = await prisma.rosterMove.findFirst({ where: { teamSeasonId: ts.id, playerId: p.playerId!, kind: "DRAFTED" } });
      if (!exists) {
        await prisma.rosterMove.create({
          data: { seasonId, teamSeasonId: ts.id, kind: "DRAFTED", playerId: p.playerId!, effectiveWeek: 1, seed: p.round },
        });
      }
    }
  }
}

// Wipe the draft + the season's teams/conferences so setup can be re-run.
// Pre-launch, destructive resets are fine ([[feedback_no_backcompat]]).
export async function resetDraft(seasonName: string) {
  const season = await prisma.tourSeason.findUnique({ where: { name: seasonName }, select: { id: true } });
  if (!season) throw new Error(`No season "${seasonName}"`);
  await prisma.draft.deleteMany({ where: { seasonId: season.id } }); // cascades DraftPick
  await prisma.teamSeason.deleteMany({ where: { seasonId: season.id } }); // cascades Roster
  await prisma.conference.deleteMany({ where: { seasonId: season.id } });
  await prisma.tourSeason.update({ where: { id: season.id }, data: { state: "SIGNUPS" } });
  await notifyLive(`draft:${season.id}`);
}
