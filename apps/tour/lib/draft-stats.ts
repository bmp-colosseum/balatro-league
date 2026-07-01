// Draft-driven "fun stats": did a draft pick pay off? Joins each drafted
// player-season (round) with that player's set record that season. Pure read model
// over Draft/DraftPick + TourSet/Match — no new data needed.
import { prisma } from "@/lib/db";

// (season, player) → set W/L, tallied once from every set's wrapped Match winner.
async function seasonPlayerSetRecords(): Promise<Map<string, { setW: number; setL: number }>> {
  const [sets, matches] = await Promise.all([
    prisma.tourSet.findMany({ select: { playerAId: true, playerBId: true, matchId: true, seasonId: true } }),
    prisma.match.findMany({ select: { id: true, winnerId: true } }),
  ]);
  const winById = new Map(matches.map((m) => [m.id, m.winnerId]));
  const rec = new Map<string, { setW: number; setL: number }>();
  const bump = (sid: string | null, pid: string, win: boolean) => {
    if (!sid) return;
    const k = `${sid}:${pid}`;
    const r = rec.get(k) ?? { setW: 0, setL: 0 };
    if (win) r.setW++;
    else r.setL++;
    rec.set(k, r);
  };
  for (const ts of sets) {
    if (!ts.matchId) continue;
    const w = winById.get(ts.matchId);
    if (w == null) continue;
    bump(ts.seasonId, ts.playerAId, w === ts.playerAId);
    bump(ts.seasonId, ts.playerBId, w === ts.playerBId);
  }
  return rec;
}

async function draftedRows() {
  const [picks, rec, players] = await Promise.all([
    prisma.draftPick.findMany({
      where: { NOT: { playerId: null } },
      include: { draft: { select: { seasonId: true, season: { select: { name: true } } } } },
    }),
    seasonPlayerSetRecords(),
    prisma.player.findMany({ select: { id: true, displayName: true } }),
  ]);
  const nameOf = new Map(players.map((p) => [p.id, p.displayName]));
  return picks.map((pk) => {
    const r = rec.get(`${pk.draft.seasonId}:${pk.playerId}`) ?? { setW: 0, setL: 0 };
    const total = r.setW + r.setL;
    return {
      playerId: pk.playerId!,
      name: nameOf.get(pk.playerId!) ?? pk.playerId!,
      season: pk.draft.season.name,
      round: pk.round,
      setW: r.setW,
      setL: r.setL,
      pct: total ? r.setW / total : 0,
      total,
    };
  });
}

export interface StealRow {
  playerId: string;
  name: string;
  season: string;
  round: number;
  setW: number;
  setL: number;
  pct: number;
}

