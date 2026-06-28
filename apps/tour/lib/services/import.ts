// Import service — the historical-data ingestion logic, centralized so it's
// callable from the admin API/UI (or anywhere), not trapped in a script. The pure
// sheet PARSERS live in lib/import/*; this is the DB orchestration.
//
// Reads the Google-Sheets exports from a directory (TOUR_SHEETS_DIR, default
// D:/STuffinside). Idempotent (upserts + keyed re-imports).
import { join } from "node:path";
import { prisma } from "../db";
// Pure parsers (framework-agnostic utilities).
import { parseRosters } from "../import/parse-rosters.mjs";
import { parseGameLog } from "../import/parse-gamelog.mjs";
import { parseHallOfFame } from "../import/parse-hof.mjs";
import { parseStandingsConferences } from "../import/parse-conferences.mjs";
import { parseWorkMatchups } from "../import/parse-work.mjs";
import { parseDrafts } from "../import/parse-drafts.mjs";
import { parseAwards } from "../import/parse-awards.mjs";
import { parsePlayerStats } from "../import/parse-player-stats.mjs";
import { SEASON_CONFIG, DEFAULT_SEASON } from "../import/seasons-config.mjs";
import { slug } from "../import/sheet.mjs";
import { backfillDraftedMoves } from "./roster-ops";

const majority = (n: number) => Math.floor(n / 2) + 1;

type SeasonCfg = {
  format: "SWISS" | "CONFERENCES";
  conferences?: Record<string, string[]>;
  conferenceStandingsSheet?: string;
};
const seasonCfg = SEASON_CONFIG as Record<number, SeasonCfg>;
const defaultCfg = DEFAULT_SEASON as SeasonCfg;

// Shapes of the (untyped JS) parser outputs.
type RosterPlayer = { name: string; avgSeed: number | null; isCaptain: boolean };
type RosterTeam = { season: number; name: string; players: RosterPlayer[] };
type GameLogSet = { season: number; p1: string; p2: string; p1s: number; p2s: number; p1seed: number | null; p2seed: number | null; rowIdx: number };
type ChampRun = { season: number; champion: string; rounds: { round: "QUARTERFINAL" | "SEMIFINAL" | "FINAL"; opp: string; champScore: number; oppScore: number }[] };
type WorkMatchup = { week: number; teamA: string; teamB: string; setsA: number; setsB: number; gamesA: number; gamesB: number };
type DraftBlock = { season: number; teams: { captain: string; picks: string[] }[] };
type MvpRow = { season: number; player: string; set: number; games: number; team: string; placement: number | null };
type PlayerStatRow = { name: string; avgSeed: number | null; rookieSeason: number | null; championships: number; finalsMade: number; playoffsMade: number; everCaptain: boolean };

export function sheetsDir(override?: string): string {
  return override || process.env.TOUR_SHEETS_DIR || "D:/STuffinside";
}

