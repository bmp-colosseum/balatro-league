// Import service — the historical-data ingestion logic, centralized so it's
// callable from the admin API/UI (or anywhere), not trapped in a script. The pure
// sheet PARSERS live in lib/import/*; this is the DB orchestration.
//
// Reads the Google-Sheets exports from a directory (TOUR_SHEETS_DIR, default
// D:/STuffinside). Idempotent (upserts + keyed re-imports).
import { join } from "node:path";
import { readdirSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { prisma } from "../db";
// Pure parsers (framework-agnostic utilities).
import { readSeasonXlsx, readSeasonResults, readSeasonPlayoffs, readSeasonRankings } from "../import/parse-xlsx-season.mjs";
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
// Name→id cache: resolvePlayerId is called thousands of times across rosters/rankings/
// results, each doing 2-3 queries. A name resolves to the same id for a whole import run,
// so memoize it. Cleared at the start of importAllFromXlsx so a merge between runs is seen.
const _resolveCache = new Map<string, string>();
function clearResolveCache() { _resolveCache.clear(); }
async function resolvePlayerId(name: string, create: boolean): Promise<string | null> {
  const cached = _resolveCache.get(name);
  if (cached) return cached;
  const legacy = `legacy:${slug(name)}`;
  const direct = await prisma.player.findUnique({ where: { discordId: legacy }, select: { id: true } });
  if (direct) { _resolveCache.set(name, direct.id); return direct.id; }
  const aliased = await prisma.player.findFirst({ where: { aliases: { has: legacy } }, select: { id: true } });
  if (aliased) { _resolveCache.set(name, aliased.id); return aliased.id; }
  if (!create) return null;
  const made = await prisma.player.create({ data: { discordId: legacy, displayName: name, aliases: [legacy] }, select: { id: true } });
  _resolveCache.set(name, made.id);
  return made.id;
}


export function sheetsDir(override?: string): string {
  return override || process.env.TOUR_SHEETS_DIR || "D:/STuffinside";
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

  // 2. Delete legacy players with zero footprint. Compute footprints in BULK (6 queries
  // total) instead of 6 counts per player — the per-player loop was thousands of serial
  // round-trips. A legacy player NOT in any footprint set is an orphan.
  const legacyIds = players.filter((p) => p.discordId.startsWith("legacy:")).map((p) => p.id);
  const footprint = new Set<string>();
  if (legacyIds.length) {
    const idSet = { in: legacyIds };
    const [setRows, picks, rosters, career, awards, awardSlots, captains] = await Promise.all([
      prisma.tourSet.findMany({ where: { OR: [{ playerAId: idSet }, { playerBId: idSet }] }, select: { playerAId: true, playerBId: true } }),
      prisma.draftPick.findMany({ where: { playerId: idSet }, select: { playerId: true } }),
      prisma.rosterEntry.findMany({ where: { playerId: idSet }, select: { playerId: true } }),
      prisma.playerCareerStat.findMany({ where: { playerId: idSet }, select: { playerId: true } }),
      prisma.award.findMany({ where: { playerId: idSet }, select: { playerId: true } }),
      prisma.awardRecipient.findMany({ where: { playerId: idSet }, select: { playerId: true } }),
      prisma.teamSeason.findMany({ where: { captainPlayerId: idSet }, select: { captainPlayerId: true } }),
    ]);
    for (const s of setRows) { footprint.add(s.playerAId); footprint.add(s.playerBId); }
    for (const x of picks) if (x.playerId) footprint.add(x.playerId);
    for (const x of rosters) footprint.add(x.playerId);
    for (const x of career) footprint.add(x.playerId);
    for (const x of awards) if (x.playerId) footprint.add(x.playerId);
    for (const x of awardSlots) if (x.playerId) footprint.add(x.playerId);
    for (const x of captains) footprint.add(x.captainPlayerId);
  }
  const nameById = new Map(players.map((p) => [p.id, p.displayName]));
  const orphanIds = legacyIds.filter((id) => !footprint.has(id));
  if (orphanIds.length) await prisma.player.deleteMany({ where: { id: { in: orphanIds } } });
  const removed = orphanIds.map((id) => nameById.get(id) ?? id);
  return { removed: removed.length, names: removed, setsDeleted };
}

// Drop teams left behind by older/broken imports. The import only UPSERTS teams by name,
// so a team that's no longer in the sheet (e.g. a mis-parsed name) lingers forever. A
// team-season with no roster, no sets, no playoff series and no draft picks isn't real —
// delete it (cascades its rosters), then delete any Team with no team-seasons left.
export async function pruneOrphanTeams(): Promise<{ teamSeasonsRemoved: number; teamsRemoved: number; names: string[] }> {
  const names: string[] = [];
  const tss = await prisma.teamSeason.findMany({ select: { id: true, teamId: true, team: { select: { name: true } } } });
  // Bulk footprint: a team-season id appearing in any of these has real data.
  const [rosters, sets, series, picks] = await Promise.all([
    prisma.roster.findMany({ where: { entries: { some: {} } }, select: { teamSeasonId: true } }),
    prisma.tourSet.findMany({ select: { teamSeasonAId: true, teamSeasonBId: true } }),
    prisma.playoffSeries.findMany({ select: { teamSeasonAId: true, teamSeasonBId: true } }),
    prisma.draftPick.findMany({ select: { teamSeasonId: true } }),
  ]);
  const live = new Set<string>();
  for (const r of rosters) live.add(r.teamSeasonId);
  for (const s of sets) { if (s.teamSeasonAId) live.add(s.teamSeasonAId); if (s.teamSeasonBId) live.add(s.teamSeasonBId); }
  for (const s of series) { if (s.teamSeasonAId) live.add(s.teamSeasonAId); if (s.teamSeasonBId) live.add(s.teamSeasonBId); }
  for (const p of picks) live.add(p.teamSeasonId);

  const orphanTs = tss.filter((ts) => !live.has(ts.id));
  if (orphanTs.length) await prisma.teamSeason.deleteMany({ where: { id: { in: orphanTs.map((t) => t.id) } } }); // cascades rosters
  for (const ts of orphanTs) names.push(ts.team.name);

  // Teams with no team-seasons left.
  const teams = await prisma.team.findMany({ select: { id: true, name: true, _count: { select: { teamSeasons: true } } } });
  const orphanTeams = teams.filter((t) => t._count.teamSeasons === 0);
  if (orphanTeams.length) await prisma.team.deleteMany({ where: { id: { in: orphanTeams.map((t) => t.id) } } });
  for (const t of orphanTeams) if (!names.includes(t.name)) names.push(t.name);

  return { teamSeasonsRemoved: orphanTs.length, teamsRemoved: orphanTeams.length, names };
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
    // (rebuild — the prior xlsx sets for this season are cleared below before re-creating)
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
    // Clean rebuild: clear ALL of this season's sets + their matches (covers old
    // gamelog-keyed sets from a prior HTML import, not just xlsx-keyed ones).
    const prior = await prisma.tourSet.findMany({ where: { seasonId: season.id }, select: { matchId: true } });
    await prisma.tourSet.deleteMany({ where: { seasonId: season.id } });
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
    // Subs/results are built in memory then written in 3 bulk createMany calls (instead of
    // ~5k sequential creates) — the per-row round-trips dominated wall-clock on a remote DB.
    let subsAdded = 0;
    const newMembers: { rosterId: string; playerId: string; seed: number; isCaptain: boolean }[] = [];
    const ensureMember = (tsId: string | null, playerId: string) => {
      if (!tsId) return;
      const members = membersByTs.get(tsId)!;
      if (members.has(playerId)) return;
      const seed = (maxSeedByTs.get(tsId) ?? 0) + 1;
      maxSeedByTs.set(tsId, seed);
      members.add(playerId);
      seedByPlayer.set(playerId, seedByPlayer.get(playerId) ?? seed);
      newMembers.push({ rosterId: rosterByTs.get(tsId)!, playerId, seed, isCaptain: false });
      subsAdded++;
    };

    // A cross-conference game is listed in BOTH conferences' tabs, so the same player
    // pair shows up twice in a week. A pair plays once per regular week — dedupe on
    // (week, unordered pair). Playoffs (no week) are left alone: a pair can recur across
    // rounds there.
    const seenPair = new Set<string>();
    const matchRows: { id: string; playerAId: string; playerBId: string; format: "HISTORICAL"; gamesWonA: number; gamesWonB: number; winnerId: string | null; status: "CONFIRMED" }[] = [];
    const setRows: {
      importKey: string; seasonId: string; week: number | null; teamSeasonAId: string | null; teamSeasonBId: string | null;
      bracket: string; matchId: string; playerAId: string; playerBId: string; seedA: number; seedB: number; bestOf: number; status: "CONFIRMED";
    }[] = [];
    let i = 0;
    for (const r of results) {
      const aId = idByName.get(r.p1)!;
      const bId = idByName.get(r.p2)!;
      if (aId === bId) { i++; continue; }
      if (r.week != null) {
        const [lo, hi] = aId < bId ? [aId, bId] : [bId, aId];
        const pairKey = `${r.week}|${lo}|${hi}`;
        if (seenPair.has(pairKey)) { i++; continue; }
        seenPair.add(pairKey);
      }
      const tsA = matchTs(r.teamA);
      const tsB = matchTs(r.teamB);
      ensureMember(tsA, aId);
      ensureMember(tsB, bId);
      const [mA, mB] = aId < bId ? [aId, bId] : [bId, aId];
      const gwA = mA === aId ? r.p1g : r.p2g;
      const gwB = mA === aId ? r.p2g : r.p1g;
      const winnerId = gwA > gwB ? mA : gwB > gwA ? mB : null;
      const bestOf = Math.max(1, 2 * Math.max(r.p1g, r.p2g) - 1);
      const matchId = randomUUID();
      matchRows.push({ id: matchId, playerAId: mA, playerBId: mB, format: "HISTORICAL", gamesWonA: gwA, gamesWonB: gwB, winnerId, status: "CONFIRMED" });
      setRows.push({
        importKey: `xlsxresult:s${num}:${i++}`,
        seasonId: season.id,
        week: r.week ?? null,
        teamSeasonAId: tsA,
        teamSeasonBId: tsB,
        bracket: r.bracket === "PLAYOFF" ? "PLAYOFF" : "REGULAR",
        matchId,
        playerAId: aId,
        playerBId: bId,
        seedA: seedByPlayer.get(aId) ?? 0,
        seedB: seedByPlayer.get(bId) ?? 0,
        bestOf,
        status: "CONFIRMED",
      });
      made++;
    }
    if (newMembers.length) await prisma.rosterEntry.createMany({ data: newMembers });
    if (matchRows.length) await prisma.match.createMany({ data: matchRows });
    if (setRows.length) await prisma.tourSet.createMany({ data: setRows });
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
    // Clean rebuild: drop the season's old team-level schedule (Week/Matchup from a prior
    // HTML conference import) — the all-xlsx import is player-set based, not Matchup based.
    await prisma.matchup.deleteMany({ where: { week: { seasonId: season.id } } });
    await prisma.week.deleteMany({ where: { seasonId: season.id } });
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

    // Store the ENTIRE bracket (every team series), not just the champion's path. Round =
    // the parsed label; an unlabeled series is the final. getChampionRun still derives the
    // champion's run from these; getPublicBracket renders the whole thing.
    await prisma.playoffSeries.deleteMany({ where: { seasonId: season.id } });
    const withRound = series
      .map((s) => ({ ...s, round: (s.round ?? "FINAL") as string }))
      .sort((a, b) => (roundRank[a.round] ?? 9) - (roundRank[b.round] ?? 9));
    const idxByRound: Record<string, number> = {};
    const rows = withRound.map((s) => {
      const tsA = matchTs(s.teamA), tsB = matchTs(s.teamB);
      const aWon = s.scoreA >= s.scoreB;
      idxByRound[s.round] = idxByRound[s.round] ?? 0;
      return {
        seasonId: season.id,
        round: s.round as never,
        bracketIndex: idxByRound[s.round]++,
        teamSeasonAId: tsA,
        teamSeasonBId: tsB,
        scoreA: s.scoreA,
        scoreB: s.scoreB,
        winnerTeamSeasonId: aWon ? tsA : tsB,
      };
    });
    if (rows.length) await prisma.playoffSeries.createMany({ data: rows });
    created += rows.length;
    if (champion) champions++;
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

// Find every TT<n>.xlsx under `dir` (walked) + optional TOUR_XLSX_DIR. Map num -> path.
function seasonXlsxPaths(dir: string): Map<number, string> {
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
  return mains;
}

// DRY-RUN: parse the xlsx and report what an import WOULD produce per season, writing
// nothing. Lets an admin preview before the (destructive on a populated DB) re-import.
export async function previewImport(dir = sheetsDir()) {
  const nrm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]/g, "");
  const out: { season: number; format: string; teams: number; players: number; regularSets: number; playoffSets: number; weeks: number; champion: string | null }[] = [];
  for (const [num, path] of seasonXlsxPaths(dir)) {
    const cfg = await readSeasonXlsx(path);
    const draftTeams = cfg.draftTeams ?? [];
    if (!draftTeams.length) continue;
    const teamN = new Set(draftTeams.map((t) => nrm(t.team)));
    const notTeams = (a: string, b: string) => !(teamN.has(nrm(a)) && teamN.has(nrm(b)));
    const results = (await readSeasonResults(path)) as { p1: string; p2: string; bracket: string; week?: number }[];
    const reg = results.filter((r) => r.bracket === "REGULAR" && notTeams(r.p1, r.p2));
    const regularSets = reg.length;
    const weeks = new Set(reg.map((r) => r.week).filter((w) => w != null)).size;
    const playoffSets = results.filter((r) => r.bracket === "PLAYOFF" && notTeams(r.p1, r.p2)).length;
    const bracket = ((await readSeasonPlayoffs(path)) as { teamA: string; scoreA: number; scoreB: number; teamB: string }[])
      .filter((s) => teamN.has(nrm(s.teamA)) && teamN.has(nrm(s.teamB)));
    const winners = new Set<string>(), losers = new Set<string>();
    for (const s of bracket) { const aw = s.scoreA >= s.scoreB; winners.add(nrm(aw ? s.teamA : s.teamB)); losers.add(nrm(aw ? s.teamB : s.teamA)); }
    const champKey = [...winners].find((w) => !losers.has(w));
    const players = new Set<string>();
    for (const t of draftTeams) for (const n of [t.captain, ...t.players, ...t.subs]) if (n) players.add(nrm(n));
    out.push({
      season: num,
      format: Object.keys(cfg.conferences ?? {}).length ? "CONFERENCES" : "SWISS",
      teams: draftTeams.length,
      players: players.size,
      regularSets,
      playoffSets,
      weeks,
      champion: champKey ? draftTeams.find((t) => nrm(t.team) === champKey)?.team ?? null : null,
    });
  }
  return { seasons: out.sort((a, b) => a.season - b.season) };
}

