// Shared signup-embed rendering. /league post-signup creates the message;
// the button handlers re-render it after every signup/withdrawal.

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js";
import type { Signup, SignupRound } from "@prisma/client";

// Discord renders <t:unix:STYLE> in each viewer's own timezone. F = full
// date/time, R = relative ("in 3 days").
function discordTs(d: Date, style: "F" | "R"): string {
  return `<t:${Math.floor(d.getTime() / 1000)}:${style}>`;
}

// "<start> → <end> (2 weeks)" when both ends are known, else null. Shown so
// players see how long the season runs before they commit. Length renders in
// whole weeks when it divides evenly, otherwise in days.
export function seasonWindowValue(startsAt: Date | null, endsAt: Date | null): string | null {
  if (!startsAt || !endsAt) return null;
  const days = Math.round((endsAt.getTime() - startsAt.getTime()) / 86_400_000);
  const length =
    days > 0 && days % 7 === 0
      ? `${days / 7} week${days / 7 === 1 ? "" : "s"}`
      : `${days} day${days === 1 ? "" : "s"}`;
  return `${discordTs(startsAt, "F")} → ${discordTs(endsAt, "F")} (${length})`;
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
    description = "Season started — to make a change, ask a league helper.";
  }

  const window = seasonWindowValue(round.seasonStartsAt, round.seasonEndsAt);

  const embed = new EmbedBuilder()
    .setTitle(`🃏  ${round.name}`)
    .setDescription(description)
    .addFields({ name: "Status", value: status, inline: false })
    .setColor(round.status === "OPEN" ? 0x5865f2 : 0x99aab5)
    .setFooter({ text: `Round ${round.id}` });
  if (window) embed.addFields({ name: "Season", value: window, inline: false });
  return embed;
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