async function importRosters(dir: string) {
  const teams = parseRosters(dir) as RosterTeam[];
  const seasons = [...new Set(teams.map((t) => t.season))].sort((a, b) => a - b);

  for (const season of seasons) {
    const seasonTeams = teams.filter((t) => t.season === season);
    const teamSize = Math.max(...seasonTeams.map((t) => t.players.length));
    const cfg = seasonCfg[season] ?? defaultCfg;
    const tourSeason = await prisma.tourSeason.upsert({
      where: { name: `Team Tour ${season}` },
      create: { name: `Team Tour ${season}`, teamSize, setsToWin: majority(teamSize), defaultBestOf: 5, state: "DONE", format: cfg.format },
      update: { teamSize, setsToWin: majority(teamSize), format: cfg.format },
    });

    const teamConfName = new Map<string, string>();
    let confNames: Set<string>;
    if (cfg.format === "CONFERENCES") {
      const map = cfg.conferences ?? (cfg.conferenceStandingsSheet ? parseStandingsConferences(join(dir, cfg.conferenceStandingsSheet)) : {});
      for (const [cn, ts] of Object.entries(map)) for (const tn of ts as string[]) teamConfName.set(tn, cn);
      confNames = new Set([...Object.keys(map), "Unassigned"]);
    } else {
      confNames = new Set(["Swiss"]);
    }
    const confId = new Map<string, string>();
    for (const cn of confNames) {
      const c = await prisma.conference.upsert({
        where: { seasonId_name: { seasonId: tourSeason.id, name: cn } },
        create: { seasonId: tourSeason.id, name: cn },
        update: {},
      });
      confId.set(cn, c.id);
    }
    const confFor = (teamName: string) =>
      cfg.format === "CONFERENCES" ? confId.get(teamConfName.get(teamName) ?? "Unassigned")! : confId.get("Swiss")!;

    for (const t of seasonTeams) {
      const playerId = new Map<string, string>();
      for (const p of t.players) {
        const player = await prisma.player.upsert({
          where: { discordId: `legacy:${slug(p.name)}` },
          create: { discordId: `legacy:${slug(p.name)}`, displayName: p.name },
          update: { displayName: p.name },
        });
        playerId.set(p.name, player.id);
      }
      const captain = t.players.find((p) => p.isCaptain) ?? t.players[0];
      const team = await prisma.team.upsert({ where: { name: t.name }, create: { name: t.name }, update: {} });
      const teamSeason = await prisma.teamSeason.upsert({
        where: { seasonId_teamId: { seasonId: tourSeason.id, teamId: team.id } },
        create: { seasonId: tourSeason.id, teamId: team.id, conferenceId: confFor(t.name), captainPlayerId: playerId.get(captain.name)!, seed: 0 },
        update: { conferenceId: confFor(t.name), captainPlayerId: playerId.get(captain.name)! },
      });
      const roster = await prisma.roster.upsert({
        where: { teamSeasonId_weekBlock: { teamSeasonId: teamSeason.id, weekBlock: "FULL" } },
        create: { teamSeasonId: teamSeason.id, weekBlock: "FULL" },
        update: {},
      });
      const ranked = [...t.players].sort((a, b) => (a.avgSeed ?? 99) - (b.avgSeed ?? 99));
      let seed = 1;
      for (const p of ranked) {
        await prisma.rosterEntry.upsert({
          where: { rosterId_playerId: { rosterId: roster.id, playerId: playerId.get(p.name)! } },
          create: { rosterId: roster.id, playerId: playerId.get(p.name)!, seed, isCaptain: p.isCaptain },
          update: { seed, isCaptain: p.isCaptain },
        });
        seed++;
      }
    }
  }
  await prisma.conference.deleteMany({ where: { teamSeasons: { none: {} } } });
}

async function importResults(dir: string) {
  const sets = parseGameLog(dir) as GameLogSet[];
  const seasonRows = await prisma.tourSeason.findMany({ select: { id: true, name: true } });
  const seasonId = new Map(seasonRows.map((s) => [Number(s.name.replace(/\D/g, "")), s.id]));

  const prior = await prisma.tourSet.findMany({ where: { importKey: { startsWith: "gamelog:" } }, select: { matchId: true } });
  await prisma.tourSet.deleteMany({ where: { importKey: { startsWith: "gamelog:" } } });
  const priorMatchIds = prior.map((p) => p.matchId).filter((x): x is string => !!x);
  if (priorMatchIds.length) await prisma.match.deleteMany({ where: { id: { in: priorMatchIds } } });

  const names = [...new Set(sets.flatMap((s) => [s.p1, s.p2]))];
  const idByName = new Map<string, string>();
  for (const name of names) {
    const p = await prisma.player.upsert({
      where: { discordId: `legacy:${slug(name)}` },
      create: { discordId: `legacy:${slug(name)}`, displayName: name },
      update: {},
    });
    idByName.set(name, p.id);
  }

  let made = 0;
  const CHUNK = 50;
  for (let i = 0; i < sets.length; i += CHUNK) {
    await Promise.all(
      sets.slice(i, i + CHUNK).map(async (s) => {
        const sid = seasonId.get(s.season);
        if (!sid) return;
        const aId = idByName.get(s.p1)!;
        const bId = idByName.get(s.p2)!;
        const [mA, mB] = aId < bId ? [aId, bId] : [bId, aId];
        const gwA = mA === aId ? s.p1s : s.p2s;
        const gwB = mA === aId ? s.p2s : s.p1s;
        const winnerId = gwA > gwB ? mA : gwB > gwA ? mB : null;
        const bestOf = Math.max(1, 2 * Math.max(s.p1s, s.p2s) - 1);
        const match = await prisma.match.create({
          data: { playerAId: mA, playerBId: mB, format: "HISTORICAL", gamesWonA: gwA, gamesWonB: gwB, winnerId, status: "CONFIRMED" },
        });
        await prisma.tourSet.create({
          data: {
            importKey: `gamelog:s${s.season}:${s.rowIdx}`,
            seasonId: sid,
            bracket: "REGULAR",
            matchId: match.id,
            playerAId: aId,
            playerBId: bId,
            seedA: Math.round(s.p1seed ?? 0),
            seedB: Math.round(s.p2seed ?? 0),
            bestOf,
            status: "CONFIRMED",
          },
        });
        made++;
      }),
    );
  }
  return made;
}

