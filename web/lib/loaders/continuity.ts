import "server-only";

// "Based on the current season" placement projection — Owen's real algorithm,
// built onto his FIXED ladder (Legendary + Rare/Unc/Common, sized to the signup
// count), not the current season's shape. Each returner's current division maps
// onto the ladder (promotion/relegation applied), rookies slot in by
// greatest-lower-bound MMR, divisions overflow-balance to ~ceil(total/#divs), and
// the floor protects returners from being dropped. One MMR scale (stored secret
// MMR else BMP peak ×1.5). Pure projection; nothing is written.

import type { Player } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { formatSeasonLabel, formatDivisionName } from "@/lib/format-season";
import { owenLadder } from "@/lib/season-plan";
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

  // Build the NEXT season on Owen's fixed ladder (Legendary + Rare/Unc/Common,
  // sized to the signup count) — not the current season's shape. Map each active
  // division onto the ladder by tier + position, clamping extra divisions onto
  // the tier's last slot (e.g. an old Rare 6 → Owen Rare 5). This consolidates a
  // mismatched current structure into the clean ladder.
  const ladder = owenLadder(round.signups.length);
  const owenDivs: { tierName: string; name: string }[] = [];
  const owenIndexByTierPos = new Map<string, number>();
  const owenTierCount = new Map<string, number>();
  for (const t of ladder) {
    owenTierCount.set(t.name, t.divisionCount);
    for (let g = 1; g <= t.divisionCount; g++) {
      owenIndexByTierPos.set(`${t.name}:${g}`, owenDivs.length);
      owenDivs.push({ tierName: t.name, name: formatDivisionName(t.name, g, t.divisionCount) });
    }
  }
  const owenIndexForActive = activeSeason.divisions.map((d) => {
    const cnt = owenTierCount.get(d.tier.name);
    if (cnt == null) return owenDivs.length - 1; // tier not on the ladder → bottom
    return owenIndexByTierPos.get(`${d.tier.name}:${Math.min(d.groupNumber, cnt)}`) ?? owenDivs.length - 1;
  });

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
  // BMP ranked MMR, shown alongside the internal MMR for sanity-checking.
  const bmpByDiscord = new Map(snaps.map((s) => [s.discordId, s.rankedMmr ?? s.peakMmr ?? null]));

  // One consistent MMR scale: stored secret MMR, else BMP peak ×1.5.
  // Stored MMR, else BMP peak ×1.5, else the base seed (BMP base 200 × 1.5 = 300).
  const mmrOf = (discordId: string) => {
    const stored = playerByDiscord.get(discordId)?.hiddenMmr;
    if (stored != null) return stored;
    const peak = peakByDiscord.get(discordId);
    return peak ? Math.round(peak * 1.5) : 300;
  };

  const returners: ReturnerInput[] = [];
  const rookies: RookieInput[] = [];
  for (const s of round.signups) {
    const p = playerByDiscord.get(s.discordId);
    const activeIndex = p ? divIndexByPlayer.get(p.id) : undefined;
    if (p && activeIndex != null) {
      const standing = standingByPlayer.get(p.id) ?? null;
      const divSize = divSizeByIndex[activeIndex] ?? 1;
      returners.push({
        discordId: s.discordId,
        displayName: s.displayName,
        mmr: mmrOf(s.discordId),
        // Their current division mapped onto Owen's ladder.
        divIndex: owenIndexForActive[activeIndex] ?? owenDivs.length - 1,
        // No standing (no games) → middle rank so they don't promote/relegate.
        standingRank: standing?.rank ?? Math.max(2, Math.ceil(divSize / 2)),
        divSize,
        standing,
        bmp: bmpByDiscord.get(s.discordId) ?? null,
      });
    } else {
      rookies.push({
        discordId: s.discordId,
        displayName: s.displayName,
        mmr: mmrOf(s.discordId),
        bmp: bmpByDiscord.get(s.discordId) ?? null,
      });
    }
  }

  // Legendary is a fixed top of 6 (elite round-robin); the rest split evenly.
  const TOP_TARGET = 6;
  const restDivs = Math.max(1, owenDivs.length - 1);
  const targetSize = Math.max(1, Math.ceil(Math.max(0, round.signups.length - TOP_TARGET) / restDivs));
  const placed = buildOwenPlacement(owenDivs, returners, rookies, targetSize, TOP_TARGET);

  return {
    divisions: placed,
    returnerCount: returners.length,
    rookieCount: rookies.length,
    basedOnSeason: formatSeasonLabel(activeSeason),
  };
}
