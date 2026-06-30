// Import service — the historical-data ingestion logic, centralized so it's
// callable from the admin API/UI (or anywhere), not trapped in a script. The pure
// sheet PARSERS live in lib/import/*; this is the DB orchestration.
//
// Reads the Google-Sheets exports from a directory (TOUR_SHEETS_DIR, default
// D:/STuffinside). Idempotent (upserts + keyed re-imports).
import { join } from "node:path";
import { readdirSync, statSync } from "node:fs";
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
import { readSeasonXlsx, readSeasonResults, readSeasonPlayoffs } from "../import/parse-xlsx-season.mjs";
import { slug } from "../import/sheet.mjs";
import { backfillDraftedMoves } from "./roster-ops";
import { applySignupRefs } from "./identity";

const majority = (n: number) => Math.floor(n / 2) + 1;

// Resolve a sheet player name → a Player.id, IDENTITY-AWARE. Players are imported
// under a `legacy:<slug>` id, but once an admin links/merges them to a real Discord
// id that key stops matching — so a naive re-import would orphan them and create a
// duplicate (which is exactly the bug that detached linked players' data). We resolve
// in order: (1) a player who still holds `legacy:<slug>`, (2) a player carrying it in
// `aliases` (linked/merged but remembers the slug), (3) create a new legacy player
// (recording the slug as a self-alias) when `create` is set. `null` if not found and
// not creating. NOTHING here overwrites a linked player's id or display name.
async function resolvePlayerId(name: string, create: boolean): Promise<string | null> {
  const legacy = `legacy:${slug(name)}`;
  const direct = await prisma.player.findUnique({ where: { discordId: legacy }, select: { id: true } });
  if (direct) return direct.id;
  const aliased = await prisma.player.findFirst({ where: { aliases: { has: legacy } }, select: { id: true } });
  if (aliased) return aliased.id;
  if (!create) return null;
  const made = await prisma.player.create({ data: { discordId: legacy, displayName: name, aliases: [legacy] }, select: { id: true } });
  return made.id;
}

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
        playerId.set(p.name, (await resolvePlayerId(p.name, true))!);
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
  const rawSets = parseGameLog(dir) as GameLogSet[];
  // Some seasons' Game Log records TEAM matchups, not player matches (e.g. TT3). A row
  // whose BOTH sides are team names is a team-vs-team result — skip it so team names
  // never get turned into "players". (One side matching a team can be a real-player
  // coincidence, so require both.) Teams already exist here (importRosters ran first).
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const teamNames = new Set((await prisma.team.findMany({ select: { name: true } })).map((t) => norm(t.name)));
  const sets = rawSets.filter((s) => !(teamNames.has(norm(s.p1)) && teamNames.has(norm(s.p2))));

  const seasonRows = await prisma.tourSeason.findMany({ select: { id: true, name: true } });
  const seasonId = new Map(seasonRows.map((s) => [Number(s.name.replace(/\D/g, "")), s.id]));

  const prior = await prisma.tourSet.findMany({ where: { importKey: { startsWith: "gamelog:" } }, select: { matchId: true } });
  await prisma.tourSet.deleteMany({ where: { importKey: { startsWith: "gamelog:" } } });
  const priorMatchIds = prior.map((p) => p.matchId).filter((x): x is string => !!x);
  if (priorMatchIds.length) await prisma.match.deleteMany({ where: { id: { in: priorMatchIds } } });

  const names = [...new Set(sets.flatMap((s) => [s.p1, s.p2]))];
  const idByName = new Map<string, string>();
  for (const name of names) {
    idByName.set(name, (await resolvePlayerId(name, true))!);
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
        const playerId = (await resolvePlayerId(team.picks[r], true))!;
        await prisma.draftPick.create({
          data: { draftId: draft.id, round: r + 1, pickIndex: pickIndex++, teamSeasonId: tsId, playerId, pickedAt: new Date() },
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
    const playerId = (await resolvePlayerId(m.player, true))!;
    await prisma.award.deleteMany({ where: { seasonId: season.id, kind: "MVP" } });
    await prisma.award.create({
      data: {
        seasonId: season.id,
        kind: "MVP",
        playerId,
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
    const playerId = await resolvePlayerId(s.name, false);
    if (!playerId) {
      missed++;
      continue;
    }
    await prisma.playerCareerStat.upsert({
      where: { playerId },
      create: {
        playerId,
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

// Find the season xlsx exports (TT<n>.xlsx) in a directory and read each one's
// conference + signup data. The upload includes them; for local dev, TOUR_XLSX_DIR
// can point at them. Returns { [seasonNum]: { conferences, signups } }.
export async function seasonXlsxConfigs(
  dir: string,
): Promise<Record<number, Awaited<ReturnType<typeof readSeasonXlsx>>>> {
  const out: Record<number, Awaited<ReturnType<typeof readSeasonXlsx>>> = {};
  // Find each season's main workbook `TT<n>.xlsx` AND any supplementary signups-only
  // file `TT<n>Signups.xlsx` (some seasons' signups were missing/malformed in the main
  // export and were re-added separately). Walked, since the upload may nest them; plus
  // an optional TOUR_XLSX_DIR for local dev. First file of each kind per season wins.
  const mains = new Map<number, string>();
  const sigFiles = new Map<number, string[]>();
  const walk = (d: string, depth: number) => {
    if (depth > 4) return;
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(d, name);
      let dirent: ReturnType<typeof statSync>;
      try {
        dirent = statSync(full);
      } catch {
        continue;
      }
      if (dirent.isDirectory()) walk(full, depth + 1);
      else {
        // Main workbook: exactly TT<n>.xlsx. Signups: TT<n>Signups<anything>.xlsx
        // (covers re-downloads like "TT4Signups (2).xlsx"); collect ALL of them.
        const mainM = /^TT(\d+)\.xlsx$/i.exec(name);
        const sigM = /^TT(\d+)signups.*\.xlsx$/i.exec(name);
        if (mainM) {
          const num = Number(mainM[1]);
          if (!mains.has(num)) mains.set(num, full);
        } else if (sigM) {
          const num = Number(sigM[1]);
          (sigFiles.get(num) ?? sigFiles.set(num, []).get(num)!).push(full);
        }
      }
    }
  };
  for (const d of [dir, process.env.TOUR_XLSX_DIR].filter(Boolean) as string[]) walk(d, 0);

  for (const num of new Set([...mains.keys(), ...sigFiles.keys()])) {
    let conferences: Awaited<ReturnType<typeof readSeasonXlsx>>["conferences"] = {};
    let draftTeams: Awaited<ReturnType<typeof readSeasonXlsx>>["draftTeams"] = [];
    const signups: Awaited<ReturnType<typeof readSeasonXlsx>>["signups"] = [];
    if (mains.has(num)) {
      try {
        const r = await readSeasonXlsx(mains.get(num)!);
        conferences = r.conferences;
        draftTeams = r.draftTeams;
        signups.push(...r.signups);
      } catch { /* unreadable — skip */ }
    }
    for (const f of sigFiles.get(num) ?? []) {
      try {
        signups.push(...(await readSeasonXlsx(f)).signups); // pair-deduped downstream
      } catch { /* unreadable — skip */ }
    }
    out[num] = { conferences, signups, draftTeams };
  }
  return out;
}

// Apply the per-season conference + seed assignments to the imported teams: set the
// season format to CONFERENCES, create the real conferences, and assign each team to
// its conference + seed via fuzzy name match (sheet names can be truncated). The
// conference/seed data is READ FROM THE SEASON xlsx in `dir` (Standings tab), not
// baked in. Idempotent; skips seasons not yet imported or without an xlsx.
export async function applyConferenceData(dir = sheetsDir()) {
  const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]/g, "");
  let teamsSet = 0;
  const missed: string[] = [];

  const configs = await seasonXlsxConfigs(dir);
  for (const [numStr, cfg] of Object.entries(configs)) {
    const num = Number(numStr);
    const confs = cfg.conferences;
    if (!confs || Object.keys(confs).length === 0) continue;
    const season = await prisma.tourSeason.findUnique({
      where: { name: `Team Tour ${num}` },
      include: { teamSeasons: { include: { team: true } } },
    });
    if (!season) continue;

    await prisma.tourSeason.update({ where: { id: season.id }, data: { format: "CONFERENCES", conferenceCount: Object.keys(confs).length } });

    const confId = new Map<string, string>();
    for (const cn of Object.keys(confs)) {
      const c = await prisma.conference.upsert({
        where: { seasonId_name: { seasonId: season.id, name: cn } },
        create: { seasonId: season.id, name: cn },
        update: {},
      });
      confId.set(cn, c.id);
    }

    const match = (hint: string) => {
      const h = norm(hint);
      let ts = season.teamSeasons.find((t) => norm(t.team.name) === h);
      if (ts) return ts;
      if (hint.includes("...")) {
        const parts = hint.split("...").map(norm).filter(Boolean);
        ts = season.teamSeasons.find((t) => { const n = norm(t.team.name); return parts.every((p) => n.includes(p)) && n.startsWith(parts[0]); });
        if (ts) return ts;
      }
      return season.teamSeasons.find((t) => { const n = norm(t.team.name); return n.startsWith(h) || h.startsWith(n); });
    };

    for (const [cn, teams] of Object.entries(confs) as [string, [string, number][]][]) {
      for (const [teamHint, seed] of teams) {
        const ts = match(teamHint);
        if (ts) {
          await prisma.teamSeason.update({ where: { id: ts.id }, data: { conferenceId: confId.get(cn)!, seed } });
          teamsSet++;
        } else missed.push(`TT${num}: ${teamHint}`);
      }
    }

    // Drop now-empty placeholder conferences (e.g. the "Swiss"/"Unassigned" one
    // importRosters made before we knew the format).
    const real = new Set(Object.keys(confs));
    const all = await prisma.conference.findMany({ where: { seasonId: season.id }, include: { _count: { select: { teamSeasons: true } } } });
    for (const c of all) if (!real.has(c.name) && c._count.teamSeasons === 0) await prisma.conference.delete({ where: { id: c.id } });
  }
  return { teamsSet, missed };
}

// Read the signup preferred-name ↔ @username pairs from the season xlsx in `dir` and
// store them RAW (SignupRef). They resolve to real Discord ids LIVE later, against the
// league ref + a Discord member sync — so no import ordering dependency. Returns the
// number stored (deduped by the preferred-name/username pair).
export async function applySignupRefsFromDir(dir = sheetsDir()) {
  const configs = await seasonXlsxConfigs(dir);
  const all: { preferredName: string; username: string }[] = [];
  const seen = new Set<string>();
  for (const cfg of Object.values(configs)) {
    for (const s of cfg.signups ?? []) {
      const key = `${s.preferredName.toLowerCase()}|${s.username.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      all.push(s);
    }
  }
  if (!all.length) return { stored: 0 };
  return applySignupRefs(all);
}

// Clean up bogus imported "players":
//   1. Team-name phantoms — older imports turned team-vs-team Game Log rows (e.g. TT3)
//      into player matches. Delete those team-vs-team sets + their matches.
//   2. Orphans — any LEGACY player left with NO real footprint (no sets, draft picks,
//      roster entries, career stats, awards, or captaincy). Catches both the de-setted
//      team phantoms AND stray names that never belonged to a team.
// Never touches a LINKED player or anyone with real data (a sub who played a match, an
// MVP, etc. all keep their row). Idempotent; runs at the end of importHistorical.
export async function pruneOrphanPlayers(): Promise<{ removed: number; names: string[]; setsDeleted: number }> {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const teamNames = new Set((await prisma.team.findMany({ select: { name: true } })).map((t) => norm(t.name)));
  const players = await prisma.player.findMany({ select: { id: true, displayName: true, discordId: true } });

  // 1. Team-name phantoms: delete their team-vs-team sets + matches so they go orphan.
  const teamPhantomIds = players
    .filter((p) => p.discordId.startsWith("legacy:") && teamNames.has(norm(p.displayName)))
    .map((p) => p.id);
  let setsDeleted = 0;
  if (teamPhantomIds.length) {
    const teamSets = await prisma.tourSet.findMany({
      where: { AND: [{ playerAId: { in: teamPhantomIds } }, { playerBId: { in: teamPhantomIds } }] },
      select: { id: true, matchId: true },
    });
    if (teamSets.length) {
      await prisma.tourSet.deleteMany({ where: { id: { in: teamSets.map((s) => s.id) } } });
      const matchIds = teamSets.map((s) => s.matchId).filter((x): x is string => !!x);
      if (matchIds.length) await prisma.match.deleteMany({ where: { id: { in: matchIds } } });
      setsDeleted = teamSets.length;
    }
  }

  // 2. Delete legacy players with zero footprint.
  const removed: string[] = [];
  for (const p of players) {
    if (!p.discordId.startsWith("legacy:")) continue;
    const [sets, picks, rosters, career, awards, captain] = await Promise.all([
      prisma.tourSet.count({ where: { OR: [{ playerAId: p.id }, { playerBId: p.id }] } }),
      prisma.draftPick.count({ where: { playerId: p.id } }),
      prisma.rosterEntry.count({ where: { playerId: p.id } }),
      prisma.playerCareerStat.count({ where: { playerId: p.id } }),
      prisma.award.count({ where: { playerId: p.id } }),
      prisma.teamSeason.count({ where: { captainPlayerId: p.id } }),
    ]);
    if (sets + picks + rosters + career + awards + captain === 0) {
      await prisma.player.delete({ where: { id: p.id } });
      removed.push(p.displayName);
    }
  }
  return { removed: removed.length, names: removed, setsDeleted };
}

// Import PLAYER-level match results for conference seasons (e.g. TT4) from the season
// xlsx conference tabs (player-vs-player rows). The alltime HTML Game Log only covers
// TT1-3, so without this TT4 has team results but no player sets (so no player stats /
// H2H). Only fills seasons that have no player sets yet. Idempotent (keyed import).
export async function importConferenceResults(dir = sheetsDir()) {
  // Locate each season's main workbook (TT<n>.xlsx).
  const mains = new Map<number, string>();
  const walk = (d: string, depth: number) => {
    if (depth > 4) return;
    let entries: string[];
    try { entries = readdirSync(d); } catch { return; }
    for (const name of entries) {
      const full = join(d, name);
      let st: ReturnType<typeof statSync>;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) walk(full, depth + 1);
      else { const m = /^TT(\d+)\.xlsx$/i.exec(name); if (m && !mains.has(Number(m[1]))) mains.set(Number(m[1]), full); }
    }
  };
  for (const d of [dir, process.env.TOUR_XLSX_DIR].filter(Boolean) as string[]) walk(d, 0);

  let made = 0, subsTotal = 0;
  for (const [num, path] of mains) {
    const season = await prisma.tourSeason.findUnique({ where: { name: `Team Tour ${num}` }, select: { id: true } });
    if (!season) continue;
    if (await prisma.tourSet.count({ where: { seasonId: season.id } })) continue; // already has results (TT1-3)
    let results = (await readSeasonResults(path)) as {
      week?: number; teamA?: string; teamB?: string; p1: string; p1g: number; p2: string; p2g: number; bracket?: string;
    }[];
    if (!results.length) continue;
    // The Swiss parser includes team-header rows — drop any matchup whose BOTH sides
    // are team names (a team-vs-team row), leaving only player sets.
    const teamN = new Set((await prisma.team.findMany({ select: { name: true } })).map((t) => t.name.toLowerCase().replace(/[^a-z0-9]/g, "")));
    const nrm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
    results = results.filter((r) => !(teamN.has(nrm(r.p1)) && teamN.has(nrm(r.p2))));

    // Re-runnable: clear any prior xlsx-sourced results for this season first.
    const prior = await prisma.tourSet.findMany({ where: { importKey: { startsWith: `xlsxresult:s${num}:` } }, select: { matchId: true } });
    await prisma.tourSet.deleteMany({ where: { importKey: { startsWith: `xlsxresult:s${num}:` } } });
    const priorMatchIds = prior.map((p) => p.matchId).filter((x): x is string => !!x);
    if (priorMatchIds.length) await prisma.match.deleteMany({ where: { id: { in: priorMatchIds } } });

    // Resolve every player once.
    const names = [...new Set(results.flatMap((r) => [r.p1, r.p2]))];
    const idByName = new Map<string, string>();
    for (const n of names) idByName.set(n, (await resolvePlayerId(n, true))!);

    // Team name → teamSeason (fuzzy), and each teamSeason's FULL roster + current members
    // + max seed — so a player who PLAYED for a team becomes a roster member (subs too).
    const teamSeasons = await prisma.teamSeason.findMany({ where: { seasonId: season.id }, include: { team: true } });
    const tsByName = new Map(teamSeasons.map((t) => [nrm(t.team.name), t.id]));
    const matchTs = (name?: string): string | null => {
      if (!name) return null;
      const n = nrm(name);
      return tsByName.get(n) ?? teamSeasons.find((t) => { const tn = nrm(t.team.name); return tn.startsWith(n) || n.startsWith(tn); })?.id ?? null;
    };
    const rosterByTs = new Map<string, string>();
    const membersByTs = new Map<string, Set<string>>();
    const seedByPlayer = new Map<string, number>();
    const maxSeedByTs = new Map<string, number>();
    for (const t of teamSeasons) {
      const roster = await prisma.roster.upsert({ where: { teamSeasonId_weekBlock: { teamSeasonId: t.id, weekBlock: "FULL" } }, create: { teamSeasonId: t.id, weekBlock: "FULL" }, update: {} });
      rosterByTs.set(t.id, roster.id);
      const es = await prisma.rosterEntry.findMany({ where: { rosterId: roster.id }, select: { playerId: true, seed: true } });
      membersByTs.set(t.id, new Set(es.map((e) => e.playerId)));
      maxSeedByTs.set(t.id, es.reduce((m, e) => Math.max(m, e.seed), 0));
      for (const e of es) seedByPlayer.set(e.playerId, e.seed);
    }
    let subsAdded = 0;
    const ensureMember = async (tsId: string | null, playerId: string) => {
      if (!tsId) return;
      const members = membersByTs.get(tsId)!;
      if (members.has(playerId)) return;
      const seed = (maxSeedByTs.get(tsId) ?? 0) + 1;
      maxSeedByTs.set(tsId, seed);
      members.add(playerId);
      seedByPlayer.set(playerId, seedByPlayer.get(playerId) ?? seed);
      await prisma.rosterEntry.create({ data: { rosterId: rosterByTs.get(tsId)!, playerId, seed, isCaptain: false } });
      subsAdded++;
    };

    let i = 0;
    for (const r of results) {
      const aId = idByName.get(r.p1)!;
      const bId = idByName.get(r.p2)!;
      if (aId === bId) { i++; continue; }
      const tsA = matchTs(r.teamA);
      const tsB = matchTs(r.teamB);
      await ensureMember(tsA, aId);
      await ensureMember(tsB, bId);
      const [mA, mB] = aId < bId ? [aId, bId] : [bId, aId];
      const gwA = mA === aId ? r.p1g : r.p2g;
      const gwB = mA === aId ? r.p2g : r.p1g;
      const winnerId = gwA > gwB ? mA : gwB > gwA ? mB : null;
      const bestOf = Math.max(1, 2 * Math.max(r.p1g, r.p2g) - 1);
      const match = await prisma.match.create({
        data: { playerAId: mA, playerBId: mB, format: "HISTORICAL", gamesWonA: gwA, gamesWonB: gwB, winnerId, status: "CONFIRMED" },
      });
      await prisma.tourSet.create({
        data: {
          importKey: `xlsxresult:s${num}:${i++}`,
          seasonId: season.id,
          week: r.week ?? null,
          teamSeasonAId: tsA,
          teamSeasonBId: tsB,
          bracket: r.bracket === "PLAYOFF" ? "PLAYOFF" : "REGULAR",
          matchId: match.id,
          playerAId: aId,
          playerBId: bId,
          seedA: seedByPlayer.get(aId) ?? 0,
          seedB: seedByPlayer.get(bId) ?? 0,
          bestOf,
          status: "CONFIRMED",
        },
      });
      made++;
    }
    subsTotal += subsAdded;
  }
  return { sets: made, subsAdded: subsTotal };
}

// Create the season + team SHELLS for every TT<n>.xlsx (so seasons/teams come from the
// workbook, not the HTML). Teams from the Draft Results tab; conferences/seeds applied
// after by applyConferenceData. Swiss seasons get a single "Swiss" conference.
export async function importSeasonShellsFromXlsx(dir = sheetsDir()) {
  const configs = await seasonXlsxConfigs(dir);
  let seasons = 0, teams = 0;
  for (const [numStr, cfg] of Object.entries(configs)) {
    const num = Number(numStr);
    const draftTeams = cfg.draftTeams ?? [];
    if (!draftTeams.length) continue;
    const isConf = Object.keys(cfg.conferences ?? {}).length > 0;
    const teamSize = Math.max(11, ...draftTeams.map((t) => 1 + t.players.length + t.subs.length));
    const season = await prisma.tourSeason.upsert({
      where: { name: `Team Tour ${num}` },
      create: { name: `Team Tour ${num}`, teamSize, setsToWin: majority(teamSize), defaultBestOf: 5, state: "DONE", format: isConf ? "CONFERENCES" : "SWISS" },
      update: { format: isConf ? "CONFERENCES" : "SWISS" },
    });
    const placeholder = await prisma.conference.upsert({
      where: { seasonId_name: { seasonId: season.id, name: isConf ? "Unassigned" : "Swiss" } },
      create: { seasonId: season.id, name: isConf ? "Unassigned" : "Swiss" },
      update: {},
    });
    for (const dt of draftTeams) {
      const team = await prisma.team.upsert({ where: { name: dt.team }, create: { name: dt.team }, update: {} });
      await prisma.teamSeason.upsert({
        where: { seasonId_teamId: { seasonId: season.id, teamId: team.id } },
        create: { seasonId: season.id, teamId: team.id, conferenceId: placeholder.id, captainPlayerId: "legacy:unknown", seed: 0 },
        update: {},
      });
      teams++;
    }
    seasons++;
  }
  return { seasons, teams };
}

// Import the TEAM-level playoff bracket + champion for each season from its xlsx Playoffs
// tab. The champion is the team that won a series and lost none; we store the champion's
// PATH as PlayoffSeries rows in the same "team A = champion" shape getChampionRun already
// reads. Idempotent (clears the season's series first).
export async function importPlayoffsFromXlsx(dir = sheetsDir()) {
  const nrm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]/g, "");
  const mains = new Map<number, string>();
  const walk = (d: string, depth: number) => {
    if (depth > 4) return;
    let entries: string[];
    try { entries = readdirSync(d); } catch { return; }
    for (const name of entries) {
      const full = join(d, name);
      let st: ReturnType<typeof statSync>;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) walk(full, depth + 1);
      else { const m = /^TT(\d+)\.xlsx$/i.exec(name); if (m && !mains.has(Number(m[1]))) mains.set(Number(m[1]), full); }
    }
  };
  for (const d of [dir, process.env.TOUR_XLSX_DIR].filter(Boolean) as string[]) walk(d, 0);

  const roundRank: Record<string, number> = { QUARTERFINAL: 0, SEMIFINAL: 1, FINAL: 2 };
  let created = 0, champions = 0;
  for (const [num, path] of mains) {
    const season = await prisma.tourSeason.findUnique({ where: { name: `Team Tour ${num}` }, include: { teamSeasons: { include: { team: true } } } });
    if (!season) continue;
    const raw = (await readSeasonPlayoffs(path)) as { round: string | null; teamA: string; scoreA: number; scoreB: number; teamB: string }[];
    if (!raw.length) continue;
    const tsByName = new Map(season.teamSeasons.map((t) => [nrm(t.team.name), t.id]));
    const matchTs = (name: string): string | null => {
      const n = nrm(name);
      return tsByName.get(n) ?? season.teamSeasons.find((t) => { const tn = nrm(t.team.name); return tn.startsWith(n) || n.startsWith(tn); })?.id ?? null;
    };
    // Keep team-vs-team series (player rows can't match a team name).
    const series = raw.filter((s) => matchTs(s.teamA) && matchTs(s.teamB));
    if (!series.length) continue;
    // Champion = won a series, never lost one.
    const winners = new Set<string>(), losers = new Set<string>();
    for (const s of series) {
      const aWon = s.scoreA >= s.scoreB;
      winners.add(nrm(aWon ? s.teamA : s.teamB));
      losers.add(nrm(aWon ? s.teamB : s.teamA));
    }
    const champion = [...winners].find((w) => !losers.has(w));
    if (!champion) continue;

    await prisma.playoffSeries.deleteMany({ where: { seasonId: season.id } });
    const champPath = series
      .filter((s) => nrm(s.teamA) === champion || nrm(s.teamB) === champion)
      .map((s) => ({ ...s, round: (s.round ?? "FINAL") as string })) // champion's unlabeled series = the final
      .sort((a, b) => (roundRank[a.round] ?? 9) - (roundRank[b.round] ?? 9));
    let idx = 0;
    for (const s of champPath) {
      const champIsA = nrm(s.teamA) === champion;
      await prisma.playoffSeries.create({
        data: {
          seasonId: season.id,
          round: s.round as never,
          bracketIndex: idx++,
          teamSeasonAId: matchTs(champIsA ? s.teamA : s.teamB),
          teamSeasonBId: matchTs(champIsA ? s.teamB : s.teamA),
          scoreA: champIsA ? s.scoreA : s.scoreB,
          scoreB: champIsA ? s.scoreB : s.scoreA,
          winnerTeamSeasonId: matchTs(champIsA ? s.teamA : s.teamB),
        },
      });
      created++;
    }
    champions++;
  }
  return { series: created, champions };
}

// Derive each player's career counters (PlayerCareerStat) from already-imported data —
// replaces the HTML Player Stats parse. avgSeed from roster seeds; championships/finals
// from the FINAL PlayoffSeries (winner + the two finalists); playoffsMade from PLAYOFF
// TourSets; everCaptain from roster/captain; rookieSeason from the earliest season.
export async function deriveCareerStats() {
  const [entries, rosters, teamSeasons, seasons, finals, playoffSets] = await Promise.all([
    prisma.rosterEntry.findMany({ select: { rosterId: true, playerId: true, seed: true, isCaptain: true } }),
    prisma.roster.findMany({ select: { id: true, teamSeasonId: true } }),
    prisma.teamSeason.findMany({ select: { id: true, seasonId: true, captainPlayerId: true } }),
    prisma.tourSeason.findMany({ select: { id: true, name: true } }),
    prisma.playoffSeries.findMany({ where: { round: "FINAL" as never }, select: { teamSeasonAId: true, teamSeasonBId: true, winnerTeamSeasonId: true } }),
    prisma.tourSet.findMany({ where: { bracket: "PLAYOFF" }, select: { playerAId: true, playerBId: true, seasonId: true } }),
  ]);
  const rosterTs = new Map(rosters.map((r) => [r.id, r.teamSeasonId]));
  const tsSeason = new Map(teamSeasons.map((t) => [t.id, t.seasonId]));
  const seasonNum = new Map(seasons.map((s) => [s.id, Number(s.name.replace(/\D/g, ""))]));
  const captainOf = new Map(teamSeasons.filter((t) => t.captainPlayerId).map((t) => [t.id, t.captainPlayerId!]));
  const champTs = new Set(finals.map((f) => f.winnerTeamSeasonId).filter((x): x is string => !!x));
  const finalistTs = new Set(finals.flatMap((f) => [f.teamSeasonAId, f.teamSeasonBId]).filter((x): x is string => !!x));

  const playoffSeasons = new Map<string, Set<string>>();
  for (const s of playoffSets) for (const pid of [s.playerAId, s.playerBId]) {
    if (!s.seasonId) continue;
    (playoffSeasons.get(pid) ?? playoffSeasons.set(pid, new Set()).get(pid)!).add(s.seasonId);
  }

  type Agg = { seeds: number[]; tsIds: Set<string>; seasonNums: Set<number>; captain: boolean };
  const byPlayer = new Map<string, Agg>();
  for (const e of entries) {
    const tsId = rosterTs.get(e.rosterId);
    if (!tsId) continue;
    const a = byPlayer.get(e.playerId) ?? { seeds: [], tsIds: new Set<string>(), seasonNums: new Set<number>(), captain: false };
    a.seeds.push(e.seed);
    a.tsIds.add(tsId);
    const sid = tsSeason.get(tsId);
    const n = sid ? seasonNum.get(sid) : undefined;
    if (n != null) a.seasonNums.add(n);
    if (e.isCaptain || captainOf.get(tsId) === e.playerId) a.captain = true;
    byPlayer.set(e.playerId, a);
  }

  let made = 0;
  for (const [playerId, a] of byPlayer) {
    const data = {
      avgSeed: a.seeds.length ? a.seeds.reduce((x, y) => x + y, 0) / a.seeds.length : null,
      rookieSeason: a.seasonNums.size ? Math.min(...a.seasonNums) : null,
      championships: [...a.tsIds].filter((t) => champTs.has(t)).length,
      finalsMade: [...a.tsIds].filter((t) => finalistTs.has(t)).length,
      playoffsMade: playoffSeasons.get(playerId)?.size ?? 0,
      everCaptain: a.captain,
    };
    await prisma.playerCareerStat.upsert({ where: { playerId }, create: { playerId, ...data }, update: data });
    made++;
  }
  return { players: made };
}

// THE all-xlsx import: build every season fully from its workbook — shells, then
// conferences/seeds, rosters/draft/seeds/captains, player results (regular + playoff),
// and the playoff bracket + champion. Replaces importHistorical + importConferenceSeason
// (HTML). On a fresh DB the "fill if empty" guards in the roster/result importers fill
// everything.
export async function importAllFromXlsx(dir = sheetsDir()) {
  const shells = await importSeasonShellsFromXlsx(dir);
  const conferences = await applyConferenceData(dir);
  const rosters = await importConferenceRosters(dir);
  const results = await importConferenceResults(dir);
  const playoffs = await importPlayoffsFromXlsx(dir);
  const roster_moves = await backfillDraftedMoves();
  await pruneOrphanPlayers();
  const career = await deriveCareerStats();
  const [players, tourSets] = await Promise.all([prisma.player.count(), prisma.tourSet.count()]);
  return { ...shells, conferencesSet: conferences.teamsSet, rosters: rosters.rostersFilled, players: rosters.playersAdded, sets: results.sets, playoffSeries: playoffs.series, champions: playoffs.champions, careerStats: career.players, rosterMoves: roster_moves.created, totalPlayers: players, totalSets: tourSets };
}

export async function importHistorical(dir = sheetsDir()) {
  await importRosters(dir);
  const sets = await importResults(dir);
  const playoffSeries = await importPlayoffs(dir);
  const draftStats = await importDrafts(dir); // after rosters: links picks to teams
  const awardStats = await importAwards(dir);
  const careerStats = await importPlayerStats(dir);
  await applyConferenceData(dir); // TT1/TT2/TT4 → conferences + real seeds, from their xlsx
  // Seed the weekly roster-move log from the imported drafts (idempotent) so the
  // roster timeline + per-week lineup derivation work for historical seasons.
  const rosterMoves = await backfillDraftedMoves();
  await pruneOrphanPlayers(); // drop team-vs-team phantoms (e.g. TT3) + footprint-less orphans
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

/** Import the conference season — Team Tour 4 (Pluto/Eris). Tours 1, 2 and 4 used
 * conferences; only Tour 3 was Swiss. Conferences ← Standings, team matchups ←
 * Work block 1. Team-level only. */
export async function importConferenceSeason(dir = sheetsDir()) {
  const confs = parseStandingsConferences(join(dir, "Standings.html")) as Record<string, string[]>;
  const matchups = parseWorkMatchups(join(dir, "Work.html")) as WorkMatchup[];
  const NAME = "Team Tour 4";
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

// Import the PLAYER rosters for conference seasons (e.g. TT4) from the season xlsx
// Draft Results tab — the alltime HTML export only covers TT1-3, so without this the
// conference season has teams but no players ("TT4 isn't done" / missing players).
// Creates each team's FULL roster (captain + players + subs) and sets the real captain.
// Only fills seasons that have NO rosters yet, so it never double-imports TT1-3.
export async function importConferenceRosters(dir = sheetsDir()) {
  const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]/g, "");
  const configs = await seasonXlsxConfigs(dir);
  let rostersFilled = 0, playersAdded = 0;
  const missed: string[] = [];

  for (const [numStr, cfg] of Object.entries(configs)) {
    const num = Number(numStr);
    const draftTeams = cfg.draftTeams ?? [];
    if (!draftTeams.length) continue;
    const season = await prisma.tourSeason.findUnique({
      where: { name: `Team Tour ${num}` },
      include: { teamSeasons: { include: { team: true } } },
    });
    if (!season) continue;
    const existing = await prisma.roster.count({ where: { teamSeasonId: { in: season.teamSeasons.map((t) => t.id) } } });
    if (existing > 0) continue; // already has player data (TT1-3 from HTML) — leave it

    const tsByName = new Map(season.teamSeasons.map((t) => [norm(t.team.name), t]));
    const matchTeam = (name: string) => {
      const n = norm(name);
      return (
        tsByName.get(n) ??
        season.teamSeasons.find((t) => { const tn = norm(t.team.name); return tn.startsWith(n) || n.startsWith(tn); })
      );
    };

    // A Draft + DraftPick per season (draft order = Player 1..N per team) so the draft
    // pages + the drafted roster-move backfill work without the HTML drafts import.
    const draft = await prisma.draft.upsert({
      where: { seasonId: season.id },
      create: { seasonId: season.id, state: "DONE", orderJson: JSON.stringify(season.teamSeasons.map((t) => t.id)) },
      update: { state: "DONE" },
      select: { id: true },
    });
    await prisma.draftPick.deleteMany({ where: { draftId: draft.id } });
    let pickIndex = 0;

    for (const dt of draftTeams) {
      const ts = matchTeam(dt.team);
      if (!ts) { missed.push(`TT${num}: ${dt.team}`); continue; }
      const roster = await prisma.roster.upsert({
        where: { teamSeasonId_weekBlock: { teamSeasonId: ts.id, weekBlock: "FULL" } },
        create: { teamSeasonId: ts.id, weekBlock: "FULL" },
        update: {},
      });
      const ordered = [
        ...(dt.captain ? [{ name: dt.captain, isCaptain: true }] : []),
        ...dt.players.map((name: string) => ({ name, isCaptain: false })),
        ...dt.subs.map((name: string) => ({ name, isCaptain: false })),
      ];
      let seed = 1;
      let captainId: string | null = null;
      const seen = new Set<string>();
      for (const m of ordered) {
        const pid = (await resolvePlayerId(m.name, true))!;
        if (seen.has(pid)) continue;
        seen.add(pid);
        if (m.isCaptain && !captainId) captainId = pid;
        await prisma.rosterEntry.upsert({
          where: { rosterId_playerId: { rosterId: roster.id, playerId: pid } },
          create: { rosterId: roster.id, playerId: pid, seed, isCaptain: m.isCaptain },
          update: { seed, isCaptain: m.isCaptain },
        });
        seed++;
        playersAdded++;
      }
      if (captainId) await prisma.teamSeason.update({ where: { id: ts.id }, data: { captainPlayerId: captainId } });
      // Draft picks = the drafted players in order (captain/subs aren't picks).
      for (let r = 0; r < dt.players.length; r++) {
        const pid = (await resolvePlayerId(dt.players[r], true))!;
        await prisma.draftPick.create({ data: { draftId: draft.id, round: r + 1, pickIndex: pickIndex++, teamSeasonId: ts.id, playerId: pid, pickedAt: new Date() } });
      }
      rostersFilled++;
    }
  }
  return { rostersFilled, playersAdded, missed };
}
