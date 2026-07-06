import "server-only";

// "Based on the current season" placement projection — Owen's real algorithm,
// built onto his FIXED ladder (Legendary + Rare/Unc/Common, sized to the signup
// count), not the current season's shape. Each returner's current division maps
// onto the ladder (promotion/relegation applied), rookies slot in by
// greatest-lower-bound MMR, divisions overflow-balance to ~ceil(total/#divs), and
// the floor protects returners from being dropped. One MMR scale (stored hidden
// MMR else BMP peak ×1.5). Pure projection; nothing is written.

import type { Player } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { formatSeasonLabel, formatDivisionName } from "@/lib/format-season";
import { owenLadder } from "@/lib/season-plan";
import { computeStandings } from "@/lib/standings";
import { getPlacementRules } from "@/lib/placement-rules";
import { isActiveBan, nextSeasonNumber } from "@/lib/bans";
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
            // Both BO2 league matches AND the BO1 showdown/shootout tiebreakers,
            // so standings reflect who actually won the tiebreaker (e.g. Toying
            // beating Piton in the showdown promotes Toying, not the alphabetical
            // fallback). Split by format below.
            where: { status: "CONFIRMED", format: { in: ["LEAGUE_BO2", "SHOOTOUT_BO1"] } },
            select: { playerAId: true, playerBId: true, gamesWonA: true, gamesWonB: true, winnerId: true, format: true },
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
    const bo2 = d.matches.filter((m) => m.format === "LEAGUE_BO2");
    const shootouts = d.matches
      .filter((m) => m.format === "SHOOTOUT_BO1" && m.winnerId)
      .map((m) => ({ playerAId: m.playerAId, playerBId: m.playerBId, winnerId: m.winnerId! }));
    const rows = computeStandings(divPlayers, bo2, shootouts);
    for (const r of rows) {
      if (r.played > 0) standingByPlayer.set(r.player.id, { rank: r.rank ?? 0, record: `${r.wins}-${r.draws}-${r.losses}` });
    }
  }

  const discordIds = round.signups.map((s) => s.discordId);
  const [players, nextSeason] = await Promise.all([
    prisma.player.findMany({
      where: { discordId: { in: discordIds } },
      select: { id: true, discordId: true, hiddenMmr: true, bannedAt: true, banLiftsAtSeasonNumber: true },
    }),
    nextSeasonNumber(),
  ]);
  const playerByDiscord = new Map(players.map((p) => [p.discordId, p]));
  // ALL snapshots (every BMP season), not just the latest — peak is per-season,
  // so the all-time peak = max peakMmr across all of them.
  const allSnaps = discordIds.length
    ? await prisma.playerMmrSnapshot.findMany({
        where: { discordId: { in: discordIds }, rankedMmr: { not: null } },
        orderBy: { capturedAt: "desc" },
        select: { discordId: true, rankedMmr: true, peakMmr: true },
      })
    : [];
  // Per player: current ranked MMR (latest snapshot) + all-time peak (max across seasons).
  const peakByDiscord = new Map<string, number>();
  const bmpByDiscord = new Map<string, number | null>();
  for (const s of allSnaps) {
    if (!bmpByDiscord.has(s.discordId)) {
      // First seen = latest (ordered desc) → current ranked MMR.
      bmpByDiscord.set(s.discordId, s.rankedMmr ?? s.peakMmr ?? null);
    }
    const prev = peakByDiscord.get(s.discordId) ?? 0;
    const cand = Math.max(s.peakMmr ?? 0, s.rankedMmr ?? 0);
    if (cand > prev) peakByDiscord.set(s.discordId, cand);
  }

  // One consistent MMR scale: stored hidden MMR, else BMP peak ×1.5.
  // Stored MMR, else BMP peak ×1.5, else the base seed (BMP base 200 × 1.5 = 300).
  const mmrOf = (discordId: string) => {
    const stored = playerByDiscord.get(discordId)?.hiddenMmr;
    if (stored != null) return stored;
    const peak = peakByDiscord.get(discordId);
    return peak ? Math.round(peak * 1.5) : 300;
  };

  // GAP RETURNERS: signups who are NOT in the active season but who played a
  // PRIOR one. Place them at their MOST RECENT division finish (however many
  // seasons back) so relegation sticks across a gap — buildOwenPlacement then
  // applies promotion/relegation from that finish just like a normal returner
  // (a bottom finisher comes back one division lower). Only runs if such players
  // exist, so a normal build pays nothing.
  // Anyone with ANY membership in the active season (incl. DROPPED) is NOT a gap
  // returner — the active season's divisions query is ACTIVE-only, so pull all
  // statuses here so a dropped-then-resigned player keeps their normal handling.
  const activeSeasonMembers = await prisma.divisionMember.findMany({
    where: { division: { seasonId: activeSeason.id } },
    select: { playerId: true },
  });
  const activePlayerIds = new Set(activeSeasonMembers.map((m) => m.playerId));
  const gapIds = [
    ...new Set(
      round.signups
        .map((s) => playerByDiscord.get(s.discordId)?.id)
        .filter((id): id is string => !!id && !activePlayerIds.has(id)),
    ),
  ];
  const gapReturner = new Map<string, { owenIndex: number; standingRank: number; divSize: number; standing: { rank: number; record: string } | null }>();
  if (gapIds.length) {
    // Their memberships across ENDED seasons, newest season first.
    const priorMemberships = await prisma.divisionMember.findMany({
      where: { playerId: { in: gapIds }, division: { season: { isActive: false } } },
      select: {
        playerId: true,
        division: { select: { id: true, groupNumber: true, tier: { select: { name: true } }, season: { select: { number: true } } } },
      },
      orderBy: [{ division: { season: { number: "desc" } } }, { divisionId: "asc" }],
    });
    const lastDivByPlayer = new Map<string, { divisionId: string; tierName: string; groupNumber: number }>();
    for (const m of priorMemberships) {
      if (lastDivByPlayer.has(m.playerId)) continue; // first seen = most recent (ordered desc)
      lastDivByPlayer.set(m.playerId, { divisionId: m.division.id, tierName: m.division.tier.name, groupNumber: m.division.groupNumber });
    }
    // Compute each relevant old division's standings once.
    const oldDivIds = [...new Set([...lastDivByPlayer.values()].map((d) => d.divisionId))];
    const oldDivs = oldDivIds.length
      ? await prisma.division.findMany({
          where: { id: { in: oldDivIds } },
          select: {
            id: true,
            members: { where: { status: "ACTIVE" }, select: { player: { select: { id: true, displayName: true } } } },
            matches: {
              where: { status: "CONFIRMED", format: { in: ["LEAGUE_BO2", "SHOOTOUT_BO1"] } },
              select: { playerAId: true, playerBId: true, gamesWonA: true, gamesWonB: true, winnerId: true, format: true },
            },
          },
        })
      : [];
    const oldStanding = new Map<string, Map<string, { rank: number; record: string }>>();
    const oldDivSize = new Map<string, number>();
    for (const d of oldDivs) {
      oldDivSize.set(d.id, d.members.length);
      const divPlayers = d.members.map((m) => m.player) as unknown as Player[];
      const bo2 = d.matches.filter((m) => m.format === "LEAGUE_BO2");
      const shoot = d.matches
        .filter((m) => m.format === "SHOOTOUT_BO1" && m.winnerId)
        .map((m) => ({ playerAId: m.playerAId, playerBId: m.playerBId, winnerId: m.winnerId! }));
      const rows2 = computeStandings(divPlayers, bo2, shoot);
      const map = new Map<string, { rank: number; record: string }>();
      for (const r of rows2) if (r.played > 0) map.set(r.player.id, { rank: r.rank ?? 0, record: `${r.wins}-${r.draws}-${r.losses}` });
      oldStanding.set(d.id, map);
    }
    for (const [pid, last] of lastDivByPlayer) {
      const cnt = owenTierCount.get(last.tierName);
      const owenIndex =
        cnt == null ? owenDivs.length - 1 : owenIndexByTierPos.get(`${last.tierName}:${Math.min(last.groupNumber, cnt)}`) ?? owenDivs.length - 1;
      const divSize = oldDivSize.get(last.divisionId) ?? 1;
      const standing = oldStanding.get(last.divisionId)?.get(pid) ?? null;
      gapReturner.set(pid, { owenIndex, standingRank: standing?.rank ?? Math.max(2, Math.ceil(divSize / 2)), divSize, standing });
    }
  }

  const returners: ReturnerInput[] = [];
  const rookies: RookieInput[] = [];
  for (const s of round.signups) {
    const p = playerByDiscord.get(s.discordId);
    if (p && isActiveBan(p, nextSeason)) continue; // banned players are never projected / placed
    const activeIndex = p ? divIndexByPlayer.get(p.id) : undefined;
    const gap = p && activeIndex == null ? gapReturner.get(p.id) : undefined;
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
    } else if (gap) {
      // Gap returner: placed at their most recent division finish (relegation
      // from that finish is applied by buildOwenPlacement, same as a returner).
      returners.push({
        discordId: s.discordId,
        displayName: s.displayName,
        mmr: mmrOf(s.discordId),
        divIndex: gap.owenIndex,
        standingRank: gap.standingRank,
        divSize: gap.divSize,
        standing: gap.standing,
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

  // Configurable rules (top fixed size, tighten-top-tiers); rest split evenly.
  const rules = await getPlacementRules();
  const topTarget = rules.topFixedSize > 0 ? rules.topFixedSize : undefined;
  const reserved = topTarget ?? 0;
  const restDivs = Math.max(1, owenDivs.length - 1);
  const targetSize = Math.max(1, Math.ceil(Math.max(0, round.signups.length - reserved) / restDivs));
  const placed = buildOwenPlacement(owenDivs, returners, rookies, targetSize, {
    topTarget,
    tightenTopTiers: rules.tightenTopTiers,
    swapThreshold: rules.swapThreshold,
    baseSwap: rules.baseSwap,
    bigSwap: rules.bigSwap,
  });

  return {
    divisions: placed,
    returnerCount: returners.length,
    rookieCount: rookies.length,
    basedOnSeason: formatSeasonLabel(activeSeason),
  };
}
