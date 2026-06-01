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

// Autocomplete for picking a player to shoot-out against.
// Player path: only members of the actor's own division this season are
// eligible (Discord's user picker would have let them choose anyone).
// Returns the opponent's Discord ID as the option value so the execute
// handler can pass it straight through to persistShootout without an
// extra DB lookup.
export async function sameDivisionMemberAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const focused = interaction.options.getFocused().toLowerCase();
  const activeSeason = await activePublicSeason();
  if (!activeSeason) {
    await interaction.respond([]);
    return;
  }
  const me = await prisma.player.findUnique({ where: { discordId: interaction.user.id } });
  if (!me) {
    await interaction.respond([]);
    return;
  }
  const myMembership = await prisma.divisionMember.findFirst({
    where: { playerId: me.id, status: "ACTIVE", division: { seasonId: activeSeason.id } },
    select: { divisionId: true },
  });
  if (!myMembership) {
    await interaction.respond([]);
    return;
  }
  const others = await prisma.divisionMember.findMany({
    where: { divisionId: myMembership.divisionId, status: "ACTIVE", playerId: { not: me.id } },
    include: { player: { select: { discordId: true, displayName: true } } },
  });
  const matches = others
    .filter((m) => m.player.displayName.toLowerCase().includes(focused))
    .slice(0, 25)
    .map((m) => ({ name: m.player.displayName, value: m.player.discordId }));
  await interaction.respond(matches);
}

// Autocomplete for admin shootout commands. Suggests any active-season
// member (across divisions) so the admin can record for whichever pair.
// Same value shape as sameDivisionMemberAutocomplete — Discord user id.
export async function activeSeasonMemberAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const focused = interaction.options.getFocused().toLowerCase();
  const activeSeason = await activePublicSeason();
  if (!activeSeason) {
    await interaction.respond([]);
    return;
  }
  const members = await prisma.divisionMember.findMany({
    where: { status: "ACTIVE", division: { seasonId: activeSeason.id } },
    include: {
      player: { select: { discordId: true, displayName: true } },
      division: { select: { name: true } },
    },
  });
  // De-dupe by playerId in case a player somehow shows up twice (e.g.
  // double-membership), and label with their division so the admin can
  // tell who's where.
  const seen = new Set<string>();
  const matches = members
    .filter((m) => {
      if (seen.has(m.playerId)) return false;
      seen.add(m.playerId);
      return m.player.displayName.toLowerCase().includes(focused);
    })
    .slice(0, 25)
    .map((m) => ({ name: `${m.player.displayName} · ${m.division.name}`, value: m.player.discordId }));
  await interaction.respond(matches);
}
