import { MessageFlags, type ButtonInteraction } from "discord.js";
import { prisma } from "../db.js";
import { signupButtons, signupEmbed } from "../signup.js";
import type { ButtonHandler } from "./types.js";

// Re-fetch the round + signups, then edit the original message in place so the count and list
// always match DB state, even if multiple users click at once.
async function refreshSignupMessage(roundId: string, interaction: ButtonInteraction) {
  const round = await prisma.signupRound.findUnique({ where: { id: roundId } });
  if (!round) return;
  const signups = await prisma.signup.findMany({
    where: { roundId },
    orderBy: { signedUpAt: "asc" },
  });
  await interaction.message.edit({
    embeds: [signupEmbed(round, signups)],
    components: [signupButtons(round)],
  });
}

export const signupHandlers: ButtonHandler = {
  prefix: "signup:",
  async execute(interaction: ButtonInteraction) {
    const parts = interaction.customId.split(":");
    const action = parts[1];
    const roundId = parts[2];
    if (!roundId || (action !== "join" && action !== "withdraw")) {
      await interaction.reply({ content: "Malformed button.", flags: MessageFlags.Ephemeral });
      return;
    }

    const round = await prisma.signupRound.findUnique({ where: { id: roundId } });
    if (!round) {
      await interaction.reply({ content: "Signup round not found.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (round.status !== "OPEN") {
      await interaction.reply({
        content: `Sign-ups for **${round.name}** are ${round.status.toLowerCase()}.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    // Past the announced close time → the withdraw/sign-up window is over even
    // if the round hasn't been finalized yet. Point them at a helper.
    if (round.closesAt && Date.now() > round.closesAt.getTime()) {
      await interaction.reply({
        content: `Sign-ups for **${round.name}** have closed. If you need to change anything, ask a league helper.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (action === "join") {
      const existing = await prisma.signup.findUnique({
        where: { roundId_discordId: { roundId, discordId: interaction.user.id } },
      });
      if (existing && !existing.withdrawn) {
        await interaction.reply({
          content: "You're already signed up. Hit **Withdraw** if you want to drop out.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (existing) {
        await prisma.signup.update({
          where: { id: existing.id },
          data: { withdrawn: false, displayName: interaction.user.username },
        });
      } else {
        await prisma.signup.create({
          data: {
            roundId,
            discordId: interaction.user.id,
            displayName: interaction.user.username,
          },
        });
      }
      await refreshSignupMessage(roundId, interaction);
      await interaction.reply({
        content: `✅ You're signed up for **${round.name}**.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // withdraw
    const existing = await prisma.signup.findUnique({
      where: { roundId_discordId: { roundId, discordId: interaction.user.id } },
    });
    if (!existing || existing.withdrawn) {
      await interaction.reply({
        content: "You weren't signed up.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await prisma.signup.update({
      where: { id: existing.id },
      data: { withdrawn: true },
    });
    await refreshSignupMessage(roundId, interaction);
    await interaction.reply({
      content: `Withdrew from **${round.name}**. You can re-sign up any time before close.`,
      flags: MessageFlags.Ephemeral,
    });
  },
};