async function importPlayoffs(dir: string) {
  const champs = parseHallOfFame(dir) as ChampRun[];
  await prisma.playoffSeries.deleteMany({});
  let made = 0;
  for (const c of champs) {
    const season = await prisma.tourSeason.findUnique({ where: { name: `Team Tour ${c.season}` }, select: { id: true } });
    if (!season) continue;
    const tss = await prisma.teamSeason.findMany({ where: { seasonId: season.id }, include: { team: true } });
    const idByName = new Map(tss.map((t) => [t.team.name, t.id]));
    const champId = idByName.get(c.champion);
    if (!champId) continue;
    for (const r of c.rounds) {
      await prisma.playoffSeries.create({
        data: {
          seasonId: season.id,
          round: r.round,
          teamSeasonAId: champId,
          teamSeasonBId: idByName.get(r.opp) ?? null,
          scoreA: r.champScore,
          scoreB: r.oppScore,
          winnerTeamSeasonId: champId,
        },
      });
      made++;
    }
  }
  return made;
}

/** Import the alltime data (rosters + results + playoffs). Returns row counts. */
// Import historical draft order/picks from `alltime/Drafts.html`. Links each
// team's picks to the already-imported TeamSeason (matched by captain name) and
// the picked players (legacy:<slug> ids, same scheme as rosters). Idempotent:
// rebuilds each season's Draft + DraftPick rows. Run AFTER importRosters.
export async function importDrafts(dir = sheetsDir()) {
  const blocks = parseDrafts(join(dir, "alltime", "Drafts.html")) as DraftBlock[];
  let drafts = 0;
  let picks = 0;
  let teamsMatched = 0;
  let teamsMissed = 0;

  for (const block of blocks) {
    const season = await prisma.tourSeason.findUnique({ where: { name: `Team Tour ${block.season}` }, select: { id: true } });
    if (!season) continue;

    // Each imported TeamSeason's roster as a set of player-name slugs. We match a
    // draft row to the team whose roster shares the most players with it (robust to
    // captain-name spelling differences between the rosters + drafts sheets).
    const teamSeasons = await prisma.teamSeason.findMany({
      where: { seasonId: season.id },
      select: { id: true, rosters: { select: { entries: { select: { playerId: true } } } } },
    });
    const allPlayerIds = [...new Set(teamSeasons.flatMap((t) => t.rosters.flatMap((r) => r.entries.map((e) => e.playerId))))];
    const players = await prisma.player.findMany({ where: { id: { in: allPlayerIds } }, select: { id: true, displayName: true } });
    const slugById = new Map(players.map((p) => [p.id, slug(p.displayName)]));
    const candidates = teamSeasons.map((t) => ({
      id: t.id,
      slugs: new Set(t.rosters.flatMap((r) => r.entries.map((e) => slugById.get(e.playerId)).filter((x): x is string => !!x))),
    }));
    const used = new Set<string>();

    const draft = await prisma.draft.upsert({
      where: { seasonId: season.id },
      create: { seasonId: season.id, state: "DONE", orderJson: JSON.stringify(teamSeasons.map((t) => t.id)) },
      update: { state: "DONE" },
      select: { id: true },
    });
    await prisma.draftPick.deleteMany({ where: { draftId: draft.id } });
    drafts++;

    let pickIndex = 0;
    for (const team of block.teams) {
      const draftSlugs = [slug(team.captain), ...team.picks.map((p) => slug(p))];
      let bestId: string | null = null;
      let bestScore = 0;
      for (const c of candidates) {
        if (used.has(c.id)) continue;
        const score = draftSlugs.reduce((n, s) => n + (c.slugs.has(s) ? 1 : 0), 0);
        if (score > bestScore) {
          bestScore = score;
          bestId = c.id;
        }
      }
      const tsId = bestScore >= 2 ? bestId : null;
      if (!tsId) {
        teamsMissed++;
        continue;
      }
      used.add(tsId);
      teamsMatched++;
      for (let r = 0; r < team.picks.length; r++) {
        const player = await prisma.player.upsert({
          where: { discordId: `legacy:${slug(team.picks[r])}` },
          create: { discordId: `legacy:${slug(team.picks[r])}`, displayName: team.picks[r] },
          update: {},
          select: { id: true },
        });
        await prisma.draftPick.create({
          data: { draftId: draft.id, round: r + 1, pickIndex: pickIndex++, teamSeasonId: tsId, playerId: player.id, pickedAt: new Date() },
        });
        picks++;
      }
    }
  }

  return { drafts, picks, teamsMatched, teamsMissed };
}

