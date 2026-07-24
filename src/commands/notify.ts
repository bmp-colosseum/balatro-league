import {
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { getOrCreatePlayer, guildDisplayName } from "../players.js";
import { setQueueNotifyOptIn } from "../league-queue.js";
import type { SlashCommand } from "./types.js";

// /notify on:True|False -- opt into (or out of) a DM whenever an opponent you
// still owe a match joins the league queue, so you can hop in and pair up
// instantly. Explicit boolean rather than a blind toggle so running it twice
// can't silently flip you back off. Default state (never set) is OFF.
export const notify: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("notify")
    .setDescription("Get a DM when an opponent you still owe a match joins the league queue.")
    .addBooleanOption((o) =>
      o
        .setName("on")
        .setDescription("On to get pinged when an opponent queues; off to stop.")
        .setRequired(true),
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const me = await getOrCreatePlayer(interaction.user, guildDisplayName(interaction));
    const on = interaction.options.getBoolean("on", true);
    await setQueueNotifyOptIn(me.id, on);
    await interaction.editReply(
      on
        ? "🔔 **You're opted in.** I'll DM you when an opponent you still owe a match joins the league queue — hit **Queue up** from the DM and you'll pair up instantly. (Make sure you allow DMs from server members, or the ping can't reach you.)"
        : "🔕 **Opted out.** I won't DM you about opponents queueing.",
    );
  },
};
