// Identity service — link a Tour player to a real Discord id (picked from the
// league reference) and merge duplicate players. Pure logic; the admin UI/actions
// gate. Player.id is referenced by plain id everywhere (decoupling rule), so merge
// repoints each place by hand inside one transaction.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "../db";
import { leaguePlayersLive } from "../league-db";

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]/g, "");
export interface LeagueRefRow { discordId: string; name: string }

// The base league name→Discord-id reference (display names + @usernames), best
// source first:
//   1. LIVE league DB (LEAGUE_DATABASE_URL, read-only) — always current.
//   2. LeagueRef table, league rows (populated from an uploaded league-players.csv).
//   3. local league-players.csv file (dev convenience).
async function getLeagueRef(): Promise<LeagueRefRow[]> {
  try {
    const live = await leaguePlayersLive();
    if (live && live.length > 0) return live;
  } catch {
    /* live league DB unreachable — fall back to the snapshot sources */
  }
  const rows = await prisma.leagueRef.findMany({ where: { source: "league" }, select: { discordId: true, name: true } });
  if (rows.length > 0) return rows;
  const path = join(process.cwd(), "league-players.csv");
  if (!existsSync(path)) return [];
  return parseLeagueCsv(readFileSync(path, "utf8"));
}

function parseLeagueCsv(csv: string): LeagueRefRow[] {
  const lines = csv.replace(/\r/g, "").split("\n").filter(Boolean);
  if (lines[0]?.toLowerCase().startsWith("name")) lines.shift(); // header
  return lines
    .map((line) => {
      const last = line.lastIndexOf(",");
      return { name: line.slice(0, last).trim(), discordId: line.slice(last + 1).trim() };
    })
    .filter((r) => r.discordId && /^\d+$/.test(r.discordId));
}

// Upsert one (discordId, name) into the LeagueRef table without duplicating.
async function upsertRef(discordId: string, name: string, source: string) {
  await prisma.leagueRef.upsert({
    where: { discordId_name: { discordId, name } },
    create: { discordId, name, source },
    update: { source },
  });
}

// Populate/refresh the LeagueRef table from a CSV string. Stores every name row
// (display name AND @username — multiple per person), source "league". Idempotent.
export async function loadLeagueRefFromCsv(csv: string): Promise<{ count: number }> {
  const rows = parseLeagueCsv(csv);
  for (const r of rows) await upsertRef(r.discordId, r.name, "league");
  return { count: new Set(rows.map((r) => r.discordId)).size };
}

// Resolve uploaded signups (preferred name → Discord @username) against the league
// username→discordId map, and store each resolved preferred-name as a LeagueRef row
// (source "signup"). This is what used to be the baked SIGNUP_USERNAMES table — now
// derived at import time from the season xlsx. Returns how many resolved.
export async function applySignupRefs(signups: { preferredName: string; username: string }[]): Promise<{ resolved: number; unresolved: number }> {
  const league = await getLeagueRef();
  const idByName = new Map<string, string>(); // normalized league name (display or username) → discordId
  for (const r of league) if (!idByName.has(norm(r.name))) idByName.set(norm(r.name), r.discordId);

  let resolved = 0, unresolved = 0;
  for (const s of signups) {
    const discordId = idByName.get(norm(s.username));
    if (!discordId) { unresolved++; continue; }
    await upsertRef(discordId, s.preferredName, "signup");
    resolved++;
  }
  return { resolved, unresolved };
}

export async function leagueRefCount(): Promise<number> {
  return new Set((await getLeagueRef()).map((r) => r.discordId)).size;
}

