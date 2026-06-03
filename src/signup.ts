// Shared signup-embed rendering. /league post-signup creates the message;
// the button handlers re-render it after every signup/withdrawal.

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js";
import type { Signup, SignupRound } from "@prisma/client";

export function signupEmbed(round: SignupRound, signups: Signup[]): EmbedBuilder {
  const active = signups.filter((s) => !s.withdrawn);

  // Public embed only surfaces the COUNT — not the player list. The
  // roster is admin/helper-only via /admin/signups/[id]/build. Hiding
  // individual names lets people sign up without worrying about who
  // else has committed.
  const status =
    round.status === "OPEN"
      ? `**${active.length} signed up**`
      : round.status === "CLOSED"
        ? `**${active.length} signed up — sign-ups closed**`
        : `**${active.length} signed up — season started**`;

  return new EmbedBuilder()
    .setTitle(`🃏  ${round.name}`)
    .setDescription("Click below to register. Withdraw anytime before sign-ups close.")
    .addFields({ name: "Status", value: status, inline: false })
    .setColor(round.status === "OPEN" ? 0x5865f2 : 0x99aab5)
    .setFooter({ text: `Round ${round.id}` });
}

export function signupButtons(round: SignupRound): ActionRowBuilder<ButtonBuilder> {
  const open = round.status === "OPEN";
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`signup:join:${round.id}`)
      .setLabel("Sign Up")
      .setStyle(ButtonStyle.Success)
      .setDisabled(!open),
    new ButtonBuilder()
      .setCustomId(`signup:withdraw:${round.id}`)
      .setLabel("Withdraw")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!open),
  );
}
