// Shared signup-embed rendering. /league post-signup creates the message;
// the button handlers re-render it after every signup/withdrawal.

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js";
import type { Signup, SignupRound } from "@prisma/client";
import { env } from "./env.js";

const LOGO_URL = `${env.WEB_BASE_URL}/Balatro_League.png`;
// Default play-window length (days) when the admin hasn't set an explicit end.
// Overridable via the season_length_days LeagueConfig key, passed in by callers.
export const DEFAULT_SEASON_LENGTH_DAYS = 14;

// Discord renders <t:unix:STYLE> in each viewer's own timezone. F = full
// date/time, R = relative ("in 3 days").
function discordTs(d: Date, style: "F" | "R"): string {
  return `<t:${Math.floor(d.getTime() / 1000)}:${style}>`;
}

// The window players have to get their games in. If an admin set explicit
// season start/end on the website, use those; otherwise assume the season
// starts when sign-ups close and runs two weeks. Null when there's no close
// time AND no manual start (nothing to anchor on).
export function playWindow(
  round: Pick<SignupRound, "closesAt" | "seasonStartsAt" | "seasonEndsAt">,
  lengthDays: number = DEFAULT_SEASON_LENGTH_DAYS,
): { start: Date; end: Date } | null {
  const start = round.seasonStartsAt ?? round.closesAt;
  if (!start) return null;
  const end = round.seasonEndsAt ?? new Date(start.getTime() + lengthDays * 86_400_000);
  return { start, end };
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

export function signupEmbed(
  round: SignupRound,
  signups: Signup[],
  lengthDays: number = DEFAULT_SEASON_LENGTH_DAYS,
  // True when sign-ups are still being taken even though status != OPEN — i.e.
  // a draft season was built but hasn't gone live yet. Defaults to the OPEN check.
  accepting?: boolean,
): EmbedBuilder {
  const active = signups.filter((s) => !s.withdrawn);
  const isOpen = accepting ?? round.status === "OPEN";

  // Public embed only surfaces the COUNT — not the player list. The
  // roster is admin/helper-only via /admin/signups/[id]/build. Hiding
  // individual names lets people sign up without worrying about who
  // else has committed.
  const status = isOpen
    ? `**${active.length} signed up**`
    : round.status === "CLOSED"
      ? `**${active.length} signed up — sign-ups closed**`
      : `**${active.length} signed up — season started**`;

  // Description tracks the round's lifecycle. While OPEN we show the close
  // time (the withdraw deadline) as a Discord timestamp. Once the season has
  // started, self-serve withdrawal is gone — point them at a helper.
  let description: string;
  if (isOpen) {
    const closeLine = round.closesAt
      ? `Closes ${discordTs(round.closesAt, "F")} (${discordTs(round.closesAt, "R")}). Withdraw anytime before.`
      : "Withdraw anytime before sign-ups close.";
    description = `Hit **Sign Up** to join. ${closeLine}`;
  } else if (round.status === "CLOSED") {
    description = "Sign-ups are closed.";
  } else {
    description = "Season's started. Need a change? Ask a helper.";
  }

  const win = playWindow(round, lengthDays);
  const windowValue = win ? seasonWindowValue(win.start, win.end) : null;

  const embed = new EmbedBuilder()
    .setTitle(round.name)
    .setThumbnail(LOGO_URL)
    .setDescription(description)
    .addFields({ name: "Status", value: status, inline: false })
    .setColor(isOpen ? 0x5865f2 : 0x99aab5)
    .setFooter({ text: `Round ${round.id}` });
  if (windowValue) embed.addFields({ name: "🎮 Play your games", value: windowValue, inline: false });
  return embed;
}

export function signupButtons(round: SignupRound, accepting?: boolean): ActionRowBuilder<ButtonBuilder> {
  // Disabled once the round isn't OPEN, or once the announced close time has
  // passed (takes effect on the next re-render). `accepting` overrides this for
  // a built-but-not-live draft (still taking sign-ups).
  const open = accepting ?? (round.status === "OPEN" && !(round.closesAt && Date.now() > round.closesAt.getTime()));
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
