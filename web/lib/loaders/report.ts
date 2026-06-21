// Loader for the /report page. Returns:
//   - The player record (or null if they don't have one yet)
//   - Their active division + reportable opponents (filtered: hides
//     opponents we've already confirmed against, keeps PENDING ones
//     visible with a "(already pending)" tag in the select)
//   - The 10 most recent confirmed/disputed matches in the active
//     season — for inline dispute affordances
//
// Three queries when the player has an active division:
//   1. player lookup
//   2. membership + division metadata + ACTIVE members
//   3. only the viewing player's own pairings (status + recent list)
// Combined when possible (recent + pairing-set come from the same
// pairing table; we do one findMany and partition in JS).

import { prisma } from "@/lib/prisma";
import { isScheduleLocked } from "@/lib/schedule-locked";
import { formatSeasonLabel } from "@/lib/format-season";

export interface ReportOpponent {
  playerId: string;
  displayName: string;
  alreadyPending: boolean;
}

export interface ReportRecentMatch {
  pairingId: string;
  status: "CONFIRMED" | "DISPUTED";
  date: Date | null;
  opponentPlayerId: string;
  opponentDisplayName: string;
  opponentDiscordId: string;
  opponentUsername: string | null;
  myGames: number;
  opponentGames: number;
  outcome: "WIN" | "DRAW" | "LOSS";
}

export interface ReportDivisionContext {
  divisionId: string;
  divisionName: string;
  seasonName: string;
  tierName: string;
  tierPosition: number;
  reportableOpponents: ReportOpponent[];
}

export interface ReportPageData {
  player: { id: string; discordId: string; displayName: string } | null;
  division: ReportDivisionContext | null;
  recentMatches: ReportRecentMatch[];
}

const RECENT_MATCH_LIMIT = 10;

export async function loadReportPageData(discordId: string): Promise<ReportPageData> {
  const player = await prisma.player.findUnique({
    where: { discordId },
    select: { id: true, discordId: true, displayName: true },
  });
  if (!player) return { player: null, division: null, recentMatches: [] };

  const membership = await prisma.divisionMember.findFirst({
    where: {
      playerId: player.id,
      status: "ACTIVE",
      division: { season: { isActive: true } },
    },
    select: {
      division: {
        select: {
          id: true,
          name: true,
          tier: { select: { name: true, position: true } },
          season: { select: { number: true, subtitle: true, scheduleLocked: true } },
          members: {
            where: { status: "ACTIVE" },
            select: { playerId: true, player: { select: { displayName: true } } },
          },
        },
      },
    },
  });
  if (!membership) {
    return { player, division: null, recentMatches: [] };
  }
  const div = membership.division;

  // Pull the player's own pairings ONCE. Used twice:
  //   - to compute confirmedOpponentIds / pendingOpponentIds (any status)
  //   - to render the recent-matches list (CONFIRMED + DISPUTED only,
  //     newest first, top 10)
  const myPairings = await prisma.match.findMany({
    where: {
      divisionId: div.id,
      format: "LEAGUE_BO2",
      OR: [{ playerAId: player.id }, { playerBId: player.id }],
    },
    select: {
      id: true,
      status: true,
      playerAId: true,
      playerBId: true,
      gamesWonA: true,
      gamesWonB: true,
      confirmedAt: true,
      playerA: { select: { id: true, displayName: true, discordId: true, username: true } },
      playerB: { select: { id: true, displayName: true, discordId: true, username: true } },
    },
    orderBy: { confirmedAt: "desc" },
  });

  const confirmedOpponentIds = new Set<string>();
  const pendingOpponentIds = new Set<string>();
  const assignedOpponentIds = new Set<string>(); // any status = on your schedule
  // Flag OR a pre-created 0-0 PENDING match (robust against a stale flag).
  const scheduleLocked = isScheduleLocked(div.season.scheduleLocked, myPairings);
  for (const p of myPairings) {
    const opp = p.playerAId === player.id ? p.playerBId : p.playerAId;
    assignedOpponentIds.add(opp);
    if (p.status === "CONFIRMED") confirmedOpponentIds.add(opp);
    else if (p.status === "PENDING") pendingOpponentIds.add(opp);
  }
  // Opponents you still owe a result. With a locked schedule that's your ASSIGNED,
  // not-yet-confirmed opponents; otherwise the full round-robin (legacy on-demand).
  const reportableOpponents: ReportOpponent[] = div.members
    .filter(
      (m) =>
        m.playerId !== player.id &&
        !confirmedOpponentIds.has(m.playerId) &&
        (!scheduleLocked || assignedOpponentIds.has(m.playerId)),
    )
    .map((m) => ({
      playerId: m.playerId,
      displayName: m.player.displayName,
      alreadyPending: pendingOpponentIds.has(m.playerId),
    }));

  const recentMatches: ReportRecentMatch[] = myPairings
    .filter((p) => p.status === "CONFIRMED" || p.status === "DISPUTED")
    .slice(0, RECENT_MATCH_LIMIT)
    .map((p) => {
      const meIsA = p.playerAId === player.id;
      const opp = meIsA ? p.playerB : p.playerA;
      const myGames = meIsA ? p.gamesWonA : p.gamesWonB;
      const oppGames = meIsA ? p.gamesWonB : p.gamesWonA;
      const outcome: ReportRecentMatch["outcome"] =
        myGames > oppGames ? "WIN" : myGames < oppGames ? "LOSS" : "DRAW";
      return {
        pairingId: p.id,
        status: p.status === "DISPUTED" ? "DISPUTED" : "CONFIRMED",
        date: p.confirmedAt,
        opponentPlayerId: opp.id,
        opponentDisplayName: opp.displayName,
        opponentDiscordId: opp.discordId,
        opponentUsername: opp.username,
        myGames,
        opponentGames: oppGames,
        outcome,
      };
    });

  return {
    player,
    division: {
      divisionId: div.id,
      divisionName: div.name,
      seasonName: formatSeasonLabel(div.season),
      tierName: div.tier.name,
      tierPosition: div.tier.position,
      reportableOpponents,
    },
    recentMatches,
  };
}
