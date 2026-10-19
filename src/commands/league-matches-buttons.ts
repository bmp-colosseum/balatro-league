import {
  ActionRowBuilder,
  MessageFlags,
  StringSelectMenuBuilder,
  type ButtonInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import { actorFromInteractionUser } from "../audit.js";
import { getOrCreatePlayer, guildDisplayName } from "../players.js";
import { activePublicSeason } from "../active-season.js";
import { prisma } from "../db.js";
import { createLeagueMatchInvite } from "../league-match-invite.js";
import { isDiscordIdBanned, BANNED_MESSAGE } from "../bans.js";
import { nameMd, namePlain } from "../name-format-core.js";
import { pendingShootoutsForPlayer } from "../shootout.js";
import type { ButtonHandler, SelectMenuHandler } from "./types.js";

// A player's still-to-play opponents this season: opponents from their PENDING,
// unplayed LEAGUE_BO2 matches, each with the shared division id (needed to start
// the match). Same source as the queue's remaining-opponent list, and exactly
// what the schedule-locked gate in createLeagueMatchInvite will accept.
async function remainingOpponents(
  playerId: string,
  seasonId: string,
): Promise<Array<{ id: string; displayName: string; divisionId: string }>> {
  const pending = await prisma.match.findMany({
    where: {
      status: "PENDING",
      format: "LEAGUE_BO2",
      gamesWonA: 0,
      gamesWonB: 0,
      division: { seasonId },
      OR: [{ playerAId: playerId }, { playerBId: playerId }],
    },
    select: { divisionId: true, playerAId: true, playerBId: true },
  });
  if (pending.length === 0) return [];
  const oppToDiv = new Map<string, string>();
  for (const m of pending) {
    const oppId = m.playerAId === playerId ? m.playerBId : m.playerAId;
    if (!oppToDiv.has(oppId)) oppToDiv.set(oppId, m.divisionId);
  }
  const players = await prisma.player.findMany({
    where: { id: { in: [...oppToDiv.keys()] } },
    select: { id: true, displayName: true },
  });
  return players
    .map((p) => ({ id: p.id, displayName: p.displayName, divisionId: oppToDiv.get(p.id)! }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

// The persistent "Start a match" button in #league-matches. On click, show the
// CLICKER an ephemeral dropdown of their remaining scheduled opponents. Picking
// one fires the same invite as /start-match (see leagueMatchesPickSelect below).
export const leagueMatchesButtons: ButtonHandler = {
  prefix: "league-matches:",
  async execute(interaction: ButtonInteraction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (await isDiscordIdBanned(interaction.user.id)) {
      await interaction.editReply(BANNED_MESSAGE);
      return;
    }
    const season = await activePublicSeason();
    if (!season) {
      await interaction.editReply("No active season right now.");
      return;
    }
    const me = await getOrCreatePlayer(interaction.user, guildDisplayName(interaction));

    // "Start shootout": offer only opponents this player currently OWES a shootout
    // (boundary tie in a completed division). Picking one starts a SHOOTOUT_BO1.
    if (interaction.customId === "league-matches:shootout") {
      const pending = await pendingShootoutsForPlayer(me.id, season.id);
      if (pending.length === 0) {
        await interaction.editReply(
          "You don't have a shootout to play right now. Shootouts only appear once your division is **finished** and you're **tied** with someone for a promotion or relegation spot (and your head-to-head didn't settle it).",
        );
        return;
      }
      const menu = new StringSelectMenuBuilder()
        .setCustomId("league-matches-shootout-pick:")
        .setPlaceholder("Play your shootout")
        .addOptions(pending.slice(0, 25).map((p) => ({ label: namePlain(p.opponentName).slice(0, 100), value: p.opponentId })));
      const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
      await interaction.editReply({
        content: "**Shootout tiebreaker** — pick who to play. It's a single game; the winner takes the spot.",
        components: [row],
      });
      return;
    }

    const opponents = await remainingOpponents(me.id, season.id);
    if (opponents.length === 0) {
      await interaction.editReply(
        "You have no scheduled matches left to start. 🎉\n(If that seems wrong, you may not be in a division this season — check with an admin.)",
      );
      return;
    }

    const shown = opponents.slice(0, 25); // Discord caps a select at 25 options.
    const menu = new StringSelectMenuBuilder()
      .setCustomId("league-matches-pick:")
      .setPlaceholder("Pick who you want to play")
      .addOptions(shown.map((o) => ({ label: namePlain(o.displayName).slice(0, 100), value: o.id })));
    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
    await interaction.editReply({
      content:
        "**Who do you want to play?** Pick an opponent and I'll send them an invite to accept." +
        (opponents.length > 25 ? "\n_(showing your first 25 remaining opponents)_" : ""),
      components: [row],
    });
  },
};

// The opponent-dropdown submit. Resolve the chosen opponent + shared division and
// start the match via the SAME helper /start-match uses — every gate (bans,
// off-schedule, already-played, already-in-a-match) lives in that one function.
export const leagueMatchesPickSelect: SelectMenuHandler = {
  prefix: "league-matches-pick:",
  async execute(interaction: StringSelectMenuInteraction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const oppId = interaction.values[0];
    if (!oppId) {
      await interaction.editReply("No opponent selected.");
      return;
    }
    const season = await activePublicSeason();
    if (!season) {
      await interaction.editReply("No active season right now.");
      return;
    }
    const me = await getOrCreatePlayer(interaction.user);
    const opp = await prisma.player.findUnique({ where: { id: oppId } });
    if (!opp) {
      await interaction.editReply("Couldn't find that opponent anymore — try again.");
      return;
    }

    // Confirm they still share an active division this season (mirrors start-match).
    const shared = await prisma.divisionMember.findFirst({
      where: { playerId: me.id, status: "ACTIVE", division: { seasonId: season.id } },
      include: { division: { include: { members: { where: { playerId: opp.id, status: "ACTIVE" } } } } },
    });
    if (!shared || shared.division.members.length === 0) {
      await interaction.editReply("You and that player aren't in the same active division this season.");
      return;
    }

    const result = await createLeagueMatchInvite({
      client: interaction.client,
      season: { id: season.id },
      division: { id: shared.division.id },
      me,
      opp,
      channelId: interaction.channelId ?? "",
      source: "start-button",
      actor: actorFromInteractionUser(interaction.user),
    });
    if (!result.ok) {
      await interaction.editReply(result.error ?? "Couldn't start the match.");
      return;
    }
    await interaction.editReply(
      `Match invite sent to **${nameMd(opp.displayName)}** — it's in a private thread and they need to accept. Expires in ${result.expiryMinutes} min if not accepted.` +
        (result.inviteUrl ? `\n${result.inviteUrl}` : ""),
    );
  },
};

// The shootout-dropdown submit. Re-validates (at click time) that the clicker
// still owes this opponent a shootout — then opens a SHOOTOUT_BO1 invite via the
// same helper, which is exempt from the schedule gate (tied players often never
// played each other) and blocks a duplicate if the shootout's already recorded.
export const leagueMatchesShootoutPickSelect: SelectMenuHandler = {
  prefix: "league-matches-shootout-pick:",
  async execute(interaction: StringSelectMenuInteraction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const oppId = interaction.values[0];
    if (!oppId) {
      await interaction.editReply("No opponent selected.");
      return;
    }
    const season = await activePublicSeason();
    if (!season) {
      await interaction.editReply("No active season right now.");
      return;
    }
    const me = await getOrCreatePlayer(interaction.user);
    const owed = (await pendingShootoutsForPlayer(me.id, season.id)).find((p) => p.opponentId === oppId);
    if (!owed) {
      await interaction.editReply("That shootout isn't owed anymore — it may already be played. Refresh and try again.");
      return;
    }
    const opp = await prisma.player.findUnique({ where: { id: oppId } });
    if (!opp) {
      await interaction.editReply("Couldn't find that opponent anymore — try again.");
      return;
    }
    const result = await createLeagueMatchInvite({
      client: interaction.client,
      season: { id: season.id },
      division: { id: owed.divisionId },
      me,
      opp,
      isShootout: true,
      channelId: interaction.channelId ?? "",
      source: "shootout-button",
      actor: actorFromInteractionUser(interaction.user),
    });
    if (!result.ok) {
      await interaction.editReply(result.error ?? "Couldn't start the shootout.");
      return;
    }
    await interaction.editReply(
      `Shootout invite sent to **${nameMd(opp.displayName)}** — single game, winner takes the spot. It's in a private thread; they need to accept. Expires in ${result.expiryMinutes} min.` +
        (result.inviteUrl ? `\n${result.inviteUrl}` : ""),
    );
  },
};
