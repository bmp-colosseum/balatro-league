// Identity service — link a Tour player to a real Discord id (picked from the
// league reference) and merge duplicate players. Pure logic; the admin UI/actions
// gate. Player.id is referenced by plain id everywhere (decoupling rule), so merge
// repoints each place by hand inside one transaction.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "../db";
import { leaguePlayersLive, leagueGuildMembers } from "../league-db";

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

// Store uploaded signups (preferred name ↔ @username) RAW, so they re-resolve live
// against whatever id sources exist now (league DB + a Discord guild sync) — no need
// to re-import when a new id source arrives. Idempotent (unique on the pair).
export async function applySignupRefs(signups: { preferredName: string; username: string }[]): Promise<{ stored: number }> {
  let stored = 0;
  for (const s of signups) {
    const preferredName = s.preferredName.trim(), username = s.username.trim();
    if (!preferredName || !username) continue;
    await prisma.signupRef.upsert({
      where: { preferredName_username: { preferredName, username } },
      create: { preferredName, username },
      update: {},
    });
    stored++;
  }
  return { stored };
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

// The reference used for suggestions/search: every name-to-id row we have, from
//   - the live league DB Player table (registered players: display names + usernames),
//   - the league GuildMember table (the FULL shared-guild roster the league bot syncs,
//     read-only over the league DB - this is how tour-only people resolve),
//   - the LeagueRef table (uploaded league CSV fallback),
// PLUS the signup chain resolved LIVE: each raw signup's @username is looked up against
// all of the above to turn its preferred name into a real id. Nothing about non-players
// is stored Tour-side; only the ids of players an admin approves get written.
// rankMatches dedups winners by id.
async function getSuggestRef(): Promise<LeagueRefRow[]> {
  const out: LeagueRefRow[] = [];
  try {
    const live = await leaguePlayersLive();
    if (live?.length) out.push(...live);
  } catch {
    /* live league DB unreachable - table rows below still cover it */
  }
  // The full shared-guild roster from the league (resolves tour-only members).
  try {
    const members = await leagueGuildMembers();
    if (members?.length) out.push(...members);
  } catch {
    /* GuildMember table not deployed/granted yet - league + signups still resolve */
  }
  out.push(...(await prisma.leagueRef.findMany({ select: { discordId: true, name: true } })));
  if (out.length === 0) {
    const path = join(process.cwd(), "league-players.csv");
    if (existsSync(path)) out.push(...parseLeagueCsv(readFileSync(path, "utf8")));
  }

  // Chain raw signups: preferred name -> @username -> id (against everything above).
  const idByName = new Map<string, string>();
  for (const r of out) { const n = norm(r.name); if (!idByName.has(n)) idByName.set(n, r.discordId); }
  for (const s of await prisma.signupRef.findMany({ select: { preferredName: true, username: true } })) {
    const id = idByName.get(norm(s.username));
    if (id) out.push({ discordId: id, name: s.preferredName });
  }
  return out;
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

// --- Bulk auto-link from signups + the league reference -------------------------
// Instead of clicking each player's "Likely:" suggestion, compute every
// HIGH-CONFIDENCE identity match at once for review-then-approve. High confidence =
// the player's name normalizes to EXACTLY ONE Discord id across the reference (league
// display names + @usernames + signup preferred names). When that id already belongs
// to another player it's surfaced as a merge (same person, twice) instead of a link.
// Names that map to several different ids are flagged for manual handling.

export interface AutoLinkProposal {
  playerId: string; playerName: string; sets: number;
  discordId: string; refName: string;
  kind: "link" | "merge";
  mergeIntoId?: string; mergeIntoName?: string; // when kind === "merge"
}
export interface AutoLinkPlan {
  links: AutoLinkProposal[];
  merges: AutoLinkProposal[];
  ambiguous: { playerId: string; playerName: string; candidates: { discordId: string; name: string }[] }[];
}

export async function planAutoLink(): Promise<AutoLinkPlan> {
  const [ref, players, counts] = await Promise.all([getSuggestRef(), prisma.player.findMany({ select: { id: true, displayName: true, discordId: true } }), setCounts()]);

  // normalized name → distinct Discord ids, and a display name per id.
  const idsByName = new Map<string, Set<string>>();
  const nameById = new Map<string, string>();
  for (const r of ref) {
    const n = norm(r.name);
    if (!n) continue;
    (idsByName.get(n) ?? idsByName.set(n, new Set()).get(n)!).add(r.discordId);
    if (!nameById.has(r.discordId)) nameById.set(r.discordId, r.name);
  }
  const playerByDiscord = new Map(players.map((p) => [p.discordId, p]));

  const links: AutoLinkProposal[] = [], merges: AutoLinkProposal[] = [];
  const ambiguous: AutoLinkPlan["ambiguous"] = [];
  for (const p of players) {
    if (!p.discordId.startsWith("legacy:")) continue; // already linked
    const ids = idsByName.get(norm(p.displayName));
    if (!ids || ids.size === 0) continue;
    if (ids.size > 1) {
      ambiguous.push({ playerId: p.id, playerName: p.displayName, candidates: [...ids].map((d) => ({ discordId: d, name: nameById.get(d) ?? d })) });
      continue;
    }
    const discordId = [...ids][0];
    const owner = playerByDiscord.get(discordId);
    const base = { playerId: p.id, playerName: p.displayName, sets: counts.get(p.id) ?? 0, discordId, refName: nameById.get(discordId) ?? discordId };
    if (!owner) links.push({ ...base, kind: "link" });
    else if (owner.id !== p.id) merges.push({ ...base, kind: "merge", mergeIntoId: owner.id, mergeIntoName: owner.displayName });
  }
  links.sort((a, b) => b.sets - a.sets || a.playerName.localeCompare(b.playerName));
  merges.sort((a, b) => b.sets - a.sets || a.playerName.localeCompare(b.playerName));
  return { links, merges, ambiguous };
}

// Apply chosen auto-link proposals. Re-derives + validates the plan so a stale form
// can't act on changed data. `link` proposals call linkPlayer; `merge` proposals fold
// the duplicate into the already-linked player (mergePlayers keeps the real id).
export async function applyAutoLink(picks: { playerId: string; discordId: string }[]): Promise<{ linked: number; merged: number; errors: string[] }> {
  const plan = await planAutoLink();
  const byKey = new Map<string, AutoLinkProposal>();
  for (const pr of [...plan.links, ...plan.merges]) byKey.set(`${pr.playerId}:${pr.discordId}`, pr);

  let linked = 0, merged = 0;
  const errors: string[] = [];
  for (const pick of picks) {
    const pr = byKey.get(`${pick.playerId}:${pick.discordId}`);
    if (!pr) { errors.push("Skipped a stale/invalid proposal."); continue; }
    try {
      if (pr.kind === "merge") { await mergePlayers(pr.mergeIntoId!, pr.playerId); merged++; }
      else { await linkPlayer(pr.playerId, pr.discordId); linked++; }
    } catch (e) {
      errors.push(`${pr.playerName}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { linked, merged, errors };
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
    // Preserve the REAL identity: the survivor keeps a real Discord id if EITHER
    // side has one — so "merge in" never accidentally UNLINKS a linked player just
    // because the merge was run from the duplicate's row. Any retired legacy id
    // becomes an alias so a re-import still re-attaches.
    const aliases = new Set([...keep.aliases, ...drop.aliases]);
    for (const did of [keep.discordId, drop.discordId]) if (did.startsWith("legacy:")) aliases.add(did);
    const keepLegacy = keep.discordId.startsWith("legacy:");
    const dropLegacy = drop.discordId.startsWith("legacy:");
    const survivingDiscordId = !keepLegacy ? keep.discordId : !dropLegacy ? drop.discordId : keep.discordId;
    await tx.player.delete({ where: { id: dropId } }); // frees drop's discordId for adoption
    await tx.player.update({ where: { id: keepId }, data: { aliases: [...aliases], discordId: survivingDiscordId } });
  });

  return { keep: keep.displayName, dropped: drop.displayName };
}
