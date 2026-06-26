// All-time superlatives + biggest rivalries — pure reductions over the imported
// players + sets. No new data.
import { prisma } from "@/lib/db";
import { getAllTimePlayers } from "@/lib/stats";
import { getDraftSteals } from "@/lib/draft-stats";

const rate = (w: number, l: number) => (w + l ? w / (w + l) : 0);

export interface RecordEntry {
  label: string;
  playerId: string;
  name: string;
  value: string;
  detail: string;
}

export async function getRecords(): Promise<RecordEntry[]> {
  const players = await getAllTimePlayers();
  const qualified = players.filter((p) => p.setW + p.setL >= 20);
  const recs: RecordEntry[] = [];

  const ringed = players.filter((p) => p.rings > 0).sort((a, b) => b.rings - a.rings)[0];
  if (ringed) recs.push({ label: "Most championships", playerId: ringed.playerId, name: ringed.name, value: `${ringed.rings} 💍`, detail: `${ringed.seasons} seasons` });

  const sns = [...players].sort((a, b) => b.seasons - a.seasons)[0];
  if (sns) recs.push({ label: "Most seasons", playerId: sns.playerId, name: sns.name, value: `${sns.seasons}`, detail: "seasons played" });

  const setPct = [...qualified].sort((a, b) => rate(b.setW, b.setL) - rate(a.setW, a.setL))[0];
  if (setPct) recs.push({ label: "Best career set %", playerId: setPct.playerId, name: setPct.name, value: `${(rate(setPct.setW, setPct.setL) * 100).toFixed(1)}%`, detail: `${setPct.setW}–${setPct.setL} (min 20)` });

  const gamePct = [...qualified].sort((a, b) => rate(b.gameW, b.gameL) - rate(a.gameW, a.gameL))[0];
  if (gamePct) recs.push({ label: "Best career game %", playerId: gamePct.playerId, name: gamePct.name, value: `${(rate(gamePct.gameW, gamePct.gameL) * 100).toFixed(1)}%`, detail: `${gamePct.gameW}–${gamePct.gameL} (min 20)` });

  const vol = [...players].sort((a, b) => b.setW + b.setL - (a.setW + a.setL))[0];
  if (vol) recs.push({ label: "Most sets played", playerId: vol.playerId, name: vol.name, value: `${vol.setW + vol.setL}`, detail: `${vol.setW}–${vol.setL}` });

  const steal = (await getDraftSteals(8, 1))[0];
  if (steal) recs.push({ label: "Biggest draft steal", playerId: steal.playerId, name: steal.name, value: `R${steal.round}`, detail: `${steal.season} · ${(steal.pct * 100).toFixed(0)}% (${steal.setW}–${steal.setL})` });

  return recs;
}

export interface RookieRow {
  playerId: string;
  name: string;
  season: string;
  setW: number;
  setL: number;
  pct: number;
}

// Rookie rankings: each player's DEBUT season (earliest in the imported data),
// ranked by their set-win% that season. "Rookie" = first season we have data for.
export async function getRookieRankings(minSets = 6, limit = 20): Promise<RookieRow[]> {
  const [sets, matches, players, seasons] = await Promise.all([
    prisma.tourSet.findMany({ select: { playerAId: true, playerBId: true, matchId: true, seasonId: true } }),
    prisma.match.findMany({ select: { id: true, winnerId: true } }),
    prisma.player.findMany({ select: { id: true, displayName: true } }),
    prisma.tourSeason.findMany({ select: { id: true, name: true } }),
  ]);
  const winById = new Map(matches.map((m) => [m.id, m.winnerId]));
  const nameOf = new Map(players.map((p) => [p.id, p.displayName]));
  const num = (s: string) => Number(s.match(/(\d+)/)?.[1] ?? 0);
  const seasonInfo = new Map(seasons.map((s) => [s.id, { name: s.name, num: num(s.name) }]));

  const rec = new Map<string, { setW: number; setL: number }>(); // `${seasonId}:${playerId}`
  const playerSeasons = new Map<string, Set<string>>();
  const bump = (sid: string | null, pid: string, win: boolean) => {
    if (!sid) return;
    const k = `${sid}:${pid}`;
    const r = rec.get(k) ?? { setW: 0, setL: 0 };
    if (win) r.setW++;
    else r.setL++;
    rec.set(k, r);
    const ps = playerSeasons.get(pid) ?? new Set<string>();
    ps.add(sid);
    playerSeasons.set(pid, ps);
  };
  for (const ts of sets) {
    if (!ts.matchId) continue;
    const w = winById.get(ts.matchId);
    if (w == null) continue;
    bump(ts.seasonId, ts.playerAId, w === ts.playerAId);
    bump(ts.seasonId, ts.playerBId, w === ts.playerBId);
  }

  const rows: RookieRow[] = [];
  for (const [pid, sids] of playerSeasons) {
    let rookieSid: string | null = null;
    let minNum = Infinity;
    for (const sid of sids) {
      const n = seasonInfo.get(sid)?.num ?? Infinity;
      if (n < minNum) {
        minNum = n;
        rookieSid = sid;
      }
    }
    if (!rookieSid) continue;
    const r = rec.get(`${rookieSid}:${pid}`) ?? { setW: 0, setL: 0 };
    const total = r.setW + r.setL;
    if (total < minSets) continue;
    rows.push({
      playerId: pid,
      name: nameOf.get(pid) ?? pid,
      season: seasonInfo.get(rookieSid)?.name ?? rookieSid,
      setW: r.setW,
      setL: r.setL,
      pct: total ? r.setW / total : 0,
    });
  }
  rows.sort((a, b) => b.pct - a.pct || b.setW + b.setL - (a.setW + a.setL));
  return rows.slice(0, limit);
}

