// Seed a CLOSED signup round + N fake signups (with MMR snapshots) so you can
// test the BUILD FLOW (/admin/signups/[id]/build → drag into divisions → Build
// → Activate) without manually opening signups and signing up accounts.
// API-driven (ADMIN_TOKEN), no host shell. Test env only.

import { prisma } from "@/lib/prisma";

const ROUND_NAME_PREFIX = "Seed test signups";
const SIGNUP_DISCORD_PREFIX = "seed-signup-";

// Small name pool so the build UI looks like real people, not "Player 1..N".
const NAMES = [
  "Ace", "Bree", "Cy", "Dot", "Echo", "Fox", "Gus", "Hex", "Ivy", "Jet",
  "Kit", "Lux", "Moss", "Nyx", "Opal", "Pip", "Quill", "Rae", "Sage", "Tate",
  "Uma", "Vex", "Wren", "Yuki", "Zed",
];

export interface SeedSignupsOpts {
  count?: number;
  reset?: boolean;
}

export async function runSeedSignups(
  opts: SeedSignupsOpts,
): Promise<{ roundId: string; count: number; buildPath: string }> {
  const count = Math.max(2, Math.min(200, Math.floor(opts.count ?? 24)));

  if (opts.reset) {
    // Drop prior seeded rounds (signups cascade) + their MMR snapshots so
    // re-runs stay clean. Scoped to the seed prefixes — never touches real data.
    const prior = await prisma.signupRound.findMany({
      where: { name: { startsWith: ROUND_NAME_PREFIX } },
      select: { id: true },
    });
    if (prior.length > 0) {
      await prisma.signupRound.deleteMany({ where: { id: { in: prior.map((r) => r.id) } } });
    }
    await prisma.playerMmrSnapshot.deleteMany({
      where: { discordId: { startsWith: SIGNUP_DISCORD_PREFIX } },
    });
  }

  // CLOSED round → the build page treats it as ready to build right away.
  const round = await prisma.signupRound.create({
    data: {
      name: `${ROUND_NAME_PREFIX} (${count})`,
      guildId: "seed-test-guild",
      channelId: "seed-test-channel",
      messageId: "pending",
      status: "CLOSED",
      closedAt: new Date(),
    },
  });

  const signups = Array.from({ length: count }, (_, i) => ({
    roundId: round.id,
    discordId: `${SIGNUP_DISCORD_PREFIX}${i}`,
    displayName: `${NAMES[i % NAMES.length]}${Math.floor(i / NAMES.length) || ""}`,
  }));
  await prisma.signup.createMany({ data: signups, skipDuplicates: true });

  // MMR snapshots so the build UI's seeding-signal column has data to sort by.
  // Pseudo-spread across 250..749, deterministic by index so re-runs are stable.
  await prisma.playerMmrSnapshot.createMany({
    data: signups.map((s, i) => ({
      discordId: s.discordId,
      rankedMmr: 250 + ((i * 73) % 500),
      source: "seed",
    })),
  });

  return { roundId: round.id, count, buildPath: `/admin/signups/${round.id}/build` };
}
