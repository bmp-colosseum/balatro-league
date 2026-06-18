import "server-only";

// "Based on the current season" placement projection for the preview. Returners
// (signups already in the active season) stay in their current division — Owen's
// continuity rule — and rookies (everyone else) slot into the division whose
// average MMR is the greatest value ≤ their MMR (greatest-lower-bound). Pure
// projection; nothing is written. Promotion/relegation is NOT applied here yet
// (the active season isn't over), so it's "where everyone sits right now + where
// newcomers would land".

import { prisma } from "@/lib/prisma";
import { formatSeasonLabel } from "@/lib/format-season";

export interface ContinuityMember {
  discordId: string;
  displayName: string;
  mmr: number;
  isRookie: boolean;
}
export interface ContinuityDivision {
  tierName: string;
  name: string;
  members: ContinuityMember[];
}
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
        include: { tier: true, members: { where: { status: "ACTIVE" }, select: { playerId: true } } },
      },
    },
  });
  if (!activeSeason) return "NO_SEASON";

  // playerId -> their active-season division id.
  const divByPlayer = new Map<string, string>();
  for (const d of activeSeason.divisions) for (const m of d.members) divByPlayer.set(m.playerId, d.id);

  const discordIds = round.signups.map((s) => s.discordId);
  const players = await prisma.player.findMany({
    where: { discordId: { in: discordIds } },
    select: { id: true, discordId: true, rating: true, hiddenMmr: true },
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

  const isReturner = (discordId: string) => {
    const p = playerByDiscord.get(discordId);
    return !!p && divByPlayer.has(p.id);
  };
  const returners = round.signups.filter((s) => isReturner(s.discordId));
  const rookies = round.signups.filter((s) => !isReturner(s.discordId));

  const divList: ContinuityDivision[] = activeSeason.divisions.map((d) => ({
    tierName: d.tier.name,
    name: d.name,
    members: [],
  }));
  const divIndexById = new Map(activeSeason.divisions.map((d, i) => [d.id, i]));

  // Place returners into their current division.
  for (const s of returners) {
    const p = playerByDiscord.get(s.discordId)!;
    const di = divIndexById.get(divByPlayer.get(p.id)!)!;
    divList[di]!.members.push({ discordId: s.discordId, displayName: s.displayName, mmr: 0, isRookie: false });
  }

  // Use the stored secret MMR. For anyone not seeded yet, fall back to ladder
  // position (Legendary → Common, 2200, 2190 …) so the view stays coherent
  // until they're set on /admin/mmr. Within a division, order by MMR desc.
  const mmrOf = (discordId: string) => playerByDiscord.get(discordId)?.hiddenMmr ?? null;
  let pos = 0;
  for (const d of divList) {
    d.members.sort((a, b) => (mmrOf(b.discordId) ?? -Infinity) - (mmrOf(a.discordId) ?? -Infinity));
    for (const m of d.members) {
      const stored = mmrOf(m.discordId);
      m.mmr = stored != null ? stored : Math.max(0, 2200 - pos * 10);
      pos++;
    }
  }

  // Rookies: MMR ≈ 1.5× peak BMP. Place in the division whose average (returner)
  // MMR is the greatest value ≤ the rookie's MMR; if none qualify (weaker than
  // all), the lowest division.
  const divAvg = divList.map((d) => (d.members.length ? d.members.reduce((a, m) => a + m.mmr, 0) / d.members.length : 0));
  for (const s of rookies) {
    const rookieMmr = Math.round((peakByDiscord.get(s.discordId) ?? 0) * 1.5);
    let bestIdx = divList.length - 1;
    let bestAvg = -Infinity;
    for (let i = 0; i < divList.length; i++) {
      if (divAvg[i]! <= rookieMmr && divAvg[i]! > bestAvg) {
        bestAvg = divAvg[i]!;
        bestIdx = i;
      }
    }
    divList[bestIdx]!.members.push({
      discordId: s.discordId,
      displayName: s.displayName,
      mmr: rookieMmr,
      isRookie: true,
    });
  }

  return {
    divisions: divList,
    returnerCount: returners.length,
    rookieCount: rookies.length,
    basedOnSeason: formatSeasonLabel(activeSeason),
  };
}
