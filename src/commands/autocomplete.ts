// Shared autocomplete used wherever a command takes a division-name argument.
// Centralized so all commands feel the same (same matching, same ordering).

import type { AutocompleteInteraction } from "discord.js";
import { activePublicSeason } from "../active-season.js";
import { prisma } from "../db.js";

export async function divisionNameAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const focused = interaction.options.getFocused().toLowerCase();
  const activeSeason = await activePublicSeason();
  if (!activeSeason) {
    await interaction.respond([]);
    return;
  }
  const divisions = await prisma.division.findMany({
    where: { seasonId: activeSeason.id },
    select: { name: true },
    orderBy: [{ tier: { position: "asc" } }, { groupNumber: "asc" }],
  });
  const matches = divisions
    .filter((d) => d.name.toLowerCase().includes(focused))
    .slice(0, 25)
    .map((d) => ({ name: d.name, value: d.name }));
  await interaction.respond(matches);
}