// THE all-xlsx import: build every season fully from its workbook — shells, then
// conferences/seeds, rosters/draft/seeds/captains, player results (regular + playoff),
// and the playoff bracket + champion. Replaces importHistorical + importConferenceSeason
// (HTML). On a fresh DB the "fill if empty" guards in the roster/result importers fill
// everything.
export async function importAllFromXlsx(dir = sheetsDir()) {
  clearResolveCache();
  const shells = await importSeasonShellsFromXlsx(dir);
  const conferences = await applyConferenceData(dir);
  const rosters = await importConferenceRosters(dir);
  const rankings = await applySeedRankings(dir);
  const results = await importConferenceResults(dir);
  const playoffs = await importPlayoffsFromXlsx(dir);
  const roster_moves = await backfillDraftedMoves();
  await pruneOrphanPlayers();
  const prunedTeams = await pruneOrphanTeams();
  const career = await deriveCareerStats();
  const [players, tourSets] = await Promise.all([prisma.player.count(), prisma.tourSet.count()]);
  return { ...shells, conferencesSet: conferences.teamsSet, rosters: rosters.rostersFilled, players: rosters.playersAdded, sets: results.sets, playoffSeries: playoffs.series, champions: playoffs.champions, careerStats: career.players, rosterMoves: roster_moves.created, seedRankings: rankings, prunedTeams, totalPlayers: players, totalSets: tourSets };
}

