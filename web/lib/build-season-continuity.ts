import "server-only";

// Build a real season from the "Based on current season" continuity preview,
// including any hand-moves an admin made in the editable view.
//
// The client sends only the MOVES (discordId -> chosen division index) — the
// diff. The server re-runs the canonical placement (loadContinuityPlacement),
// applies the moves on top, then CREATEs a draft season on Owen's ladder
// (Legendary + Rare/Unc/Common) and places everyone. Leaves isActive:false —
// activation is the separate, existing step. This mirrors buildSeasonFromRound
// but takes the arrangement from the preview instead of planByRating.

import { prisma } from "@/lib/prisma";
import { placePlayerInDivision } from "@/lib/division-membership";
import { recordAudit, type AuditActor } from "@/lib/audit";
import { formatSeasonLabel, nextSeasonNumber } from "@/lib/format-season";
import { loadContinuityPlacement } from "@/lib/loaders/continuity";

export interface BuildContinuityInput {
  roundId: string;
  // discordId -> hand-assigned division index (0 = top). Overrides the
  // algorithm's placement for that player. Anyone absent keeps their computed
  // division.
  moves: Record<string, number>;
  subtitle?: string | null;
  actor: AuditActor;
}

export interface BuildContinuityResult {
  seasonId: string;
  seasonNumber: number;
  divisionCount: number;
  playersPlaced: number;
  handMoved: number;
}

export async function buildSeasonFromContinuity(
  input: BuildContinuityInput,
): Promise<BuildContinuityResult | null | "NO_SEASON" | "ALREADY_BUILT"> {
  const { roundId, moves, actor } = input;
  if (!roundId) return null;

  const placement = await loadContinuityPlacement(roundId);
  if (placement === "NO_ROUND") return null;
  if (placement === "NO_SEASON") return "NO_SEASON";

  const round = await prisma.signupRound.findUnique({
    where: { id: roundId },
    include: { signups: { where: { withdrawn: false } } },
  });
  if (!round) return null;
  if (round.resultingSeasonId) return "ALREADY_BUILT";

  // Upsert a Player for every signup (same as the rating-based build).
  const players = await Promise.all(
    round.signups.map((s) =>
      prisma.player.upsert({
        where: { discordId: s.discordId },
        create: { discordId: s.discordId, displayName: s.displayName },
        update: { displayName: s.displayName },
      }),
    ),
  );
  const playerByDiscordId = new Map(players.map((p) => [p.discordId, p]));

  const divs = placement.divisions; // ordered top-down (0 = Legendary)
  const n = divs.length;

  // Computed division index per player, then apply hand-moves (clamped to range).
  const computedByDiscord = new Map<string, number>();
  divs.forEach((d, idx) => d.members.forEach((m) => computedByDiscord.set(m.discordId, idx)));
  const effectiveIdx = (discordId: string) => {
    const mv = moves[discordId];
    const idx = mv != null ? mv : computedByDiscord.get(discordId) ?? n - 1;
    return Math.max(0, Math.min(n - 1, idx));
  };
  const handMoved = [...computedByDiscord.keys()].filter(
    (id) => effectiveIdx(id) !== computedByDiscord.get(id),
  ).length;

  // Tiers in ladder order (Legendary, Rare, Uncommon, Common).
  const tierOrder: string[] = [];
  for (const d of divs) if (!tierOrder.includes(d.tierName)) tierOrder.push(d.tierName);

  // CREATE a draft season (activation is separate, as in the normal build).
  const number = await nextSeasonNumber(prisma);
  const season = await prisma.season.create({
    data: { number, subtitle: input.subtitle ?? null, isActive: false, targetGroupSize: 5, minGroupSize: 3 },
  });

  const tierIdByName = new Map<string, string>();
  for (let i = 0; i < tierOrder.length; i++) {
    const t = await prisma.tier.create({ data: { seasonId: season.id, position: i + 1, name: tierOrder[i]! } });
    tierIdByName.set(tierOrder[i]!, t.id);
  }
  const divisionIdByIndex = new Map<number, string>();
  const groupCounter = new Map<string, number>();
  for (let idx = 0; idx < n; idx++) {
    const d = divs[idx]!;
    const g = (groupCounter.get(d.tierName) ?? 0) + 1;
    groupCounter.set(d.tierName, g);
    const division = await prisma.division.create({
      data: { seasonId: season.id, tierId: tierIdByName.get(d.tierName)!, groupNumber: g, name: d.name },
    });
    divisionIdByIndex.set(idx, division.id);
  }

  // Place every placed player into their effective (possibly hand-moved) division.
  let placed = 0;
  for (const discordId of computedByDiscord.keys()) {
    const player = playerByDiscordId.get(discordId);
    if (!player) continue;
    const divisionId = divisionIdByIndex.get(effectiveIdx(discordId));
    if (!divisionId) continue;
    await placePlayerInDivision(divisionId, player.id);
    placed++;
  }

  await prisma.signupRound.update({
    where: { id: roundId },
    data: { status: "BUILT", resultingSeasonId: season.id },
  });

  recordAudit({
    actor,
    action: "season.build",
    targetType: "Season",
    targetId: season.id,
    summary: `Built ${formatSeasonLabel({ number, subtitle: input.subtitle ?? null })} from the continuity preview (${n} divisions, ${placed} placed, ${handMoved} hand-moved)`,
    metadata: { roundId, signupCount: players.length, handMoved, source: "continuity" },
  });

  return { seasonId: season.id, seasonNumber: number, divisionCount: n, playersPlaced: placed, handMoved };
}