// Biggest steals: late picks who overperformed. Score = round × set-win-rate
// (a round-8 pick at 70% beats a round-2 pick at 70%). Min sets gate filters noise.
export async function getDraftSteals(minSets = 8, limit = 20): Promise<StealRow[]> {
  const rows = await draftedRows();
  return rows
    .filter((r) => r.total >= minSets)
    .map((r) => ({ ...r, score: r.round * r.pct }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export interface RoundValueRow {
  round: number;
  count: number;
  setW: number;
  setL: number;
  pct: number;
}

// Draft value by round: do earlier picks actually win more? Aggregates every
// drafted player-season's set record by the round they were drafted in.
export async function getDraftValueByRound(): Promise<RoundValueRow[]> {
  const rows = await draftedRows();
  const byRound = new Map<number, { setW: number; setL: number; n: number }>();
  for (const r of rows) {
    const b = byRound.get(r.round) ?? { setW: 0, setL: 0, n: 0 };
    b.setW += r.setW;
    b.setL += r.setL;
    b.n++;
    byRound.set(r.round, b);
  }
  return [...byRound.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([round, b]) => ({ round, count: b.n, setW: b.setW, setL: b.setL, pct: b.setW + b.setL ? b.setW / (b.setW + b.setL) : 0 }));
}

// The expected set-win% for each draft round (the global average) — the baseline
// a pick's "value" (delta) is measured against in the heatmap.
async function expectedByRound(): Promise<Map<number, number>> {
  const rows = await getDraftValueByRound();
  return new Map(rows.map((r) => [r.round, r.pct]));
}

export interface HeatCell {
  name: string;
  playerId: string;
  round: number;
  pct: number | null; // player's set-win% that season (null = no sets)
  delta: number | null; // pct − expected[round]; >0 = steal, <0 = bust
  sets: number;
}
export interface HeatTeam {
  teamSeasonId: string;
  name: string;
  seed: number;
  captain: { name: string; captainId: string; seed: number | null; pct: number | null; delta: number | null; sets: number };
  cells: (HeatCell | null)[];
}

// Per-season draft value board: rows = teams (by seed), columns = rounds, each
// drafted pick carrying its delta vs. the expected set% for that round.
export async function getDraftHeatmap(seasonName: string) {
  const season = await prisma.tourSeason.findUnique({
    where: { name: seasonName },
    include: { draft: { select: { id: true } } },
  });
  if (!season || !season.draft) return null;

  const [picks, teamSeasons, rec, expected] = await Promise.all([
    prisma.draftPick.findMany({ where: { draftId: season.draft.id, NOT: { playerId: null } } }),
    prisma.teamSeason.findMany({ where: { seasonId: season.id }, include: { team: true }, orderBy: { seed: "asc" } }),
    seasonPlayerSetRecords(),
    expectedByRound(),
  ]);

  const ids = [...new Set([...picks.map((p) => p.playerId!), ...teamSeasons.map((t) => t.captainPlayerId)])];
  const players = await prisma.player.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true } });
  const nameOf = new Map(players.map((p) => [p.id, p.displayName]));

  // Captains aren't draft picks, but they have an intra-team seed (from the rankings) — use
  // it to color them against the expected set% for that seed slot, same idea as the picks.
  const capEntries = await prisma.rosterEntry.findMany({ where: { roster: { teamSeasonId: { in: teamSeasons.map((t) => t.id) } } }, select: { playerId: true, seed: true, roster: { select: { teamSeasonId: true } } } });
  const seedByCap = new Map(capEntries.map((e) => [`${e.roster.teamSeasonId}|${e.playerId}`, e.seed]));

  const maxRound = Math.max(0, ...picks.map((p) => p.round));
  const recFor = (pid: string) => rec.get(`${season.id}:${pid}`) ?? { setW: 0, setL: 0 };

  const teams: HeatTeam[] = teamSeasons.map((ts) => {
    const cr = recFor(ts.captainPlayerId);
    const cTotal = cr.setW + cr.setL;
    const cSeed = seedByCap.get(`${ts.id}|${ts.captainPlayerId}`) ?? null;
    const cPct = cTotal ? cr.setW / cTotal : null;
    const cExp = cSeed != null ? expected.get(cSeed) ?? null : null;
    const cDelta = cPct != null && cExp != null ? cPct - cExp : null;
    const cells: (HeatCell | null)[] = [];
    for (let round = 1; round <= maxRound; round++) {
      const pick = picks.find((p) => p.teamSeasonId === ts.id && p.round === round);
      if (!pick) {
        cells.push(null);
        continue;
      }
      const r = recFor(pick.playerId!);
      const total = r.setW + r.setL;
      const pct = total ? r.setW / total : null;
      const exp = expected.get(round) ?? null;
      const delta = pct != null && exp != null ? pct - exp : null;
      cells.push({ name: nameOf.get(pick.playerId!) ?? "?", playerId: pick.playerId!, round, pct, delta, sets: total });
    }
    return {
      teamSeasonId: ts.id,
      name: ts.team.name,
      seed: ts.seed,
      captain: { name: nameOf.get(ts.captainPlayerId) ?? "?", captainId: ts.captainPlayerId, seed: cSeed, pct: cPct, delta: cDelta, sets: cTotal },
      cells,
    };
  });

  return { seasonName: season.name, maxRound, teams };
}