// Dedup-by-id + cap.
function dedup(rows: LeagueRefRow[], limit: number): LeagueRefRow[] {
  const seen = new Set<string>();
  const out: LeagueRefRow[] = [];
  for (const r of rows) {
    if (seen.has(r.discordId)) continue;
    seen.add(r.discordId);
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}

// Rank league rows by how well they match a name: exact → starts-with → contains.
function rankMatches(name: string, all: LeagueRefRow[], limit: number): LeagueRefRow[] {
  const t = norm(name);
  if (!t) return [];
  const exact: LeagueRefRow[] = [], starts: LeagueRefRow[] = [], incl: LeagueRefRow[] = [];
  for (const r of all) {
    const n = norm(r.name);
    if (n === t) exact.push(r);
    else if (n.startsWith(t) || t.startsWith(n)) starts.push(r);
    else if (n.includes(t) || t.includes(n)) incl.push(r);
  }
  return dedup([...exact, ...starts, ...incl], limit);
}

// The reference used for suggestions/search: the live league rows PLUS every stored
// LeagueRef row (league display-names/usernames + signup-resolved preferred names).
// Multiple name rows per person are fine — rankMatches dedups the winners by id.
async function getSuggestRef(): Promise<LeagueRefRow[]> {
  const out: LeagueRefRow[] = [];
  try {
    const live = await leaguePlayersLive();
    if (live?.length) out.push(...live);
  } catch {
    /* live league DB unreachable — table rows below still cover it */
  }
  const table = await prisma.leagueRef.findMany({ select: { discordId: true, name: true } });
  out.push(...table);
  if (out.length) return out;
  const path = join(process.cwd(), "league-players.csv");
  if (existsSync(path)) return parseLeagueCsv(readFileSync(path, "utf8"));
  return [];
}

// The link picker (free-text search of the league list + signup-resolved names).
export async function searchLeagueRef(q: string, limit = 25): Promise<LeagueRefRow[]> {
  const all = await getSuggestRef();
  const needle = norm(q);
  return dedup(needle ? all.filter((r) => norm(r.name).includes(needle)) : all, limit);
}

export async function identityCounts() {
  const [total, linked] = await Promise.all([
    prisma.player.count(),
    prisma.player.count({ where: { NOT: { discordId: { startsWith: "legacy:" } } } }),
  ]);
  return { total, linked, unlinked: total - linked };
}

export interface TourPlayerRow {
  id: string;
  name: string;
  discordId: string;
  linked: boolean;
  sets: number;
  seasons: number;
  suggestions?: LeagueRefRow[]; // likely league matches (unlinked players only)
}

export type IdentityFilter = "all" | "unlinked" | "linked";

export async function listTourPlayers(q = "", limit = 60, filter: IdentityFilter = "all"): Promise<TourPlayerRow[]> {
  const [players, sets] = await Promise.all([
    prisma.player.findMany({ select: { id: true, displayName: true, discordId: true } }),
    prisma.tourSet.findMany({ select: { playerAId: true, playerBId: true, seasonId: true } }),
  ]);
  const setCount = new Map<string, number>();
  const seasons = new Map<string, Set<string>>();
  for (const ts of sets) {
    for (const pid of [ts.playerAId, ts.playerBId]) {
      setCount.set(pid, (setCount.get(pid) ?? 0) + 1);
      if (ts.seasonId) {
        const s = seasons.get(pid) ?? new Set<string>();
        s.add(ts.seasonId);
        seasons.set(pid, s);
      }
    }
  }
  const needle = norm(q);
  let rows: TourPlayerRow[] = players.map((p) => ({
    id: p.id,
    name: p.displayName,
    discordId: p.discordId,
    linked: !p.discordId.startsWith("legacy:"),
    sets: setCount.get(p.id) ?? 0,
    seasons: seasons.get(p.id)?.size ?? 0,
  }));
  if (needle) rows = rows.filter((r) => norm(r.name).includes(needle));
  if (filter === "unlinked") rows = rows.filter((r) => !r.linked);
  else if (filter === "linked") rows = rows.filter((r) => r.linked);
  rows.sort((a, b) => b.sets - a.sets || a.name.localeCompare(b.name));
  const out = rows.slice(0, limit);

  // Auto-suggest a match for each UNLINKED player (one-click linking) from the
  // league list + signup-resolved Discord ids.
  const ref = await getSuggestRef();
  if (ref.length) {
    for (const r of out) if (!r.linked) r.suggestions = rankMatches(r.name, ref, 2);
  }
  return out;
}

// Set a Tour player's discordId to a real one. If that id already belongs to a
// DIFFERENT player, that's a duplicate → caller should merge instead. Records the
// OLD id (typically `legacy:<slug>`) as an alias so a future historical re-import
// re-attaches to THIS player instead of spawning a duplicate.
export async function linkPlayer(playerId: string, discordId: string) {
  const id = discordId.trim();
  if (!id) throw new Error("A Discord id is required.");
  const conflict = await prisma.player.findUnique({ where: { discordId: id }, select: { id: true, displayName: true } });
  if (conflict && conflict.id !== playerId) {
    throw new Error(`That Discord id already belongs to "${conflict.displayName}" — merge the two players instead.`);
  }
  const current = await prisma.player.findUnique({ where: { id: playerId }, select: { discordId: true, aliases: true } });
  if (!current) throw new Error("Player not found.");
  const aliases = new Set(current.aliases);
  if (current.discordId.startsWith("legacy:")) aliases.add(current.discordId); // remember the import key
  return prisma.player.update({ where: { id: playerId }, data: { discordId: id, aliases: [...aliases] } });
}

// --- Recovery from an identity-blind re-import ---------------------------------
// A re-import done before the importer was identity-aware created duplicate
// `legacy:<slug>` players and attached the rebuilt data to them, orphaning the
// already-linked originals. This finds each such duplicate and the linked player it
// belongs to (by remembered alias, else by exact display-name match), so they can be
// folded back together. Name-only matches are flagged so they can be reviewed.

export interface RecoveryPair {
  keepId: string; keepName: string; keepDiscordId: string; keepSets: number;
  dropId: string; dropName: string; dropSets: number;
  via: "alias" | "name";
}
export interface RecoveryPlan {
  merges: RecoveryPair[];
  ambiguous: { name: string; dropId: string; candidates: { id: string; name: string }[] }[];
}

async function setCounts(): Promise<Map<string, number>> {
  const sets = await prisma.tourSet.findMany({ select: { playerAId: true, playerBId: true } });
  const m = new Map<string, number>();
  for (const s of sets) for (const pid of [s.playerAId, s.playerBId]) m.set(pid, (m.get(pid) ?? 0) + 1);
  return m;
}

export async function planIdentityRecovery(): Promise<RecoveryPlan> {
  const players = await prisma.player.findMany({ select: { id: true, displayName: true, discordId: true, aliases: true } });
  const counts = await setCounts();
  const linked = players.filter((p) => !p.discordId.startsWith("legacy:"));
  // Index linked players by remembered alias and by normalized display name.
  const byAlias = new Map<string, typeof linked>();
  const byName = new Map<string, typeof linked>();
  for (const k of linked) {
    for (const a of k.aliases) (byAlias.get(a) ?? byAlias.set(a, []).get(a)!).push(k);
    const n = norm(k.displayName);
    (byName.get(n) ?? byName.set(n, []).get(n)!).push(k);
  }

  const merges: RecoveryPair[] = [];
  const ambiguous: RecoveryPlan["ambiguous"] = [];
  for (const d of players) {
    if (!d.discordId.startsWith("legacy:")) continue; // only duplicates are legacy
    const aliasHit = byAlias.get(d.discordId) ?? [];
    const nameHit = byName.get(norm(d.displayName)) ?? [];
    const via: "alias" | "name" = aliasHit.length ? "alias" : "name";
    const candidates = (aliasHit.length ? aliasHit : nameHit).filter((k) => k.id !== d.id);
    if (candidates.length === 0) continue; // a genuine never-linked legacy player — leave it
    if (candidates.length > 1) {
      ambiguous.push({ name: d.displayName, dropId: d.id, candidates: candidates.map((c) => ({ id: c.id, name: c.displayName })) });
      continue;
    }
    const k = candidates[0];
    merges.push({
      keepId: k.id, keepName: k.displayName, keepDiscordId: k.discordId, keepSets: counts.get(k.id) ?? 0,
      dropId: d.id, dropName: d.displayName, dropSets: counts.get(d.id) ?? 0, via,
    });
  }
  merges.sort((a, b) => b.dropSets - a.dropSets || a.keepName.localeCompare(b.keepName));
  return { merges, ambiguous };
}

// Apply a chosen set of recovery merges (drop → keep). Re-derives the plan and only
// acts on pairs still valid, so a stale form can't merge the wrong rows.
export async function applyIdentityRecovery(pairs: { keepId: string; dropId: string }[]): Promise<{ merged: number; errors: string[] }> {
  const plan = await planIdentityRecovery();
  const valid = new Set(plan.merges.map((m) => `${m.keepId}:${m.dropId}`));
  let merged = 0;
  const errors: string[] = [];
  for (const p of pairs) {
    if (!valid.has(`${p.keepId}:${p.dropId}`)) { errors.push(`Skipped a stale/invalid pair.`); continue; }
    try {
      await mergePlayers(p.keepId, p.dropId);
      merged++;
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  return { merged, errors };
}

// Merge `dropId` INTO `keepId`: repoint EVERY player reference, fold the dropped
// player's id/aliases into keep's aliases (so re-import re-attaches to keep), then
// delete the duplicate. One transaction so a partial merge can't corrupt history.
export async function mergePlayers(keepId: string, dropId: string) {
  if (keepId === dropId) throw new Error("Pick two different players.");
  const [keep, drop] = await Promise.all([
    prisma.player.findUnique({ where: { id: keepId }, select: { id: true, displayName: true, discordId: true, aliases: true } }),
    prisma.player.findUnique({ where: { id: dropId }, select: { id: true, displayName: true, discordId: true, aliases: true } }),
  ]);
  if (!keep || !drop) throw new Error("Player not found.");

  await prisma.$transaction(async (tx) => {
    // Core Match + Game (stats derive from these).
    await tx.match.updateMany({ where: { playerAId: dropId }, data: { playerAId: keepId } });
    await tx.match.updateMany({ where: { playerBId: dropId }, data: { playerBId: keepId } });
    await tx.match.updateMany({ where: { winnerId: dropId }, data: { winnerId: keepId } });
    await tx.match.updateMany({ where: { reporterId: dropId }, data: { reporterId: keepId } });
    await tx.match.updateMany({ where: { disputedById: dropId }, data: { disputedById: keepId } });
    await tx.game.updateMany({ where: { firstPlayerId: dropId }, data: { firstPlayerId: keepId } });
    await tx.game.updateMany({ where: { winnerId: dropId }, data: { winnerId: keepId } });
    await tx.game.updateMany({ where: { dcByPlayerId: dropId }, data: { dcByPlayerId: keepId } });
    // Live match sessions (ephemeral, but keep them consistent).
    await tx.matchSession.updateMany({ where: { playerAId: dropId }, data: { playerAId: keepId } });
    await tx.matchSession.updateMany({ where: { playerBId: dropId }, data: { playerBId: keepId } });
    // Tour-side references.
    await tx.tourSet.updateMany({ where: { playerAId: dropId }, data: { playerAId: keepId } });
    await tx.tourSet.updateMany({ where: { playerBId: dropId }, data: { playerBId: keepId } });
    await tx.tourSet.updateMany({ where: { reassignedFromId: dropId }, data: { reassignedFromId: keepId } });
    await tx.draftPick.updateMany({ where: { playerId: dropId }, data: { playerId: keepId } });
    await tx.award.updateMany({ where: { playerId: dropId }, data: { playerId: keepId } });
    await tx.teamSeason.updateMany({ where: { captainPlayerId: dropId }, data: { captainPlayerId: keepId } });
    await tx.strike.updateMany({ where: { playerId: dropId }, data: { playerId: keepId } });
    await tx.matchup.updateMany({ where: { pendingProposalPlayerId: dropId }, data: { pendingProposalPlayerId: keepId } });
    await tx.matchup.updateMany({ where: { officialPlayerId: dropId }, data: { officialPlayerId: keepId } });
    await tx.rosterMove.updateMany({ where: { playerId: dropId }, data: { playerId: keepId } });
    await tx.rosterMove.updateMany({ where: { outPlayerId: dropId }, data: { outPlayerId: keepId } });
    await tx.rosterMove.updateMany({ where: { replacesPlayerId: dropId }, data: { replacesPlayerId: keepId } });
    // PlayerCareerStat is unique per player: keep's wins if present, else repoint drop's.
    const keepStat = await tx.playerCareerStat.findUnique({ where: { playerId: keepId }, select: { playerId: true } });
    if (keepStat) await tx.playerCareerStat.deleteMany({ where: { playerId: dropId } });
    else await tx.playerCareerStat.updateMany({ where: { playerId: dropId }, data: { playerId: keepId } });
    // RosterEntry is unique per (roster, player): drop the dup's entry where keep is
    // already on that roster, repoint the rest.
    const keepRosters = new Set(
      (await tx.rosterEntry.findMany({ where: { playerId: keepId }, select: { rosterId: true } })).map((e) => e.rosterId),
    );
    for (const e of await tx.rosterEntry.findMany({ where: { playerId: dropId }, select: { id: true, rosterId: true } })) {
      if (keepRosters.has(e.rosterId)) await tx.rosterEntry.delete({ where: { id: e.id } });
      else await tx.rosterEntry.update({ where: { id: e.id }, data: { playerId: keepId } });
    }
    // Fold the dropped identity into keep's aliases so a re-import finds keep.
    const aliases = new Set([...keep.aliases, ...drop.aliases]);
    if (drop.discordId.startsWith("legacy:")) aliases.add(drop.discordId);
    await tx.player.update({ where: { id: keepId }, data: { aliases: [...aliases] } });
    await tx.player.delete({ where: { id: dropId } });
  });

  return { keep: keep.displayName, dropped: drop.displayName };
}
