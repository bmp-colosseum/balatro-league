import "server-only";

// Per-division "what's at stake" for the active season: feeds each division's
// played + remaining matches and its promote/relegate counts into the playoff
// picture engine. Remaining set respects the schedule format — locked = the
// unplayed assigned pairings; unlocked = every not-yet-played pair.

import { prisma } from "@/lib/prisma";
import { formatSeasonLabel } from "@/lib/format-season";
import { getPlacementRules } from "@/lib/placement-rules";
import { divisionMovement } from "@/lib/owen-placement";
import { isScheduleLocked } from "@/lib/schedule-locked";
import { computePlayoffPicture, type PlayoffPicture } from "@/lib/playoff-picture";

export interface DivisionStake {
  divisionId: string;
  divisionName: string;
  tierName: string;
  tierPosition: number;
  locked: boolean;
  picture: PlayoffPicture;
}
export interface WhatsAtStakeResult {
  seasonLabel: string;
  divisions: DivisionStake[];
}

const pairKey = (a: string, b: string) => (a < b ? `${a}:${b}` : `${b}:${a}`);

export async function loadWhatsAtStake(): Promise<WhatsAtStakeResult | "NO_SEASON"> {
  const season = await prisma.season.findFirst({
    where: { isActive: true },
    include: {
      divisions: {
        orderBy: [{ tier: { position: "asc" } }, { groupNumber: "asc" }],
        include: {
          tier: true,
          members: {
            where: { status: "ACTIVE" },
            include: { player: { select: { id: true, displayName: true } } },
          },
          matches: {
            where: { format: "LEAGUE_BO2" },
            select: { playerAId: true, playerBId: true, gamesWonA: true, gamesWonB: true, status: true },
          },
        },
      },
    },
  });
  if (!season) return "NO_SEASON";

  const rules = await getPlacementRules();
  const ladder = season.divisions.map((d) => ({ tierName: d.tier.name }));
  const sizes = season.divisions.map((d) => d.members.length);
  const movement = divisionMovement(ladder, sizes, {
    tightenTopTiers: rules.tightenTopTiers,
    swapThreshold: rules.swapThreshold,
    baseSwap: rules.baseSwap,
    bigSwap: rules.bigSwap,
  });

  const divisions: DivisionStake[] = season.divisions.map((d, i) => {
    const players = d.members.map((m) => ({ id: m.player.id, displayName: m.player.displayName }));
    const memberIds = new Set(players.map((p) => p.id));
    // Only matches between two current active members (ignore dropped-player rows).
    const bo2 = d.matches.filter((m) => memberIds.has(m.playerAId) && memberIds.has(m.playerBId));

    const played = bo2
      .filter((m) => m.status === "CONFIRMED")
      .map((m) => ({ playerAId: m.playerAId, playerBId: m.playerBId, gamesWonA: m.gamesWonA, gamesWonB: m.gamesWonB }));

    const locked = isScheduleLocked(season.scheduleLocked, bo2);
    let remaining: Array<{ playerAId: string; playerBId: string }>;
    if (locked) {
      // Assigned but not yet decided (PENDING / DISPUTED) pairings.
      remaining = bo2
        .filter((m) => m.status !== "CONFIRMED")
        .map((m) => ({ playerAId: m.playerAId, playerBId: m.playerBId }));
    } else {
      // Full round-robin: every member pair without a confirmed result.
      const playedSet = new Set(played.map((m) => pairKey(m.playerAId, m.playerBId)));
      remaining = [];
      for (let a = 0; a < players.length; a++) {
        for (let b = a + 1; b < players.length; b++) {
          const key = pairKey(players[a]!.id, players[b]!.id);
          if (!playedSet.has(key)) remaining.push({ playerAId: players[a]!.id, playerBId: players[b]!.id });
        }
      }
    }

    const mv = movement[i] ?? { promote: 0, relegate: 0 };
    const picture = computePlayoffPicture({
      players,
      played,
      remaining,
      promote: mv.promote,
      relegate: mv.relegate,
    });
    return { divisionId: d.id, divisionName: d.name, tierName: d.tier.name, tierPosition: d.tier.position, locked, picture };
  });

  return { seasonLabel: formatSeasonLabel(season), divisions };
}