export interface CaptainGradeRow {
  captainId: string;
  name: string;
  seasons: number; // distinct seasons captained (with a draft)
  picks: number; // graded picks (drafted players with >= minSets that season)
  setW: number; // aggregate set record of the players they drafted
  setL: number;
  avgDelta: number; // mean (player set% − expected-for-round) across graded picks
  best: { name: string; season: string; round: number; delta: number } | null;
}

// Captain draft grades: did a captain's picks beat the expected set% for the slot
// they spent? For every pick a captain made (their team's picks, minus the captain
// themselves), delta = the player's set% that season − the global average set% for
// that round. avgDelta is the captain's mean value-added per pick. Reuses the same
// expected-by-round baseline as the heatmap. min gates filter small samples.
export async function getCaptainDraftGrades(minSetsPerPick = 4, minPicks = 4): Promise<CaptainGradeRow[]> {
  const [picks, teamSeasons, rec, expected, players] = await Promise.all([
    prisma.draftPick.findMany({
      where: { NOT: { playerId: null } },
      include: { draft: { select: { seasonId: true, season: { select: { name: true } } } } },
    }),
    prisma.teamSeason.findMany({ select: { id: true, captainPlayerId: true } }),
    seasonPlayerSetRecords(),
    expectedByRound(),
    prisma.player.findMany({ select: { id: true, displayName: true } }),
  ]);
  const captainOf = new Map(teamSeasons.map((t) => [t.id, t.captainPlayerId]));
  const nameOf = new Map(players.map((p) => [p.id, p.displayName]));

  interface Acc {
    setW: number;
    setL: number;
    deltas: number[];
    seasons: Set<string>;
    best: { name: string; season: string; round: number; delta: number } | null;
  }
  const byCaptain = new Map<string, Acc>();

  for (const pk of picks) {
    const captainId = captainOf.get(pk.teamSeasonId);
    if (!captainId) continue;
    if (pk.playerId === captainId) continue; // skip the captain's own (self) slot
    const r = rec.get(`${pk.draft.seasonId}:${pk.playerId}`) ?? { setW: 0, setL: 0 };
    const total = r.setW + r.setL;
    if (total < minSetsPerPick) continue;
    const exp = expected.get(pk.round);
    if (exp == null) continue;
    const delta = r.setW / total - exp;

    const a = byCaptain.get(captainId) ?? { setW: 0, setL: 0, deltas: [], seasons: new Set<string>(), best: null };
    a.setW += r.setW;
    a.setL += r.setL;
    a.deltas.push(delta);
    a.seasons.add(pk.draft.seasonId);
    if (!a.best || delta > a.best.delta) {
      a.best = { name: nameOf.get(pk.playerId!) ?? "?", season: pk.draft.season.name, round: pk.round, delta };
    }
    byCaptain.set(captainId, a);
  }

  const rows: CaptainGradeRow[] = [];
  for (const [captainId, a] of byCaptain) {
    if (a.deltas.length < minPicks) continue;
    rows.push({
      captainId,
      name: nameOf.get(captainId) ?? captainId,
      seasons: a.seasons.size,
      picks: a.deltas.length,
      setW: a.setW,
      setL: a.setL,
      avgDelta: a.deltas.reduce((s, d) => s + d, 0) / a.deltas.length,
      best: a.best,
    });
  }
  rows.sort((a, b) => b.avgDelta - a.avgDelta);
  return rows;
}

// Which seasons have an imported draft (for the heatmap season switcher).
export async function seasonsWithDraft(): Promise<string[]> {
  const drafts = await prisma.draft.findMany({ include: { season: { select: { name: true } } } });
  const num = (s: string) => Number(s.match(/(\d+)/)?.[1] ?? 0);
  return drafts.map((d) => d.season.name).sort((a, b) => num(a) - num(b));
}
