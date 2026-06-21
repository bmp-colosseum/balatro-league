import { MessageFlags, type ButtonInteraction } from "discord.js";
import { prisma } from "../db.js";
import { signupButtons, signupEmbed, DEFAULT_SEASON_LENGTH_DAYS } from "../signup.js";
import { getConfig, LeagueConfigKey } from "../league-config.js";
import type { ButtonHandler } from "./types.js";

// Configured play-window length (days), defaulting to two weeks.
async function seasonLengthDays(): Promise<number> {
  const raw = await getConfig(LeagueConfigKey.SeasonLengthDays);
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SEASON_LENGTH_DAYS;
}

// Re-fetch the round + signups, then edit the original message in place so the count and list
// always match DB state, even if multiple users click at once.
// Sign-ups are accepted while the round is OPEN (and before its close time), OR
// while a draft season has been BUILT but not yet activated — building a draft to
// arrange it must NOT close sign-ups. Only an explicit CLOSE, or the season going
// live/ended, stops them.
async function isAcceptingSignups(round: { status: string; closedAt: Date | null; closesAt: Date | null; resultingSeasonId: string | null }): Promise<boolean> {
  // closedAt is the authoritative "signups closed" signal — independent of build
  // state. An admin can close signups whether or not the season has been built.
  if (round.closedAt) return false;
  if (round.status === "OPEN") return !(round.closesAt && Date.now() > round.closesAt.getTime());
  if (round.status === "BUILT" && round.resultingSeasonId) {
    const season = await prisma.season.findUnique({
      where: { id: round.resultingSeasonId },
      select: { isActive: true, endedAt: true },
    });
    return !!season && !season.isActive && !season.endedAt;
  }
  return false;
}

async function refreshSignupMessage(roundId: string, interaction: ButtonInteraction) {
  const round = await prisma.signupRound.findUnique({ where: { id: roundId } });
  if (!round) return;
  const signups = await prisma.signup.findMany({
    where: { roundId },
    orderBy: { signedUpAt: "asc" },
  });
  const accepting = await isAcceptingSignups(round);
  await interaction.message.edit({
    embeds: [signupEmbed(round, signups, await seasonLengthDays(), accepting)],
    components: [signupButtons(round, accepting)],
  });
}

export const signupHandlers: ButtonHandler = {
  prefix: "signup:",
  async execute(interaction: ButtonInteraction) {
    const parts = interaction.customId.split(":");
    const action = parts[1];
    const roundId = parts[2];
    if (!roundId || (action !== "join" && action !== "withdraw")) {
      await interaction.reply({ content: "This button looks broken — refresh Discord and try again.", flags: MessageFlags.Ephemeral });
      return;
    }

    const round = await prisma.signupRound.findUnique({ where: { id: roundId } });
    if (!round) {
      await interaction.reply({ content: "Signup round not found.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (!(await isAcceptingSignups(round))) {
      const why = round.status === "CLOSED" || round.closedAt ? "closed" : "closed — the season is live";
      await interaction.reply({
        content: `Sign-ups for **${round.name}** are ${why}.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    // Past the announced close time → the withdraw/sign-up window is over even
    // if the round hasn't been finalized yet. Point them at a helper.
    if (round.status === "OPEN" && round.closesAt && Date.now() > round.closesAt.getTime()) {
      await interaction.reply({
        content: `Sign-ups for **${round.name}** have closed. If you need to change anything, ask a league helper.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (action === "join") {
      // Bot accounts aren't players. In practice a bot can't click a component
      // (Discord doesn't deliver interactions to bots), so this is belt-and-
      // suspenders — but it keeps a non-human out of the roster if that ever
      // changes, and mirrors the opponent.bot guard in the match commands.
      if (interaction.user.bot) {
        await interaction.reply({
          content: "Bot accounts can't join the league.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const existing = await prisma.signup.findUnique({
        where: { roundId_discordId: { roundId, discordId: interaction.user.id } },
      });
      if (existing && !existing.withdrawn) {
        await interaction.reply({
          content: "You're already signed up. Hit **Withdraw** if you want to drop out.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      // global_name is the account-level display name; null for users who
      // never set one. Captured so the admin roster can show the recognizable
      // name rather than the @handle.
      const globalName = interaction.user.globalName ?? null;
      // They just clicked the button inside the server, so they're a member.
      if (existing) {
        await prisma.signup.update({
          where: { id: existing.id },
          data: { withdrawn: false, displayName: interaction.user.username, globalName, inGuild: true },
        });
      } else {
        await prisma.signup.create({
          data: {
            roundId,
            discordId: interaction.user.id,
            displayName: interaction.user.username,
            globalName,
            inGuild: true,
          },
        });
      }
      await refreshSignupMessage(roundId, interaction);
      await interaction.reply({
        content: `✅ You're signed up for **${round.name}**.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // withdraw
    const existing = await prisma.signup.findUnique({
      where: { roundId_discordId: { roundId, discordId: interaction.user.id } },
    });
    if (!existing || existing.withdrawn) {
      await interaction.reply({
        content: "You weren't signed up.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await prisma.signup.update({
      where: { id: existing.id },
      data: { withdrawn: true },
    });
    await refreshSignupMessage(roundId, interaction);
    await interaction.reply({
      content: `Withdrew from **${round.name}**. You can re-sign up any time before close.`,
      flags: MessageFlags.Ephemeral,
    });
  },
};