// Import Season MVP awards from `alltime/Awards.html` (only the reliably-parseable
// MVP block — see parse-awards.mjs). Idempotent per season. Other award kinds need
// a cleaned sheet first.
export async function importAwards(dir = sheetsDir()) {
  const { mvp } = parseAwards(join(dir, "alltime", "Awards.html")) as { mvp: MvpRow[] };
  let made = 0;
  for (const m of mvp) {
    const season = await prisma.tourSeason.findUnique({ where: { name: `Team Tour ${m.season}` }, select: { id: true } });
    if (!season) continue;
    const player = await prisma.player.upsert({
      where: { discordId: `legacy:${slug(m.player)}` },
      create: { discordId: `legacy:${slug(m.player)}`, displayName: m.player },
      update: {},
      select: { id: true },
    });
    await prisma.award.deleteMany({ where: { seasonId: season.id, kind: "MVP" } });
    await prisma.award.create({
      data: {
        seasonId: season.id,
        kind: "MVP",
        playerId: player.id,
        meta: { set: m.set, games: m.games, team: m.team, placement: m.placement },
      },
    });
    made++;
  }
  return { mvp: made };
}

// Import per-player career counters from `alltime/Player Stats.html` (avg seed,
// championships / finals / playoffs MADE, captain) into PlayerCareerStat. Links to
// EXISTING players by legacy slug only (no phantom players from the stats sheet).
export async function importPlayerStats(dir = sheetsDir()) {
  const rows = parsePlayerStats(join(dir, "alltime", "Player Stats.html")) as PlayerStatRow[];
  let made = 0;
  let missed = 0;
  for (const s of rows) {
    const player = await prisma.player.findUnique({ where: { discordId: `legacy:${slug(s.name)}` }, select: { id: true } });
    if (!player) {
      missed++;
      continue;
    }
    await prisma.playerCareerStat.upsert({
      where: { playerId: player.id },
      create: {
        playerId: player.id,
        avgSeed: s.avgSeed,
        rookieSeason: s.rookieSeason,
        championships: s.championships,
        finalsMade: s.finalsMade,
        playoffsMade: s.playoffsMade,
        everCaptain: s.everCaptain,
      },
      update: {
        avgSeed: s.avgSeed,
        rookieSeason: s.rookieSeason,
        championships: s.championships,
        finalsMade: s.finalsMade,
        playoffsMade: s.playoffsMade,
        everCaptain: s.everCaptain,
      },
    });
    made++;
  }
  return { careerStats: made, missed };
}

