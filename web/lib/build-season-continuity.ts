import "server-only";

// Build (or populate) a real season from the "Based on current season"
// continuity projection, including any hand-moves. The client sends only the
// MOVES; the server re-runs the canonical placement, applies them, and writes a
// DRAFT season on Owen's ladder. Leaves isActive:false — activation is separate.
//
// Two modes, auto-detected (mirrors buildSeasonFromRound):
//   - CREATE: the round has no resultingSeasonId yet → make a new draft season.
//   - POPULATE: the round was opened from a season (resultingSeasonId pre-set)
//     and that season is still a DRAFT → wipe its structure and rebuild it from
//     the projection. A LIVE/ended season is never touched (returns ALREADY_BUILT).

import { prisma } from "@/lib/prisma";
import { placePlayerInDivision } from "@/lib/division-membership";
import { recordAudit, type AuditActor } from "@/lib/audit";
import { formatSeasonLabel, nextSeasonNumber } from "@/lib/format-season";
import { loadContinuityPlacement } from "@/lib/loaders/continuity";

export interface BuildContinuityInput {
  roundId: string;
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
  mode: "create" | "populate";
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

  // Upsert a Player for every signup.
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

  // Resolve the target season: create new, or populate an existing DRAFT.
  let targetSeasonId: string;
  let number: number;
  let mode: "create" | "populate";

  if (round.resultingSeasonId) {
    const existing = await prisma.season.findUnique({
      where: { id: round.resultingSeasonId },
      select: { id: true, number: true, isActive: true, endedAt: true },
    });
    if (existing && (existing.isActive || existing.endedAt)) {
      return "ALREADY_BUILT"; // never rebuild a live/finished season
    }
    if (existing) {
      // Existing DRAFT → wipe its structure and repopulate (children first).
      mode = "populate";
      targetSeasonId = existing.id;
      number = existing.number;
      await prisma.divisionMember.deleteMany({ where: { seasonId: targetSeasonId } });
      await prisma.division.deleteMany({ where: { seasonId: targetSeasonId } });
      await prisma.tier.deleteMany({ where: { seasonId: targetSeasonId } });
      if (input.subtitle !== undefined) {
        await prisma.season.update({ where: { id: targetSeasonId }, data: { subtitle: input.subtitle ?? null } });
      }
    } else {
      // Dangling pointer → make a fresh season.
      mode = "create";
      number = await nextSeasonNumber(prisma);
      const season = await prisma.season.create({
        data: { number, subtitle: input.subtitle ?? null, isActive: false, targetGroupSize: 5, minGroupSize: 3 },
      });
      targetSeasonId = season.id;
    }
  } else {
    mode = "create";
    number = await nextSeasonNumber(prisma);
    const season = await prisma.season.create({
      data: { number, subtitle: input.subtitle ?? null, isActive: false, targetGroupSize: 5, minGroupSize: 3 },
    });
    targetSeasonId = season.id;
  }

  // Owen-ladder tiers (in order) + divisions on the target season.
  const tierOrder: string[] = [];
  for (const d of divs) if (!tierOrder.includes(d.tierName)) tierOrder.push(d.tierName);
  const tierIdByName = new Map<string, string>();
  for (let i = 0; i < tierOrder.length; i++) {
    const t = await prisma.tier.create({ data: { seasonId: targetSeasonId, position: i + 1, name: tierOrder[i]! } });
    tierIdByName.set(tierOrder[i]!, t.id);
  }
  const divisionIdByIndex = new Map<number, string>();
  const groupCounter = new Map<string, number>();
  for (let idx = 0; idx < n; idx++) {
    const d = divs[idx]!;
    const g = (groupCounter.get(d.tierName) ?? 0) + 1;
    groupCounter.set(d.tierName, g);
    const division = await prisma.division.create({
      data: { seasonId: targetSeasonId, tierId: tierIdByName.get(d.tierName)!, groupNumber: g, name: d.name },
    });
    divisionIdByIndex.set(idx, division.id);
  }

  // Place every player into their effective (possibly hand-moved) division.
  let placed = 0;
  for (const discordId of computedByDiscord.keys()) {
    const player = playerByDiscordId.get(discordId);
    if (!player) continue;
    const divisionId = divisionIdByIndex.get(effectiveIdx(discordId));
    if (!divisionId) continue;
    await placePlayerInDivision(divisionId, player.id);
    placed++;
  }

  // Link the draft to the round, but DON'T mark it BUILT — creating/refreshing
  // an editable draft to arrange it must NOT close Discord sign-ups (the Sign Up
  // button disables the moment status != OPEN). Sign-ups close when the admin
  // closes them / at activation, not when you open the arranger.
  await prisma.signupRound.update({
    where: { id: roundId },
    data: { resultingSeasonId: targetSeasonId },
  });

  recordAudit({
    actor,
    action: "season.build",
    targetType: "Season",
    targetId: targetSeasonId,
    summary: `${mode === "populate" ? "Populated" : "Built"} ${formatSeasonLabel({ number, subtitle: input.subtitle ?? null })} from the continuity preview (${n} divisions, ${placed} placed, ${handMoved} hand-moved)`,
    metadata: { roundId, signupCount: players.length, handMoved, mode, source: "continuity" },
  });

  return { seasonId: targetSeasonId, seasonNumber: number, divisionCount: n, playersPlaced: placed, handMoved, mode };
}
