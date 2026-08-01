import { MessageFlags, type ButtonInteraction } from "discord.js";
import { rollBans, rollCombo, rollDeck, rollStake } from "./random.js";
import type { ButtonHandler } from "./types.js";

// The bot-commands sticky's quick-roll buttons (customId prefix "random:").
// Each action calls the EXACT same roll+render function /random's matching
// subcommand uses (commands/random.ts) -- no reimplemented rolling logic, so
// the button bar and the slash command can never drift. Reply visibility
// matches /random: a public embed (not ephemeral), since a roll is meant to
// be seen by whoever you're about to play.
export const randomButtons: ButtonHandler = {
  prefix: "random:",
  async execute(interaction: ButtonInteraction) {
    const action = interaction.customId.split(":")[1];
    if (action === "deck") {
      await interaction.reply({ embeds: [await rollDeck()] });
      return;
    }
    if (action === "stake") {
      await interaction.reply({ embeds: [await rollStake()] });
      return;
    }
    if (action === "combo") {
      await interaction.reply({ embeds: [await rollCombo()] });
      return;
    }
    if (action === "bans") {
      await interaction.reply({ embeds: [await rollBans()] });
      return;
    }
    await interaction.reply({ content: "Unknown action.", flags: MessageFlags.Ephemeral });
  },
};
