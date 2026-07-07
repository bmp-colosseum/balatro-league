import { MessageFlags, type ButtonInteraction } from "discord.js";
import { getOrCreatePlayer, guildDisplayName } from "../players.js";
import { activePublicSeason } from "../active-season.js";
import { buildScheduleEmbed } from "../schedule-embed.js";
import { buildStatusReply } from "./status.js";
import { buildPlayerHelpEmbed } from "./help.js";
import { runStandingsForPlayer } from "./standings.js";
import type { ButtonHandler } from "./types.js";

// The division control-panel buttons (attached to each division's welcome
// message). Each runs the SAME core as the matching slash command, ephemerally,
// for whoever clicked - so there's no logic drift. "Start a match" is handled
// separately by leagueMatchesButtons (customId "league-matches:start").
export const divisionControlsButtons: ButtonHandler = {
  prefix: "controls:",
  async execute(interaction: ButtonInteraction) {
    const action = interaction.customId.split(":")[1];

    // Help is static text, so reply directly (no defer needed).
    if (action === "help") {
      await interaction.reply({ embeds: [buildPlayerHelpEmbed()], flags: MessageFlags.Ephemeral });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (action === "standings") {
      await runStandingsForPlayer(interaction, interaction.user.id);
      return;
    }
    if (action === "status") {
      await interaction.editReply(await buildStatusReply(interaction.user, guildDisplayName(interaction)));
      return;
    }
    if (action === "schedule") {
      const season = await activePublicSeason();
      if (!season) {
        await interaction.editReply("No active season right now.");
        return;
      }
      const me = await getOrCreatePlayer(interaction.user, guildDisplayName(interaction));
      const embed = await buildScheduleEmbed(me.id);
      await interaction.editReply(embed ? { embeds: [embed] } : "You're not in a division this season.");
      return;
    }

    await interaction.editReply("Unknown action.");
  },
};