export interface Rivalry {
  aId: string;
  aName: string;
  bId: string;
  bName: string;
  total: number;
  aWins: number;
  bWins: number;
}

export interface H2HMatrix {
  players: { id: string; name: string }[];
  // records[rowId][colId] = the ROW player's record vs the COL player (set W-L).
  records: Record<string, Record<string, { w: number; l: number }>>;
}

// Player-vs-player H2H grid for the most-active `topN` players. Cells are the row
// player's set W-L vs the column player (sparse — TT players rarely replay across
// seasons). Same pair-tally as getRivalries, made directional.
export async function getH2HMatrix(topN = 16): Promise<H2HMatrix> {
  const [sets, matches] = await Promise.all([
    prisma.tourSet.findMany({ select: { playerAId: true, playerBId: true, matchId: true } }),
    prisma.match.findMany({ select: { id: true, winnerId: true } }),
  ]);
  const winById = new Map(matches.map((m) => [m.id, m.winnerId]));
  const dir = new Map<string, number>(); // `${x}|${y}` = x's set wins over y
  const totalSets = new Map<string, number>();
  for (const ts of sets) {
    if (!ts.matchId) continue;
    const w = winById.get(ts.matchId);
    if (w == null) continue;
    const { playerAId: a, playerBId: b } = ts;
    totalSets.set(a, (totalSets.get(a) ?? 0) + 1);
    totalSets.set(b, (totalSets.get(b) ?? 0) + 1);
    if (w === a) dir.set(`${a}|${b}`, (dir.get(`${a}|${b}`) ?? 0) + 1);
    else if (w === b) dir.set(`${b}|${a}`, (dir.get(`${b}|${a}`) ?? 0) + 1);
  }

  const topIds = [...totalSets.entries()].sort((x, y) => y[1] - x[1]).slice(0, topN).map((e) => e[0]);
  const players = await prisma.player.findMany({ where: { id: { in: topIds } }, select: { id: true, displayName: true } });
  const nameOf = new Map(players.map((p) => [p.id, p.displayName]));
  const ordered = topIds.map((id) => ({ id, name: nameOf.get(id) ?? id }));

  const records: Record<string, Record<string, { w: number; l: number }>> = {};
  for (const r of ordered) {
    records[r.id] = {};
    for (const c of ordered) {
      if (r.id === c.id) continue;
      const w = dir.get(`${r.id}|${c.id}`) ?? 0;
      const l = dir.get(`${c.id}|${r.id}`) ?? 0;
      if (w || l) records[r.id][c.id] = { w, l };
    }
  }
  return { players: ordered, records };
}

// All-time most-played player-vs-player matchups (sets), with the head-to-head.
export async function getRivalries(limit = 15): Promise<Rivalry[]> {
  const [sets, matches] = await Promise.all([
    prisma.tourSet.findMany({ select: { playerAId: true, playerBId: true, matchId: true } }),
    prisma.match.findMany({ select: { id: true, winnerId: true } }),
  ]);
  const winById = new Map(matches.map((m) => [m.id, m.winnerId]));
  const pairs = new Map<string, { a: string; b: string; total: number; aWins: number; bWins: number }>();
  for (const ts of sets) {
    if (!ts.matchId) continue;
    const [a, b] = [ts.playerAId, ts.playerBId].sort();
    const key = `${a}|${b}`;
    const p = pairs.get(key) ?? { a, b, total: 0, aWins: 0, bWins: 0 };
    p.total++;
    const w = winById.get(ts.matchId);
    if (w === a) p.aWins++;
    else if (w === b) p.bWins++;
    pairs.set(key, p);
  }
  const top = [...pairs.values()].sort((x, y) => y.total - x.total).slice(0, limit);

  const ids = [...new Set(top.flatMap((p) => [p.a, p.b]))];
  const players = await prisma.player.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true } });
  const nameOf = new Map(players.map((p) => [p.id, p.displayName]));
  return top.map((p) => ({
    aId: p.a,
    aName: nameOf.get(p.a) ?? p.a,
    bId: p.b,
    bName: nameOf.get(p.b) ?? p.b,
    total: p.total,
    aWins: p.aWins,
    bWins: p.bWins,
  }));
}
