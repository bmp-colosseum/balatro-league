import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";

// The shared 5-button control row shown under each division's welcome message.
// Every action is ephemeral and computed for whoever clicks, so the same row
// works in every division channel. "Start a match" reuses the existing
// #league-matches button handler (customId "league-matches:start"); the other
// four are handled by divisionControlsButtons (prefix "controls:").
export function divisionControlsRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("league-matches:start").setLabel("Start a match").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("controls:schedule").setLabel("Who do I play?").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("controls:status").setLabel("My standings").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("controls:standings").setLabel("League standings").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("controls:help").setLabel("Help").setStyle(ButtonStyle.Secondary),
  );
}

// A one-button row linking Hammertime (timezone-aware Discord timestamps) so
// players can generate a "let's play at <time>" stamp when scheduling matches
// across time zones. A Link button carries no customId (it's just a URL).
function hammertimeRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("Schedule a time").setURL("https://hammertime.cyou"),
  );
}

// The full player action block: the controls row + the Hammertime scheduling
// link (the controls row is already full at Discord's 5-button max, so the link
// needs its own row). Used by the DM panel, the sticky message, and the division
// welcome so all three stay identical.
export function playerActionRows(): ActionRowBuilder<ButtonBuilder>[] {
  return [divisionControlsRow(), hammertimeRow()];
}
