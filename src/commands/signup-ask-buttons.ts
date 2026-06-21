// Handles the four buttons on the "are you in?" season-ask DM
// (see src/signup-reminders.ts): yes / no / later / stop.
//
// Everything edits the DM in place via interaction.update() — a definite answer
// strips the buttons so there's nothing left to click; "remind me later" keeps
// just Yes/No so they can still decide without the snooze/stop noise.

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type ButtonInteraction } from "discord.js";
import { prisma } from "../db.js";
import { markSignedUp, refreshChannelSignupPost } from "../signup/signup-reminders.js";
import type { ButtonHandler } from "./types.js";

function stillAccepting(round: { status: string; closedAt: Date | null; closesAt: Date | null }): boolean {
  if (round.closedAt || round.status !== "OPEN") return false;
  return !(round.closesAt && Date.now() > round.closesAt.getTime());
}

// Reduced button row left on the DM after "remind me later" — they can still
// commit either way, just without the snooze/stop buttons.
function decideRow(roundId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`season-ask:yes:${roundId}`).setLabel("Sign me up").setEmoji("✅").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`season-ask:no:${roundId}`).setLabel("Not this season").setEmoji("❌").setStyle(ButtonStyle.Secondary),
  );
}

export const signupAskButtonHandler: ButtonHandler = {
  prefix: "season-ask:",
  async execute(interaction: ButtonInteraction) {
    const [, action, roundId] = interaction.customId.split(":");
    if (!roundId || !action) {
      await interaction.update({ content: "This button looks broken — sorry. Sign up in the server when you're ready.", components: [] });
      return;
    }
    const discordId = interaction.user.id;
    const round = await prisma.signupRound.findUnique({ where: { id: roundId } });
    if (!round) {
      await interaction.update({ content: "That signup round is gone now.", components: [] });
      return;
    }

    // "stop asking" is honored even after a round closes — it's a standing
    // preference, not a per-round answer.
    if (action === "stop") {
      await prisma.player.updateMany({ where: { discordId }, data: { signupReminderOptOut: true } });
      await prisma.seasonInterest.deleteMany({ where: { discordId } });
      await prisma.signupAsk.updateMany({ where: { roundId, discordId }, data: { status: "DECLINED", respondedAt: new Date() } });
      await interaction.update({
        content: "🔕 Got it — I won't ask you about future seasons. You can turn reminders back on anytime on your **/me** page.",
        components: [],
      });
      return;
    }

    if (!stillAccepting(round)) {
      await interaction.update({
        content: `Sign-ups for **${round.name}** have closed. Catch the next one!`,
        components: [],
      });
      return;
    }

    if (action === "yes") {
      // Create the signup (or un-withdraw a previous drop), same as the channel
      // Sign Up button. They clicked from a DM, but they're a past player.
      const globalName = interaction.user.globalName ?? null;
      const existing = await prisma.signup.findUnique({
        where: { roundId_discordId: { roundId, discordId } },
      });
      if (existing) {
        await prisma.signup.update({
          where: { id: existing.id },
          data: { withdrawn: false, displayName: interaction.user.username, globalName },
        });
      } else {
        await prisma.signup.create({
          data: { roundId, discordId, displayName: interaction.user.username, globalName, inGuild: true },
        });
      }
      await markSignedUp(roundId, discordId);
      await refreshChannelSignupPost(roundId);
      await interaction.update({
        content: `✅ You're in for **${round.name}** — see you there! (Need to back out later? Use **Withdraw** in the signups channel.)`,
        components: [],
      });
      return;
    }

    if (action === "no") {
      await prisma.signupAsk.upsert({
        where: { roundId_discordId: { roundId, discordId } },
        create: { roundId, discordId, status: "DECLINED", respondedAt: new Date() },
        update: { status: "DECLINED", respondedAt: new Date() },
      });
      await interaction.update({
        content: `No worries — I'll skip you for **${round.name}** and ask again next season. (Hit 🔕 on a future ask to stop entirely.)`,
        components: [],
      });
      return;
    }

    // later → snooze: skip the mid-window nudge, still get the last call.
    await prisma.signupAsk.upsert({
      where: { roundId_discordId: { roundId, discordId } },
      create: { roundId, discordId, status: "SNOOZED", snoozedAt: new Date() },
      update: { status: "SNOOZED", snoozedAt: new Date() },
    });
    await interaction.update({
      content: `💤 No rush — I'll check back closer to the deadline. Or just decide now:`,
      components: [decideRow(roundId)],
    });
  },
};
