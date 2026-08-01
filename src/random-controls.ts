// Shared "quick roll" button row -- four buttons that mirror /random's
// subcommands (deck | stake | combo | bans), one click away instead of typing
// the slash command. Used by the bot-commands sticky (sticky-actions.ts) and
// available to reuse anywhere else a quick-roll shortcut is useful. The
// buttons are handled by randomButtons (commands/random-buttons.ts, prefix
// "random:"), which calls the exact same roll functions /random itself uses
// -- so the two surfaces can never drift.

import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";

export function randomControlsRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("random:deck").setLabel("Random Deck").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("random:stake").setLabel("Random Stake").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("random:combo").setLabel("Random Combo").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("random:bans").setLabel("Random Bans").setStyle(ButtonStyle.Secondary),
  );
}
