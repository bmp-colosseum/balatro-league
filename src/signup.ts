// Shared signup-embed rendering. /league post-signup creates the message;
// the button handlers re-render it after every signup/withdrawal.

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js";
import type { Signup, SignupRound } from "@prisma/client";

// Discord renders <t:unix:STYLE> in each viewer's own timezone. F = full
// date/time, R = relative ("in 3 days").
function discordTs(d: Date, style: "F" | "R"): string {
  return `<t:${Math.floor(d.getTime() / 1000)}:${style}>`;
}

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

  // Description tracks the round's lifecycle. While OPEN we show the close
  // time (the withdraw deadline) as a Discord timestamp. Once the season has
  // started, self-serve withdrawal is gone — point them at a helper.
  let description: string;
  if (round.status === "OPEN") {
    const closeLine = round.closesAt
      ? `Sign-ups close ${discordTs(round.closesAt, "F")} (${discordTs(round.closesAt, "R")}). Withdraw any time before then.`
      : "Withdraw any time before sign-ups close.";
    description = `Click below to register. ${closeLine}`;
  } else if (round.status === "CLOSED") {
    description = "Sign-ups are closed.";
  } else {
    description = "Season started — to withdraw or make a change, ask a league helper.";
  }

  return new EmbedBuilder()
    .setTitle(`🃏  ${round.name}`)
    .setDescription(description)
    .addFields({ name: "Status", value: status, inline: false })
    .setColor(round.status === "OPEN" ? 0x5865f2 : 0x99aab5)
    .setFooter({ text: `Round ${round.id}` });
}

export function signupButtons(round: SignupRound): ActionRowBuilder<ButtonBuilder> {
  // Disabled once the round isn't OPEN, or once the announced close time has
  // passed (takes effect on the next re-render).
  const open = round.status === "OPEN" && !(round.closesAt && Date.now() > round.closesAt.getTime());
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
