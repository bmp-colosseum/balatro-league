// The /ppt command tree (C4). One top-level command, subcommands grouped under it —
// clean autocomplete, single registration unit.
import { SlashCommandBuilder } from "discord.js";

export function commandDefinitions() {
  const ppt = new SlashCommandBuilder()
    .setName("ppt")
    .setDescription("Pizza Power Team Tour")
    .addSubcommand((s) =>
      s
        .setName("standings")
        .setDescription("Current standings by conference")
        .addStringOption((o) => o.setName("season").setDescription("Season name (default: the live season)")),
    )
    .addSubcommand((s) =>
      s
        .setName("schedule")
        .setDescription("A week's matchups + scores")
        .addIntegerOption((o) => o.setName("week").setDescription("Week number (default: latest)"))
        .addStringOption((o) => o.setName("season").setDescription("Season name (default: the live season)")),
    )
    .addSubcommand((s) =>
      s
        .setName("bracket")
        .setDescription("The playoff bracket")
        .addStringOption((o) => o.setName("season").setDescription("Season name (default: the live season)")),
    )
    .addSubcommand((s) =>
      s
        .setName("fantasy")
        .setDescription("Fantasy league standings")
        .addStringOption((o) => o.setName("season").setDescription("Season name (default: the live season)")),
    )
    .addSubcommand((s) => s.setName("mymatch").setDescription("Your outstanding sets this week"))
    .addSubcommand((s) => s.setName("pickem").setDescription("Make your pick'em predictions"));
  return [ppt.toJSON()];
}
