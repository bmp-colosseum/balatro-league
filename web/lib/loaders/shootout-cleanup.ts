import "server-only";

// Loader for the admin "Shootout clean-up" section of
// /admin/standings-preview. For a given season, finds every admin-recorded
// tie-break shootout (a CONFIRMED SHOOTOUT_BO1 match -- see
// resolveTieWithShowdowns in web/lib/match-admin.ts) in every division, and
// classifies each one against what the "lives" tiebreak (Season.tiebreak,
// see web/lib/standings-mode.ts) would have decided, using
// web/lib/shootout-cleanup-core.ts's pure planShootoutCleanup. Net lives are
// computed via computeNetLives (web/lib/standings.ts) over the SAME
// CONFIRMED LEAGUE_BO2 pairings the live "lives" tiebreak itself reads, so
// this plan can never disagree with what flipping the season to
// tiebreak: "lives" would actually do.
//
// Read-only: nothing here writes anything. The actual deletion is
// web/app/admin/standings-preview/actions.ts's
// convertSeasonToLivesTiebreakAction / deleteShootoutAction, which re-load
// this same plan server-side before touching the database.

import { prisma } from "@/lib/prisma";
import { formatSeasonLabel } from "@/lib/format-season";
import { computeNetLives, type PairingWithLives } from "@/lib/standings";
import {
  planShootoutCleanup,
  type ShootoutCleanupEntry,
  type ShootoutCleanupInput,
  type PlayerNetLives,
} from "@/lib/shootout-cleanup-core";
import { normalizeTiebreak, type SeasonTiebreak } from "@/lib/standings-mode";

export interface ShootoutCleanupDisplayEntry extends ShootoutCleanupEntry {
  playerAName: string;
  playerBName: string;
  winnerName: string | null;
}

export interface ShootoutCleanupDivision {
  id: string;
  name: string;
  tierName: string;
  tierPosition: number;
  // Every admin-recorded shootout in this division, in the order the
  // matches were created -- both deletable and keep rows, so the page can
  // render one table with a verdict column per row.
  entries: ShootoutCleanupDisplayEntry[];
  deletableCount: number;
}

export interface ShootoutCleanupSummary {
  total: number;
  same: number; // deletable -- lives decides the same way
  livesDisagree: number;
  livesTied: number;
  noLivesData: number;
  playerReported: number;
}

export interface ShootoutCleanupData {
  season: { id: string; label: string; tiebreak: SeasonTiebreak } | null;
  divisions: ShootoutCleanupDivision[];
  // Every deletable entry's id, across every division -- exactly what
  // convertSeasonToLivesTiebreakAction deletes when its button is pressed.
  deletableIds: string[];
  summary: ShootoutCleanupSummary;
}

const EMPTY_SUMMARY: ShootoutCleanupSummary = {
  total: 0,
  same: 0,
  livesDisagree: 0,
  livesTied: 0,
  noLivesData: 0,
  playerReported: 0,
};

export async function loadShootoutCleanup(seasonId: string): Promise<ShootoutCleanupData> {
  const season = await prisma.season.findUnique({
    where: { id: seasonId },
    select: {
      id: true,
      number: true,
      subtitle: true,
      tiebreak: true,
      tiers: {
        orderBy: { position: "asc" },
        select: {
          name: true,
          position: true,
          divisions: {
            orderBy: { groupNumber: "asc" },
            select: {
              id: true,
              name: true,
              members: {
                select: {
                  playerId: true,
                  status: true,
                  player: { select: { id: true, displayName: true } },
                },
              },
              matches: {
                select: {
                  id: true,
                  playerAId: true,
                  playerBId: true,
                  gamesWonA: true,
                  gamesWonB: true,
                  format: true,
                  status: true,
                  winnerId: true,
                  recordedBy: true,
                  createdAt: true,
                  games: { select: { winnerId: true, winnerLives: true } },
                },
              },
            },
          },
        },
      },
    },
  });

  if (!season) {
    return { season: null, divisions: [], deletableIds: [], summary: EMPTY_SUMMARY };
  }

  const divisions: ShootoutCleanupDivision[] = [];
  const summary: ShootoutCleanupSummary = { ...EMPTY_SUMMARY };
  const deletableIds: string[] = [];

  for (const tier of season.tiers) {
    for (const d of tier.divisions) {
      const nameById = new Map(d.members.map((m) => [m.playerId, m.player.displayName]));

      const leagueMatches = d.matches.filter((m) => m.format === "LEAGUE_BO2" && m.status === "CONFIRMED");
      const pairings: PairingWithLives[] = leagueMatches.map((m) => ({
        playerAId: m.playerAId,
        playerBId: m.playerBId,
        gamesWonA: m.gamesWonA,
        gamesWonB: m.gamesWonB,
        games: m.games,
      }));

      const activePlayerIds = d.members.filter((m) => m.status === "ACTIVE").map((m) => m.playerId);
      const netLivesByPlayerId = new Map<string, PlayerNetLives | undefined>();
      for (const playerId of activePlayerIds) {
        netLivesByPlayerId.set(playerId, computeNetLives(playerId, pairings));
      }

      const shootoutMatches = d.matches
        .filter((m) => m.format === "SHOOTOUT_BO1" && m.status === "CONFIRMED")
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      const shootoutInputs: ShootoutCleanupInput[] = shootoutMatches.map((m) => ({
        id: m.id,
        divisionId: d.id,
        playerAId: m.playerAId,
        playerBId: m.playerBId,
        winnerId: m.winnerId,
        recordedBy: m.recordedBy,
      }));

      if (shootoutInputs.length === 0) continue;

      const plan = planShootoutCleanup(shootoutInputs, netLivesByPlayerId);
      const entryById = new Map(
        [...plan.deletable, ...plan.keep].map((e): [string, ShootoutCleanupEntry] => [e.id, e]),
      );

      const entries: ShootoutCleanupDisplayEntry[] = shootoutInputs.map((s) => {
        const entry = entryById.get(s.id)!;
        return {
          ...entry,
          playerAName: nameById.get(entry.playerAId) ?? entry.playerAId,
          playerBName: nameById.get(entry.playerBId) ?? entry.playerBId,
          winnerName: entry.winnerId === null ? null : (nameById.get(entry.winnerId) ?? entry.winnerId),
        };
      });

      for (const e of entries) {
        summary.total++;
        if (e.verdict === "same") summary.same++;
        else if (e.verdict === "lives-disagree") summary.livesDisagree++;
        else if (e.verdict === "lives-tied") summary.livesTied++;
        else if (e.verdict === "no-lives-data") summary.noLivesData++;
        else if (e.verdict === "player-reported") summary.playerReported++;
      }
      deletableIds.push(...plan.deletable.map((e) => e.id));

      divisions.push({
        id: d.id,
        name: d.name,
        tierName: tier.name,
        tierPosition: tier.position,
        entries,
        deletableCount: plan.deletable.length,
      });
    }
  }

  return {
    season: { id: season.id, label: formatSeasonLabel(season), tiebreak: normalizeTiebreak(season.tiebreak) },
    divisions,
    deletableIds,
    summary,
  };
}
