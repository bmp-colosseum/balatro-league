import "server-only";

// "Help me resolve this tie" data for a division: the groups of players who are
// genuinely tied (can't be separated by the normal tiebreakers), and — among the
// tied players only — their head-to-head results, game record, net-life
// differential, and any shootout already recorded. That's the mini-league you
// actually use to decide placement.

import { prisma } from "@/lib/prisma";
import { loadDivisionStandings } from "@/lib/standings-cache";

export type H2HResult = "win" | "loss" | "draw" | "none";
export interface TieH2H {
  oppId: string;
  oppName: string;
  result: H2HResult; // from THIS member's perspective
  score: string; // e.g. "2-0", "1-1", or "—" if not played
}
export interface TieMember {
  playerId: string;
  displayName: string;
  netLives: number; // life differential vs the other tied players
  h2h: TieH2H[]; // vs each other tied member
}
export interface TieGroup {
  points: number;
  members: TieMember[];
  shootouts: Array<{ winnerName: string; loserName: string }>;
  allDecided: boolean; // every pair separated by H2H or a shootout
}

const pairKey = (a: string, b: string) => (a < b ? `${a}:${b}` : `${b}:${a}`);

export async function loadTieHelper(divisionId: string): Promise<TieGroup[]> {
  const rows = await loadDivisionStandings(divisionId);

  // Group consecutive rows sharing the unbreakable tie into tie chains.
  const chains: (typeof rows)[] = [];
  for (const r of rows) {
    if (r.tiedWithPrev && chains.length) chains[chains.length - 1]!.push(r);
    else chains.push([r]);
  }
  const tied = chains.filter((c) => c.length >= 2);
  if (tied.length === 0) return [];

  const tiedIds = new Set(tied.flatMap((c) => c.map((r) => r.player.id)));
  const idArr = [...tiedIds];

  // All confirmed BO2 matches (with per-game lives) AND shootouts between tied
  // players — one query each, then indexed by pair.
  const [bo2, shootouts] = await Promise.all([
    prisma.match.findMany({
      where: {
        divisionId,
        format: "LEAGUE_BO2",
        status: "CONFIRMED",
        playerAId: { in: idArr },
        playerBId: { in: idArr },
      },
      select: {
        playerAId: true,
        playerBId: true,
        gamesWonA: true,
        gamesWonB: true,
        winnerId: true,
        games: { select: { winnerId: true, winnerLives: true } },
      },
    }),
    prisma.match.findMany({
      where: {
        divisionId,
        format: "SHOOTOUT_BO1",
        winnerId: { not: null },
        playerAId: { in: idArr },
        playerBId: { in: idArr },
      },
      select: { playerAId: true, playerBId: true, winnerId: true },
    }),
  ]);

  const matchByPair = new Map(bo2.map((m) => [pairKey(m.playerAId, m.playerBId), m]));
  const shootoutWinnerByPair = new Map(shootouts.map((s) => [pairKey(s.playerAId, s.playerBId), s.winnerId!]));

  const nameById = new Map(rows.map((r) => [r.player.id, r.player.displayName]));

  return tied.map((chain) => {
    const memberIds = chain.map((r) => r.player.id);
    const shootoutRows: TieGroup["shootouts"] = [];
    let allDecided = true;

    const members: TieMember[] = chain.map((r) => {
      const me = r.player.id;
      let netLives = 0;
      const h2h: TieH2H[] = [];
      for (const oppId of memberIds) {
        if (oppId === me) continue;
        const m = matchByPair.get(pairKey(me, oppId));
        // Net-life: my lives when I won a game vs them, minus theirs when they won.
        if (m) {
          for (const g of m.games) {
            if (g.winnerLives == null || !g.winnerId) continue;
            if (g.winnerId === me) netLives += g.winnerLives;
            else if (g.winnerId === oppId) netLives -= g.winnerLives;
          }
        }
        // H2H result from my perspective.
        let result: H2HResult = "none";
        let score = "—";
        if (m) {
          const myGames = m.playerAId === me ? m.gamesWonA : m.gamesWonB;
          const oppGames = m.playerAId === me ? m.gamesWonB : m.gamesWonA;
          score = `${myGames}-${oppGames}`;
          result = myGames > oppGames ? "win" : myGames < oppGames ? "loss" : "draw";
        }
        h2h.push({ oppId, oppName: nameById.get(oppId) ?? oppId, result, score });
      }
      return { playerId: me, displayName: r.player.displayName, netLives, h2h };
    });

    // Decided-check + shootout list (each unordered pair once).
    for (let i = 0; i < memberIds.length; i++) {
      for (let j = i + 1; j < memberIds.length; j++) {
        const a = memberIds[i]!;
        const b = memberIds[j]!;
        const key = pairKey(a, b);
        const so = shootoutWinnerByPair.get(key);
        if (so) {
          shootoutRows.push({ winnerName: nameById.get(so) ?? so, loserName: nameById.get(so === a ? b : a) ?? "" });
          continue;
        }
        const m = matchByPair.get(key);
        const decidedByH2H = m && m.gamesWonA !== m.gamesWonB; // 2-0/0-2 separates; 1-1 doesn't
        if (!decidedByH2H) allDecided = false;
      }
    }

    return { points: chain[0]!.points, members, shootouts: shootoutRows, allDecided };
  });
}