// Apply the "Team Rankings" bands (TT1/TT2/TT4) as the canonical seeds: the first
// week-block sets each player's base seed (captain at their real position, NOT forced to
// 1), and each later block becomes RESEED moves at its start week (the playoff block at
// the week after the regular season). Idempotent: clears its own prior ranking RESEEDs
// (tagged createdBy="import:rankings") but never touches manual re-seeds. Seasons without
// a Team Rankings section (TT3) are skipped, keeping their roster-order seeds.
export async function applySeedRankings(dir = sheetsDir()) {
  const nrm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]/g, "");
  let baseSet = 0, reseeds = 0, seasonsApplied = 0, adds = 0, drops = 0;
  for (const [num, path] of seasonXlsxPaths(dir)) {
    const blocks = await readSeasonRankings(path);
    if (!blocks.length) continue;
    const season = await prisma.tourSeason.findUnique({ where: { name: `Team Tour ${num}` }, include: { teamSeasons: { include: { team: true } } } });
    if (!season) continue;
    const tsByName = new Map(season.teamSeasons.map((t) => [nrm(t.team.name), t.id]));
    const matchTs = (name: string) => {
      const n = nrm(name);
      return tsByName.get(n) ?? season.teamSeasons.find((t) => { const tn = nrm(t.team.name); return tn.startsWith(n) || n.startsWith(tn); })?.id ?? null;
    };
    // Idempotent: drop ALL prior ranking-derived moves (RESEED + ADDED/QUIT), keep manual.
    await prisma.rosterMove.deleteMany({ where: { seasonId: season.id, createdBy: "import:rankings" } });

    // Preload each team's roster + members once (avoids a findFirst per player).
    const tsIds = season.teamSeasons.map((t) => t.id);
    const rosters = await prisma.roster.findMany({ where: { teamSeasonId: { in: tsIds } }, select: { id: true, teamSeasonId: true, weekBlock: true, entries: { select: { playerId: true } } } });
    const rosterByTs = new Map<string, string>();
    const membersByTs = new Map<string, Set<string>>();
    for (const r of rosters) {
      if (!membersByTs.has(r.teamSeasonId)) membersByTs.set(r.teamSeasonId, new Set());
      for (const e of r.entries) membersByTs.get(r.teamSeasonId)!.add(e.playerId);
      if (r.weekBlock === "FULL" || !rosterByTs.has(r.teamSeasonId)) rosterByTs.set(r.teamSeasonId, r.id);
    }

    const ordered = [...blocks].sort((a, b) => (a.weeks[0] ?? 99) - (b.weeks[0] ?? 99));
    const lastRegEnd = Math.max(0, ...ordered.flatMap((b: { weeks: number[] }) => b.weeks));
    const prevSeed = new Map<string, number>(); // `${tsId}|${pid}` -> last seed
    const prevTeamPlayers = new Map<string, Set<string>>(); // tsId -> players in the previous block (for add/drop diffs)

    // Collect all writes, then flush in batched ops instead of thousands of round-trips.
    const newEntries: { rosterId: string; playerId: string; seed: number; isCaptain: boolean }[] = [];
    const baseUpdates: { tsId: string; playerId: string; seed: number }[] = [];
    const reseedMoves: { seasonId: string; teamSeasonId: string; kind: "RESEED"; playerId: string; seed: number; effectiveWeek: number; reason: string; createdBy: string }[] = [];
    const addedMoves: { seasonId: string; teamSeasonId: string; kind: "ADDED"; playerId: string; seed: number; effectiveWeek: number; reason: string; createdBy: string; replacesPlayerId: string | null }[] = [];
    const quitMoves: { seasonId: string; teamSeasonId: string; kind: "QUIT"; playerId: string; effectiveWeek: number; reason: string; createdBy: string }[] = [];

    for (let bi = 0; bi < ordered.length; bi++) {
      const b = ordered[bi] as { label: string; weeks: number[]; teams: { team: string; seeds: { player: string; seed: number }[] }[] };
      const isPlayoff = b.weeks.length === 0;
      const effWeek = isPlayoff ? lastRegEnd + 1 : b.weeks[0];
      const period = isPlayoff ? "playoffs" : b.label;
      for (const t of b.teams) {
        const tsId = matchTs(t.team);
        if (!tsId) continue;
        const rosterId = rosterByTs.get(tsId);
        const members = membersByTs.get(tsId) ?? membersByTs.set(tsId, new Set()).get(tsId)!;
        const prevBlock = prevTeamPlayers.get(tsId); // this team's roster in the IMMEDIATELY previous block
        const cur = new Set<string>();
        const seedOf = new Map<string, number>();
        for (const { player, seed } of t.seeds) {
          const pid = await resolvePlayerId(player, true);
          if (!pid) continue;
          cur.add(pid);
          seedOf.set(pid, seed);
          const key = `${tsId}|${pid}`;
          const isMember = members.has(pid);
          if (!isMember && rosterId) { newEntries.push({ rosterId, playerId: pid, seed, isCaptain: false }); members.add(pid); }
          if (bi === 0) {
            if (isMember) baseUpdates.push({ tsId, playerId: pid, seed });
            prevSeed.set(key, seed);
            baseSet++;
          } else {
            // A re-seed only for a player who was on this team the PREVIOUS block and whose
            // seed moved. A player who wasn't there last block is an ADD (handled below),
            // never a re-seed — so an added player doesn't get mislabeled as re-seeded.
            const known = prevSeed.get(key);
            if (prevBlock?.has(pid) && known != null && known !== seed) {
              reseedMoves.push({ seasonId: season.id, teamSeasonId: tsId, kind: "RESEED", playerId: pid, seed, effectiveWeek: effWeek, reason: `ranking ${b.label}`, createdBy: "import:rankings" });
              reseeds++;
            }
            prevSeed.set(key, seed);
          }
        }
        // Add/drop vs this team's previous block. Pair an incoming player with an outgoing
        // one (by seed slot) so it reads as a substitution — "X joined, replacing Y" —
        // instead of two disconnected events. Extra adds/drops (unpaired) stand alone.
        const prev = prevTeamPlayers.get(tsId);
        if (bi > 0 && prev) {
          const added = [...cur].filter((pid) => !prev.has(pid)).map((pid) => ({ pid, seed: seedOf.get(pid) ?? 99 })).sort((a, b) => a.seed - b.seed);
          const dropped = [...prev].filter((pid) => !cur.has(pid)).map((pid) => ({ pid, seed: prevSeed.get(`${tsId}|${pid}`) ?? 99 })).sort((a, b) => a.seed - b.seed);
          for (let k = 0; k < added.length; k++) {
            const replaced = k < dropped.length ? dropped[k].pid : null;
            addedMoves.push({ seasonId: season.id, teamSeasonId: tsId, kind: "ADDED", playerId: added[k].pid, seed: added[k].seed, effectiveWeek: effWeek, reason: `roster change (${period})`, createdBy: "import:rankings", replacesPlayerId: replaced });
          }
          // Drops with no incoming replacement = a straight departure.
          for (let k = added.length; k < dropped.length; k++) {
            quitMoves.push({ seasonId: season.id, teamSeasonId: tsId, kind: "QUIT", playerId: dropped[k].pid, effectiveWeek: effWeek, reason: `roster change (${period})`, createdBy: "import:rankings" });
          }
        }
        prevTeamPlayers.set(tsId, cur);
      }
    }
    if (newEntries.length) await prisma.rosterEntry.createMany({ data: newEntries, skipDuplicates: true });
    if (baseUpdates.length) await prisma.$transaction(baseUpdates.map((u) => prisma.rosterEntry.updateMany({ where: { playerId: u.playerId, roster: { teamSeasonId: u.tsId } }, data: { seed: u.seed } })));
    if (reseedMoves.length) await prisma.rosterMove.createMany({ data: reseedMoves });
    if (addedMoves.length) await prisma.rosterMove.createMany({ data: addedMoves });
    if (quitMoves.length) await prisma.rosterMove.createMany({ data: quitMoves });
    adds += addedMoves.length;
    drops += quitMoves.length;
    seasonsApplied++;
  }
  return { seasonsApplied, baseSet, reseeds, adds, drops };
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
    // Clean rebuild: clear the season's existing roster entries (drafted + subs) so a
    // re-import reflects the current xlsx rather than skipping or stacking. The Roster
    // rows themselves are reused via upsert below; players persist (identity-aware).
    const rosterIds = (await prisma.roster.findMany({ where: { teamSeasonId: { in: season.teamSeasons.map((t) => t.id) } }, select: { id: true } })).map((r) => r.id);
    if (rosterIds.length) await prisma.rosterEntry.deleteMany({ where: { rosterId: { in: rosterIds } } });

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

    const matched = draftTeams.map((dt) => ({ dt, ts: matchTeam(dt.team) }));
    for (const m of matched) if (!m.ts) missed.push(`TT${num}: ${m.dt.team}`);
    const ok = matched.filter((m): m is { dt: typeof m.dt; ts: NonNullable<typeof m.ts> } => !!m.ts);

    // Ensure a FULL roster per team (reuse existing, bulk-create the missing).
    const existing = await prisma.roster.findMany({ where: { teamSeasonId: { in: ok.map((m) => m.ts.id) }, weekBlock: "FULL" }, select: { id: true, teamSeasonId: true } });
    const rosterByTs = new Map(existing.map((r) => [r.teamSeasonId, r.id]));
    const toCreate = ok.filter((m) => !rosterByTs.has(m.ts.id)).map((m) => ({ teamSeasonId: m.ts.id, weekBlock: "FULL" }));
    if (toCreate.length) {
      const made = await prisma.roster.createManyAndReturn({ data: toCreate, select: { id: true, teamSeasonId: true } });
      for (const r of made) rosterByTs.set(r.teamSeasonId, r.id);
    }

    // Collect all rows, then write in batches (createMany + one transaction).
    const entryRows: { rosterId: string; playerId: string; seed: number; isCaptain: boolean }[] = [];
    const captainUpdates: { tsId: string; captainId: string }[] = [];
    const pickRows: { draftId: string; round: number; pickIndex: number; teamSeasonId: string; playerId: string; pickedAt: Date }[] = [];
    let pickIndex = 0;
    const now = new Date();
    for (const { dt, ts } of ok) {
      const rosterId = rosterByTs.get(ts.id)!;
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
        entryRows.push({ rosterId, playerId: pid, seed, isCaptain: m.isCaptain });
        seed++;
        playersAdded++;
      }
      if (captainId) captainUpdates.push({ tsId: ts.id, captainId });
      for (let r = 0; r < dt.players.length; r++) {
        const pid = (await resolvePlayerId(dt.players[r], true))!;
        pickRows.push({ draftId: draft.id, round: r + 1, pickIndex: pickIndex++, teamSeasonId: ts.id, playerId: pid, pickedAt: now });
      }
      rostersFilled++;
    }
    if (entryRows.length) await prisma.rosterEntry.createMany({ data: entryRows, skipDuplicates: true });
    if (captainUpdates.length) await prisma.$transaction(captainUpdates.map((u) => prisma.teamSeason.update({ where: { id: u.tsId }, data: { captainPlayerId: u.captainId } })));
    if (pickRows.length) await prisma.draftPick.createMany({ data: pickRows });
  }
  return { rostersFilled, playersAdded, missed };
}
