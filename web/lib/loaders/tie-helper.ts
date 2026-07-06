import "server-only";

// "Help me resolve this tie" data for a division: the groups of players who are
// genuinely tied, their head-to-head (among the tied players), AND — for each
// tied player — their FULL game log this season (every game vs anyone, with the
// winner's remaining lives), plus a normalized life summary. That's the raw life
// data to weigh when deciding the fairest way to break the tie.

import { prisma } from "@/lib/prisma";
import { loadDivisionStandings } from "@/lib/standings-cache";

export type H2HResult = "win" | "loss" | "draw" | "none";

// One game of a head-to-head matchup, from the row player's perspective.
export interface GameLife {
  num: number;
  won: boolean;
  lives: number | null; // winner's remaining lives (null = not recorded)
}
export interface TieH2H {
  oppId: string;
  oppName: string;
  result: H2HResult;
  score: string;
  games: GameLife[];
}

// One game in a player's FULL log (vs any opponent).
export interface PlayerGame {
  opponentName: string;
  won: boolean;
  lives: number | null; // the winner's lives (theirs if they won, opp's if they lost)
  deck: string | null;
  stake: string | null;
}
export interface TieMember {
  playerId: string;
  displayName: string;
  h2h: TieH2H[]; // vs each other tied member
  games: PlayerGame[]; // ALL their confirmed games this season
  wins: number;
  losses: number;
  livesInWins: number; // Σ their remaining lives across games they won
  livesConceded: number; // Σ opponent's remaining lives across games they lost
}
export interface TieGroup {
  points: number;
  members: TieMember[];
  shootouts: Array<{ winnerName: string; loserName: string }>;
  allDecided: boolean;
}

const pairKey = (a: string, b: string) => (a < b ? `${a}:${b}` : `${b}:${a}`);

export async function loadTieHelper(divisionId: string): Promise<TieGroup[]> {
  const rows = await loadDivisionStandings(divisionId);

  const chains: (typeof rows)[] = [];
  for (const r of rows) {
    if (r.tiedWithPrev && chains.length) chains[chains.length - 1]!.push(r);
    else chains.push([r]);
  }
  const tied = chains.filter((c) => c.length >= 2);
  if (tied.length === 0) return [];

  const tiedIds = new Set(tied.flatMap((c) => c.map((r) => r.player.id)));
  const idArr = [...tiedIds];

  // ALL confirmed BO2 matches involving a tied player (vs ANYONE) + shootouts.
  const [matches, shootouts] = await Promise.all([
    prisma.match.findMany({
      where: {
        divisionId,
        format: "LEAGUE_BO2",
        status: "CONFIRMED",
        OR: [{ playerAId: { in: idArr } }, { playerBId: { in: idArr } }],
      },
      select: {
        playerAId: true,
        playerBId: true,
        gamesWonA: true,
        gamesWonB: true,
        games: { select: { num: true, winnerId: true, winnerLives: true, deck: true, stake: true } },
      },
    }),
    prisma.match.findMany({
      where: {
        divisionId,
        format: "SHOOTOUT_BO1",
        winnerId: { not: null },
        OR: [{ playerAId: { in: idArr } }, { playerBId: { in: idArr } }],
      },
      select: { playerAId: true, playerBId: true, winnerId: true },
    }),
  ]);

  // Names for every player who appears (tied + their opponents).
  const nameById = new Map(rows.map((r) => [r.player.id, r.player.displayName]));
  const missing = new Set<string>();
  for (const m of matches) [m.playerAId, m.playerBId].forEach((id) => !nameById.has(id) && missing.add(id));
  for (const s of shootouts) [s.playerAId, s.playerBId].forEach((id) => !nameById.has(id) && missing.add(id));
  if (missing.size) {
    const extra = await prisma.player.findMany({ where: { id: { in: [...missing] } }, select: { id: true, displayName: true } });
    for (const p of extra) nameById.set(p.id, p.displayName);
  }

  const matchByPair = new Map(matches.map((m) => [pairKey(m.playerAId, m.playerBId), m]));
  const shootoutWinnerByPair = new Map(shootouts.map((s) => [pairKey(s.playerAId, s.playerBId), s.winnerId!]));
  const matchesByPlayer = new Map<string, typeof matches>();
  for (const m of matches) {
    for (const pid of [m.playerAId, m.playerBId]) {
      if (!tiedIds.has(pid)) continue;
      (matchesByPlayer.get(pid) ?? matchesByPlayer.set(pid, []).get(pid)!).push(m);
    }
  }

  return tied.map((chain) => {
    const memberIds = chain.map((r) => r.player.id);
    const shootoutRows: TieGroup["shootouts"] = [];
    let allDecided = true;

    const members: TieMember[] = chain.map((r) => {
      const me = r.player.id;

      // Head-to-head vs the other tied players.
      const h2h: TieH2H[] = [];
      for (const oppId of memberIds) {
        if (oppId === me) continue;
        const m = matchByPair.get(pairKey(me, oppId));
        let result: H2HResult = "none";
        let score = "—";
        const games: GameLife[] = [];
        if (m) {
          const myGames = m.playerAId === me ? m.gamesWonA : m.gamesWonB;
          const oppGames = m.playerAId === me ? m.gamesWonB : m.gamesWonA;
          score = `${myGames}-${oppGames}`;
          result = myGames > oppGames ? "win" : myGames < oppGames ? "loss" : "draw";
          for (const g of [...m.games].sort((a, b) => a.num - b.num)) {
            if (!g.winnerId) continue;
            games.push({ num: g.num, won: g.winnerId === me, lives: g.winnerLives });
          }
        }
        h2h.push({ oppId, oppName: nameById.get(oppId) ?? oppId, result, score, games });
      }

      // Full game log (all games vs anyone) + life summary.
      const gameLog: PlayerGame[] = [];
      let wins = 0;
      let losses = 0;
      let livesInWins = 0;
      let livesConceded = 0;
      for (const m of matchesByPlayer.get(me) ?? []) {
        const oppId = m.playerAId === me ? m.playerBId : m.playerAId;
        for (const g of [...m.games].sort((a, b) => a.num - b.num)) {
          if (!g.winnerId) continue;
          const won = g.winnerId === me;
          gameLog.push({ opponentName: nameById.get(oppId) ?? oppId, won, lives: g.winnerLives, deck: g.deck, stake: g.stake });
          if (won) {
            wins++;
            if (g.winnerLives != null) livesInWins += g.winnerLives;
          } else {
            losses++;
            if (g.winnerLives != null) livesConceded += g.winnerLives;
          }
        }
      }
      // Group opponents together for readability.
      gameLog.sort((a, b) => a.opponentName.localeCompare(b.opponentName) || Number(b.won) - Number(a.won));

      return { playerId: me, displayName: r.player.displayName, h2h, games: gameLog, wins, losses, livesInWins, livesConceded };
    });

    for (let i = 0; i < memberIds.length; i++) {
      for (let j = i + 1; j < memberIds.length; j++) {
        const a = memberIds[i]!;
        const b = memberIds[j]!;
        const so = shootoutWinnerByPair.get(pairKey(a, b));
        if (so) {
          shootoutRows.push({ winnerName: nameById.get(so) ?? so, loserName: nameById.get(so === a ? b : a) ?? "" });
          continue;
        }
        const m = matchByPair.get(pairKey(a, b));
        if (!(m && m.gamesWonA !== m.gamesWonB)) allDecided = false;
      }
    }

    return { points: chain[0]!.points, members, shootouts: shootoutRows, allDecided };
  });
}
