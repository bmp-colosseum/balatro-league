import { MessageFlags, type ButtonInteraction } from "discord.js";
import { actorFromInteractionUser } from "../audit.js";
import { getOrCreatePlayer, guildDisplayName } from "../players.js";
import { activePublicSeason } from "../active-season.js";
import { joinQueue, leaveQueue, tryStartFromQueue, refreshQueueMessage } from "../league-queue.js";
import type { ButtonHandler } from "./types.js";

// #league-queue buttons. "I'm free" adds you to the queue and, if a scheduled
// opponent is already there, immediately fires the normal match invite for both
// to accept. "Leave" pulls you out. Both refresh the pinned message's free list.
export const queueButtons: ButtonHandler = {
  prefix: "queue:",
  async execute(interaction: ButtonInteraction) {
    const action = interaction.customId.split(":")[1];
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const me = await getOrCreatePlayer(interaction.user, guildDisplayName(interaction));

    if (action === "leave") {
      const was = await leaveQueue(me.id);
      await refreshQueueMessage(interaction.client);
      await interaction.editReply(was ? "You've left the queue." : "You weren't in the queue.");
      return;
    }

    if (action === "join") {
      const season = await activePublicSeason();
      if (!season) {
        await interaction.editReply("No active season right now — nothing to queue for.");
        return;
      }
      await joinQueue(me.id, season.id);
      const outcome = await tryStartFromQueue({
        client: interaction.client,
        me,
        actor: actorFromInteractionUser(interaction.user),
      });
      await refreshQueueMessage(interaction.client);

      if (outcome.matched) {
        await interaction.editReply(
          `🎮 Matched with **${outcome.oppName}** — a match invite is up. Accept it to start.` +
            (outcome.inviteUrl ? `\n${outcome.inviteUrl}` : ""),
        );
      } else if (outcome.error) {
        await interaction.editReply(`You're queued, but I couldn't start a match just now: ${outcome.error}`);
      } else {
        await interaction.editReply(
          "You're in the queue ✅ — I'll open a match the moment one of your scheduled opponents is also free. Hit **Leave** when you're done.",
        );
      }
      return;
    }

    await interaction.editReply("Unknown queue action.");
  },
};
