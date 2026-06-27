// Discord signup-post rendering, shared by the admin season actions (which
// open/close/edit the post) and the public /join actions (which sign a player
// up or withdraw them and must refresh the live count). Kept out of any
// "use server" file so these can be plain helpers, not server actions.

import { prisma } from "@/lib/prisma";
import { editChannelMessage, type ComponentActionRow, type MessageEmbed } from "@/lib/discord";

const LOGO_URL = `${(process.env.NEXTAUTH_URL ?? "").replace(/\/+$/, "") || "https://www.balatroleague.com"}/Balatro_League.png`;
const DEFAULT_SEASON_LENGTH_DAYS = 14;

// Configured play-window length (days), default two weeks. Mirrors the bot.
export async function getSeasonLengthDays(): Promise<number> {
  const row = await prisma.leagueConfig.findUnique({ where: { key: "season_length_days" } });
  const n = row ? Number(row.value) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SEASON_LENGTH_DAYS;
}

// "<start> → <end> (2 weeks)" when both ends are known, else null. Mirrors
// seasonWindowValue() on the bot side (src/signup.ts).
function seasonWindowValue(startsAt: Date | null, endsAt: Date | null): string | null {
  if (!startsAt || !endsAt) return null;
  const ts = (d: Date, style: "F" | "R") => `<t:${Math.floor(d.getTime() / 1000)}:${style}>`;
  const days = Math.round((endsAt.getTime() - startsAt.getTime()) / 86_400_000);
  const length =
    days > 0 && days % 7 === 0
      ? `${days / 7} week${days / 7 === 1 ? "" : "s"}`
      : `${days} day${days === 1 ? "" : "s"}`;
  return `${ts(startsAt, "F")} → ${ts(endsAt, "F")} (${length})`;
}

// Play window: admin's explicit season start/end if set, else season starts
// when sign-ups close and runs `lengthDays`. Mirrors playWindow() on the bot.
function playWindowValue(
  round: { closesAt: Date | null; seasonStartsAt: Date | null; seasonEndsAt: Date | null },
  lengthDays: number = DEFAULT_SEASON_LENGTH_DAYS,
): string | null {
  const start = round.seasonStartsAt ?? round.closesAt;
  if (!start) return null;
  const end = round.seasonEndsAt ?? new Date(start.getTime() + lengthDays * 86_400_000);
  return seasonWindowValue(start, end);
}

export function buildSignupPayload(
  round: { id: string; name: string; closesAt: Date | null; seasonStartsAt: Date | null; seasonEndsAt: Date | null },
  signupCount = 0,
  lengthDays: number = DEFAULT_SEASON_LENGTH_DAYS,
): { embeds: MessageEmbed[]; components: ComponentActionRow[] } {
  const closeLine = round.closesAt
    ? `Closes <t:${Math.floor(round.closesAt.getTime() / 1000)}:F> (<t:${Math.floor(round.closesAt.getTime() / 1000)}:R>). Withdraw anytime before.`
    : "Withdraw anytime before sign-ups close.";
  const window = playWindowValue(round, lengthDays);
  const fields: NonNullable<MessageEmbed["fields"]> = [
    { name: "Status", value: `**${signupCount} signed up**`, inline: false },
  ];
  if (window) fields.push({ name: "🎮 Play your games", value: window, inline: false });
  const embed: MessageEmbed = {
    title: round.name,
    thumbnail: { url: LOGO_URL },
    description: `Hit **Sign Up** to join. ${closeLine}`,
    fields,
    color: 0x5865f2,
    footer: { text: `Round ${round.id}` },
  };
  const row: ComponentActionRow = {
    type: 1,
    components: [
      { type: 2, custom_id: `signup:join:${round.id}`, style: 3, label: "Sign Up" },
      { type: 2, custom_id: `signup:withdraw:${round.id}`, style: 2, label: "Withdraw" },
    ],
  };
  return { embeds: [embed], components: [row] };
}

// Preview of the "are you in?" DM blasted to past players when signups open —
// the one they can sign up from directly. MIRRORS askContent()'s initial variant
// in src/signup/signup-reminders.ts (keep in sync). The Sign-up buttons are shown
// DISABLED here (it's a preview to the admin, not a live ask).
export function buildSignupAskDmPreview(
  round: { name: string; closesAt: Date | null; seasonStartsAt: Date | null; seasonEndsAt: Date | null },
  lengthDays: number = DEFAULT_SEASON_LENGTH_DAYS,
): { content: string; components: ComponentActionRow[] } {
  const window = playWindowValue(round, lengthDays);
  const lines = [
    `🃏 **${round.name}** — sign-ups are open!`,
    "",
    "A new season is starting and I want to know if you're in.",
    "",
  ];
  if (window) lines.push(`**Play window:** ${window}`, "");
  lines.push(
    "**Tapping ✅ Sign me up signs you up right now** and puts you on the roster — so only do it if you're sure you can play the whole season. Dropping out mid-season throws off everyone's schedule.",
  );
  const row: ComponentActionRow = {
    type: 1,
    components: [
      { type: 2, custom_id: "season-ask:preview:1", style: 3, label: "✅ Sign me up", disabled: true },
      { type: 2, custom_id: "season-ask:preview:2", style: 2, label: "❌ Not this season", disabled: true },
      { type: 2, custom_id: "season-ask:preview:3", style: 2, label: "💤 Remind me later", disabled: true },
      { type: 2, custom_id: "season-ask:preview:4", style: 2, label: "🔕 Stop asking", disabled: true },
    ],
  };
  return { content: lines.join("\n"), components: [row] };
}

export function buildClosedSignupPayload(
  round: { id: string; name: string },
  signups: Array<{ discordId: string }>,
): { embeds: MessageEmbed[]; components: ComponentActionRow[] } {
  const embed: MessageEmbed = {
    title: round.name,
    thumbnail: { url: LOGO_URL },
    description: "Sign-ups are closed.",
    fields: [
      { name: "Status", value: `**${signups.length} signed up — sign-ups closed**`, inline: false },
    ],
    color: 0x99aab5,
    footer: { text: `Round ${round.id}` },
  };
  const row: ComponentActionRow = {
    type: 1,
    components: [
      { type: 2, custom_id: `signup:join:${round.id}`, style: 3, label: "Sign Up", disabled: true },
      { type: 2, custom_id: `signup:withdraw:${round.id}`, style: 2, label: "Withdraw", disabled: true },
    ],
  };
  return { embeds: [embed], components: [row] };
}

// Re-render the OPEN signup post in Discord with the current non-withdrawn
// count. Used by the website signup/withdraw actions so the count stays live
// even when nobody clicks a Discord button. No-op if the post isn't an open,
// already-posted message.
export async function refreshSignupPost(roundId: string): Promise<void> {
  const round = await prisma.signupRound.findUnique({ where: { id: roundId } });
  if (!round || round.status !== "OPEN" || !round.messageId || round.messageId === "pending") return;
  const count = await prisma.signup.count({ where: { roundId, withdrawn: false } });
  const lengthDays = await getSeasonLengthDays();
  await editChannelMessage(round.channelId, round.messageId, buildSignupPayload(round, count, lengthDays)).catch((err) =>
    console.warn("[signup] Discord post refresh failed:", err),
  );
}
