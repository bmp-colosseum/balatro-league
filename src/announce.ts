// Auto-announce confirmed results to a configured Discord channel.
// Caller: anywhere a set transitions to CONFIRMED (web confirm, Discord button confirm, admin override, etc.)
// Sim/auto-play do NOT call this — they'd flood the channel.

import { ChannelType, EmbedBuilder, type TextChannel } from "discord.js";
import { prisma } from "./db.js";
import { tryGetDiscordClient } from "./discord.js";
import { env } from "./env.js";

export async function announceResult(pairingId: string): Promise<void> {
  if (!env.RESULTS_CHANNEL_ID) return;
  const client = tryGetDiscordClient();
  if (!client) return;

  const pairing = await prisma.pairing.findUnique({
    where: { id: pairingId },
    include: { playerA: true, playerB: true, division: true },
  });
  if (!pairing || pairing.status !== "CONFIRMED") return;

  try {
    const channel = await client.channels.fetch(env.RESULTS_CHANNEL_ID);
    if (!channel || channel.type !== ChannelType.GuildText) return;

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

    const embed = new EmbedBuilder()
      .setTitle(title)
      .setDescription(
        `<@${pairing.playerA.discordId}> **${pairing.gamesWonA}–${pairing.gamesWonB}** <@${pairing.playerB.discordId}>\n` +
          `Division: **${pairing.division.name}**`,
      )
      .setColor(color)
      .setFooter({ text: `Set ${pairing.id}` })
      .setTimestamp(new Date());

    await (channel as TextChannel).send({ embeds: [embed] });
  } catch (err) {
    console.warn("Failed to announce result:", err);
  }
}