export async function importHistorical(dir = sheetsDir()) {
  await importRosters(dir);
  const sets = await importResults(dir);
  const playoffSeries = await importPlayoffs(dir);
  const draftStats = await importDrafts(dir); // after rosters: links picks to teams
  const awardStats = await importAwards(dir);
  const careerStats = await importPlayerStats(dir);
  // Seed the weekly roster-move log from the imported drafts (idempotent) so the
  // roster timeline + per-week lineup derivation work for historical seasons.
  const rosterMoves = await backfillDraftedMoves();
  const [players, teams, teamSeasons, conferences, matches, tourSets] = await Promise.all([
    prisma.player.count(),
    prisma.team.count(),
    prisma.teamSeason.count(),
    prisma.conference.count(),
    prisma.match.count(),
    prisma.tourSet.count(),
  ]);
  return { players, teams, teamSeasons, conferences, matches, tourSets, sets, playoffSeries, draftPicks: draftStats.picks, mvps: awardStats.mvp, careerStats: careerStats.careerStats, rosterMoves: rosterMoves.created };
}

/** Import the TT10 Pluto/Eris conference season (conferences ← Standings, team
 * matchups ← Work block 1). Team-level only. */
export async function importTT10(dir = sheetsDir()) {
  const confs = parseStandingsConferences(join(dir, "Standings.html")) as Record<string, string[]>;
  const matchups = parseWorkMatchups(join(dir, "Work.html")) as WorkMatchup[];
  const NAME = "Team Tour 10";
  const teamSize = 11;

  const season = await prisma.tourSeason.upsert({
    where: { name: NAME },
    create: { name: NAME, teamSize, setsToWin: 6, defaultBestOf: 5, state: "DONE", format: "CONFERENCES", conferenceCount: 2, playoffTeams: 8 },
    update: { format: "CONFERENCES", conferenceCount: 2, playoffTeams: 8 },
  });

  const tsByTeamName = new Map<string, string>();
  for (const [confName, teamNames] of Object.entries(confs)) {
    const conf = await prisma.conference.upsert({
      where: { seasonId_name: { seasonId: season.id, name: confName } },
      create: { seasonId: season.id, name: confName },
      update: {},
    });
    for (const teamName of teamNames as string[]) {
      const team = await prisma.team.upsert({ where: { name: teamName }, create: { name: teamName }, update: {} });
      const ts = await prisma.teamSeason.upsert({
        where: { seasonId_teamId: { seasonId: season.id, teamId: team.id } },
        create: { seasonId: season.id, teamId: team.id, conferenceId: conf.id, captainPlayerId: "legacy:unknown", seed: 0 },
        update: { conferenceId: conf.id },
      });
      tsByTeamName.set(teamName, ts.id);
    }
  }

  await prisma.matchup.deleteMany({ where: { week: { seasonId: season.id } } });
  await prisma.week.deleteMany({ where: { seasonId: season.id } });
  const weekId = new Map<number, string>();
  for (const wk of [...new Set(matchups.map((m) => m.week))].sort((a, b) => a - b)) {
    const w = await prisma.week.create({ data: { seasonId: season.id, number: wk, kind: "ROUND_ROBIN" } });
    weekId.set(wk, w.id);
  }

  let made = 0;
  for (const m of matchups) {
    const aId = tsByTeamName.get(m.teamA);
    const bId = tsByTeamName.get(m.teamB);
    if (!aId || !bId) continue;
    const winner = m.setsA > m.setsB ? aId : m.setsB > m.setsA ? bId : null;
    await prisma.matchup.create({
      data: {
        weekId: weekId.get(m.week)!,
        teamSeasonAId: aId,
        teamSeasonBId: bId,
        setsWonA: m.setsA,
        setsWonB: m.setsB,
        gamesWonA: m.gamesA,
        gamesWonB: m.gamesB,
        winnerTeamSeasonId: winner,
      },
    });
    made++;
  }
  return { conferences: Object.keys(confs).length, teams: tsByTeamName.size, matchups: made };
}
