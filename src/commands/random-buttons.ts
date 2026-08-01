import { MessageFlags, type ButtonInteraction } from "discord.js";
import { rollBans, rollCombo, rollDeck, rollStake } from "./random.js";
import type { ButtonHandler } from "./types.js";

// The bot-commands sticky's quick-roll buttons (customId prefix "random:").
// Each action calls the EXACT same roll+render function /random's matching
// subcommand uses (commands/random.ts) -- no reimplemented rolling logic, so
// the button bar and the slash command can never drift.
//
// Replies are EPHEMERAL (only the clicker sees them), unlike /random. A button
// anyone can tap must not post into the channel: it would clutter
// #bot-commands with roll spam AND every such post counts toward the sticky's
// activity counter, bumping the bar too. Use `/random ...` when you actually
// want to share a roll publicly.
export const randomButtons: ButtonHandler = {
  prefix: "random:",
  async execute(interaction: ButtonInteraction) {
    const action = interaction.customId.split(":")[1];
    const ephemeral = MessageFlags.Ephemeral;
    if (action === "deck") {
      await interaction.reply({ embeds: [await rollDeck()], flags: ephemeral });
      return;
    }
    if (action === "stake") {
      await interaction.reply({ embeds: [await rollStake()], flags: ephemeral });
      return;
    }
    if (action === "combo") {
      await interaction.reply({ embeds: [await rollCombo()], flags: ephemeral });
      return;
    }
    if (action === "bans") {
      await interaction.reply({ embeds: [await rollBans()], flags: ephemeral });
      return;
    }
    await interaction.reply({ content: "Unknown action.", flags: ephemeral });
  },
};
