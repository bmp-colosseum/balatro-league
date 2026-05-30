// Auto-announce a confirmed pairing to the configured Discord channel via REST.
// Skips INTERNAL seasons so test data doesn't flood the channel.

import { prisma } from "@/lib/prisma";
import { postChannelMessage } from "@/lib/discord";

export async function announceResult(pairingId: string): Promise<void> {
  if (!process.env.RESULTS_CHANNEL_ID) return;
  const pairing = await prisma.pairing.findUnique({
    where: { id: pairingId },
    include: { playerA: true, playerB: true, division: { include: { season: true } } },
  });
  if (!pairing || pairing.status !== "CONFIRMED") return;
  if (pairing.division.season.visibility !== "PUBLIC") return;

  let title: string;
  let color: number;
  if (pairing.gamesWonA === 2 && pairing.gamesWonB === 0) {
    title = `🏆 ${pairing.playerA.displayName} swept ${pairing.playerB.displayName}`;
    color = 0x2ecc71;
  } else if (pairing.gamesWonB === 2 && pairing.gamesWonA === 0) {
    title = `🏆 ${pairing.playerB.displayName} swept ${pairing.playerA.displayName}`;
    color = 0x2ecc71;
  } else {
    title = `🤝 ${pairing.playerA.displayName} 1-1 ${pairing.playerB.displayName}`;
    color = 0xf1c40f;
  }

  await postChannelMessage(process.env.RESULTS_CHANNEL_ID, {
    embeds: [
      {
        title,
        description:
          `<@${pairing.playerA.discordId}> **${pairing.gamesWonA}–${pairing.gamesWonB}** <@${pairing.playerB.discordId}>\n` +
          `Division: **${pairing.division.name}**`,
        color,
        footer: { text: `Set ${pairing.id}` },
        timestamp: new Date().toISOString(),
      },
    ],
  });
}
