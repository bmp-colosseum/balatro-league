import "server-only";

// "Based on the current season" placement projection — now Owen's real
// algorithm. Returners hold their division with promotion/relegation applied,
// rookies slot in by greatest-lower-bound MMR, and divisions overflow-balance to
// ~ceil(total / #divisions). Every player is on ONE MMR scale (stored secret MMR
// else BMP peak ×1.5) so nobody gets dumped. Pure projection; nothing is written.

import type { Player } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { formatSeasonLabel } from "@/lib/format-season";
import { computeStandings } from "@/lib/standings";
import {
  buildOwenPlacement,
  type ReturnerInput,
  type RookieInput,
  type PlacementDivision,
  type PlacementMember,
} from "@/lib/owen-placement";

export type ContinuityMember = PlacementMember;
export type ContinuityDivision = PlacementDivision;
export interface ContinuityResult {
  divisions: ContinuityDivision[];
  returnerCount: number;
  rookieCount: number;
  basedOnSeason: string;
}

export async function loadContinuityPlacement(roundId: string): Promise<ContinuityResult | "NO_ROUND" | "NO_SEASON"> {
  const round = await prisma.signupRound.findUnique({
    where: { id: roundId },
    include: { signups: { where: { withdrawn: false }, orderBy: { signedUpAt: "asc" } } },
  });
  if (!round) return "NO_ROUND";

  const activeSeason = await prisma.season.findFirst({
    where: { isActive: true },
    include: {
      divisions: {
        orderBy: [{ tier: { position: "asc" } }, { groupNumber: "asc" }],
        include: {
          tier: true,
          members: { where: { status: "ACTIVE" }, include: { player: { select: { id: true, displayName: true } } } },
          matches: {
            where: { status: "CONFIRMED", format: "LEAGUE_BO2" },
            select: { playerAId: true, playerBId: true, gamesWonA: true, gamesWonB: true },
          },
        },
      },
    },
  });
  if (!activeSeason) return "NO_SEASON";

  // playerId -> active-season division index (0 = top).
  const divIndexByPlayer = new Map<string, number>();
  activeSeason.divisions.forEach((d, i) => d.members.forEach((m) => divIndexByPlayer.set(m.playerId, i)));
  const divSizeByIndex = activeSeason.divisions.map((d) => d.members.length);

  // Current standing per player (rank + record) from confirmed matches.
  const standingByPlayer = new Map<string, { rank: number; record: string }>();
  for (const d of activeSeason.divisions) {
    const divPlayers = d.members.map((m) => m.player) as unknown as Player[];
    const rows = computeStandings(divPlayers, d.matches);
    for (const r of rows) {
      if (r.played > 0) standingByPlayer.set(r.player.id, { rank: r.rank ?? 0, record: `${r.wins}-${r.draws}-${r.losses}` });
    }
  }

  const discordIds = round.signups.map((s) => s.discordId);
  const players = await prisma.player.findMany({
    where: { discordId: { in: discordIds } },
    select: { id: true, discordId: true, hiddenMmr: true },
  });
  const playerByDiscord = new Map(players.map((p) => [p.discordId, p]));
  const snaps = discordIds.length
    ? await prisma.playerMmrSnapshot.findMany({
        where: { discordId: { in: discordIds }, rankedMmr: { not: null } },
        orderBy: { capturedAt: "desc" },
        distinct: ["discordId"],
        select: { discordId: true, rankedMmr: true, peakMmr: true },
      })
    : [];
  const peakByDiscord = new Map(snaps.map((s) => [s.discordId, s.peakMmr ?? s.rankedMmr ?? 0]));

  // One consistent MMR scale: stored secret MMR, else BMP peak ×1.5.
  const mmrOf = (discordId: string) => {
    const stored = playerByDiscord.get(discordId)?.hiddenMmr;
    if (stored != null) return stored;
    const peak = peakByDiscord.get(discordId);
    return peak ? Math.round(peak * 1.5) : 0;
  };

  const returners: ReturnerInput[] = [];
  const rookies: RookieInput[] = [];
  for (const s of round.signups) {
    const p = playerByDiscord.get(s.discordId);
    const divIndex = p ? divIndexByPlayer.get(p.id) : undefined;
    if (p && divIndex != null) {
      const standing = standingByPlayer.get(p.id) ?? null;
      const divSize = divSizeByIndex[divIndex] ?? 1;
      returners.push({
        discordId: s.discordId,
        displayName: s.displayName,
        mmr: mmrOf(s.discordId),
        divIndex,
        // No standing (no games) → middle rank so they don't promote/relegate.
        standingRank: standing?.rank ?? Math.max(2, Math.ceil(divSize / 2)),
        divSize,
        standing,
      });
    } else {
      rookies.push({ discordId: s.discordId, displayName: s.displayName, mmr: mmrOf(s.discordId) });
    }
  }

  const targetSize = Math.max(1, Math.ceil(round.signups.length / activeSeason.divisions.length));
  const placed = buildOwenPlacement(
    activeSeason.divisions.map((d) => ({ tierName: d.tier.name, name: d.name })),
    returners,
    rookies,
    targetSize,
  );

  return {
    divisions: placed,
    returnerCount: returners.length,
    rookieCount: rookies.length,
    basedOnSeason: formatSeasonLabel(activeSeason),
  };
}
