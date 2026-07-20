// Data for /admin/seasons/[id]/winners: a compact per-division "who won"
// list so a TO can hand out awards without scrolling every division's full
// standings table. Ladder order (tier position asc, then group number asc)
// matches the other admin season loaders (see admin-seasons.ts).
//
// Standings come from loadManyDivisionStandings (web/lib/standings-cache.ts)
// -- the SAME cached/derived reader every other standings surface uses.
// Never recompute standings math here.

import "server-only";

import { prisma } from "@/lib/prisma";
import { loadManyDivisionStandings } from "@/lib/standings-cache";
import { formatSeasonLabel } from "@/lib/format-season";
import type { StandingRow } from "@/lib/standings";

export interface DivisionWinnerRow {
  playerId: string;
  displayName: string;
  discordId: string;
  username: string | null;
  points: number;
  wins: number;
  losses: number;
  draws: number;
}

export interface SeasonWinnerDivision {
  divisionId: string;
  divisionName: string;
  tierName: string;
  memberCount: number;
  // Rank-1 finisher(s). Empty when no active member has played a match yet
  // (nothing to award). More than one entry = a real, unresolved tie for #1.
  winners: DivisionWinnerRow[];
  tied: boolean;
  hasPlayedMatches: boolean;
  championPlayerId: string | null;
  championRoleId: string | null;
}

export interface SeasonWinnersPageData {
  seasonId: string;
  seasonLabel: string;
  seasonEnded: boolean;
  divisions: SeasonWinnerDivision[];
}

// "Has the champion role been handed out, and does it still match reality?"
//   - no-winner: nobody has played a match yet -- nothing to award.
//   - tied: real tie for #1 -- awardSeasonChampionRoles (bootstrap-actions.ts)
//     deliberately skips these divisions until the tie resolves.
//   - pending: a clear winner exists but championPlayerId is unset.
//   - awarded: championPlayerId matches (one of) the current winner(s).
//   - mismatch: championPlayerId is set but the standings have moved since --
//     it no longer names a current winner.
export type WinnerAwardStatus = "no-winner" | "tied" | "pending" | "awarded" | "mismatch";

export function winnerAwardStatus(d: Pick<SeasonWinnerDivision, "winners" | "tied" | "hasPlayedMatches" | "championPlayerId">): WinnerAwardStatus {
  if (!d.hasPlayedMatches) return "no-winner";
  if (d.tied) return "tied";
  if (d.championPlayerId === null) return "pending";
  return d.winners.some((w) => w.playerId === d.championPlayerId) ? "awarded" : "mismatch";
}

// Pure: rank-1 finisher(s) from an already-ranked, already-sorted standings
// list (assignRanks gives every genuinely-tied row the SAME rank number, so
// "everyone at rank 1" is exactly "everyone tied for the win"). Kept as its
// own function so the tie rule is unit-testable without touching Prisma.
export function pickDivisionWinners(rows: StandingRow[]): StandingRow[] {
  if (rows.length === 0) return [];
  const topRank = rows[0]!.rank ?? 1;
  return rows.filter((r) => (r.rank ?? 1) === topRank);
}

export async function loadSeasonWinners(seasonId: string): Promise<SeasonWinnersPageData | null> {
  const season = await prisma.season.findUnique({
    where: { id: seasonId },
    select: {
      id: true,
      number: true,
      subtitle: true,
      endedAt: true,
      divisions: {
        orderBy: [{ tier: { position: "asc" } }, { groupNumber: "asc" }],
        select: {
          id: true,
          name: true,
          championPlayerId: true,
          championRoleId: true,
          tier: { select: { name: true } },
          _count: { select: { members: { where: { status: "ACTIVE" } } } },
        },
      },
    },
  });
  if (!season) return null;

  const standingsByDivision = await loadManyDivisionStandings(season.divisions.map((d) => d.id));

  const divisions: SeasonWinnerDivision[] = season.divisions.map((d) => {
    const rows = standingsByDivision.get(d.id) ?? [];
    const hasPlayedMatches = rows.some((r) => r.played > 0);
    // No played matches -> every row reads as tied on 0-0-0, which is NOT a
    // real "everyone shares the win" -- it's "no winner yet". Suppress.
    const winnerRows = hasPlayedMatches ? pickDivisionWinners(rows) : [];
    const winners: DivisionWinnerRow[] = winnerRows.map((r) => ({
      playerId: r.player.id,
      displayName: r.player.displayName,
      discordId: r.player.discordId,
      username: r.player.username,
      points: r.points,
      wins: r.wins,
      losses: r.losses,
      draws: r.draws,
    }));
    return {
      divisionId: d.id,
      divisionName: d.name,
      tierName: d.tier.name,
      memberCount: d._count.members,
      winners,
      tied: winners.length > 1,
      hasPlayedMatches,
      championPlayerId: d.championPlayerId,
      championRoleId: d.championRoleId,
    };
  });

  return {
    seasonId: season.id,
    seasonLabel: formatSeasonLabel(season),
    seasonEnded: season.endedAt !== null,
    divisions,
  };
}
