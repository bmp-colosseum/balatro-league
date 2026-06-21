// Interactive "a new season is opening — are you in?" reminder system.
//
// Replaces the old silent auto-enroll (Player.autoSignup). When signups open we
// DM every past player (minus opt-outs) an ask with four buttons:
//   ✅ I'm in        → signs them up, marks the ask ACCEPTED
//   ❌ Not this season → marks DECLINED, no more reminders this round
//   💤 Remind me later → marks SNOOZED, skips the mid-window nudge
//   🔕 Stop asking    → opts them out of all future-season reminders
//
// People who don't answer get auto-reminded on a cadence anchored to the round's
// close time: one mid-window nudge, then a "last call" ~36h before close. Each
// reminder DELETES the prior ask DM and posts a fresh one (Discord doesn't
// notify on edits), so everyone has exactly one live ask. Reminders stop the
// instant someone answers, and hard-stop when the round closes.
//
// Split of responsibility: this module is pure DB + Discord work and returns
// work-lists; src/queue.ts owns the pg-boss wiring (kickoff / per-person send /
// scheduled tick) so there's no circular import between the two.

import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import type { SignupRound } from "@prisma/client";
import { prisma } from "./db.js";
import { tryGetDiscordClient } from "./discord.js";
import { deleteChannelMessage } from "./discord-helpers.js";
import { getConfig, LeagueConfigKey } from "./league-config.js";
import { DEFAULT_SEASON_LENGTH_DAYS, playWindow, seasonWindowValue, signupEmbed, signupButtons } from "./signup.js";

// How long before close the "last call" reminder fires. 36h sits in the middle
// of the 24–48h target — close enough to feel urgent, early enough to act on.
const LAST_CALL_MS = 36 * 60 * 60 * 1000;
// No-deadline fallback: if a round has no closesAt to anchor on, send a single
// follow-up nudge this long after the initial ask (PENDING only).
const NO_DEADLINE_NUDGE_MS = 3 * 24 * 60 * 60 * 1000;

// Asks only matter while a round is genuinely OPEN and inside its window.
function acceptingAsks(round: Pick<SignupRound, "status" | "closedAt" | "closesAt">): boolean {
  if (round.closedAt) return false;
  if (round.status !== "OPEN") return false;
  if (round.closesAt && Date.now() > round.closesAt.getTime()) return false;
  return true;
}

async function seasonLengthDays(): Promise<number> {
  const raw = await getConfig(LeagueConfigKey.SeasonLengthDays);
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SEASON_LENGTH_DAYS;
}

type AskVariant = "initial" | "reminder" | "lastcall";

// The DM body. Always states the play window + the "only say yes if you can
// commit" framing; reminder/last-call variants add urgency on top.
function askContent(round: SignupRound, lengthDays: number, variant: AskVariant): string {
  const win = playWindow(round, lengthDays);
  const windowValue = win ? seasonWindowValue(win.start, win.end) : null;
  const lines: string[] = [];
  if (variant === "lastcall") {
    const when = round.closesAt ? `<t:${Math.floor(round.closesAt.getTime() / 1000)}:R>` : "soon";
    lines.push(`⏰ **Last call!** Sign-ups for **${round.name}** close ${when}.`, "");
  } else if (variant === "reminder") {
    lines.push(`⏰ **Quick reminder** — still need your answer on **${round.name}**.`, "");
  } else {
    lines.push(`🃏 **${round.name}** — sign-ups are open!`, "");
    lines.push("A new season is starting and I want to know if you're in.", "");
  }
  if (windowValue) lines.push(`**Play window:** ${windowValue}`, "");
  lines.push("Only say **yes** if you're sure you can play the whole season — dropping out mid-season throws off everyone's schedule.", "");
  lines.push("You in?");
  return lines.join("\n");
}

function askButtons(roundId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`season-ask:yes:${roundId}`).setLabel("I'm in").setEmoji("✅").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`season-ask:no:${roundId}`).setLabel("Not this season").setEmoji("❌").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`season-ask:later:${roundId}`).setLabel("Remind me later").setEmoji("💤").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`season-ask:stop:${roundId}`).setLabel("Stop asking").setEmoji("🔕").setStyle(ButtonStyle.Secondary),
  );
}

// Who we ask: every past player who hasn't opted out, PLUS the explicit 🔔
// opt-in list (covers people who logged in but never played). Minus anyone
// already signed up for THIS round — no point asking "are you in?" of someone
// who already is.
async function audienceDiscordIds(roundId: string): Promise<string[]> {
  const [players, interest, signed] = await Promise.all([
    prisma.player.findMany({ where: { signupReminderOptOut: false }, select: { discordId: true } }),
    prisma.seasonInterest.findMany({ select: { discordId: true } }),
    prisma.signup.findMany({ where: { roundId, withdrawn: false }, select: { discordId: true } }),
  ]);
  const set = new Set<string>();
  for (const p of players) set.add(p.discordId);
  for (const i of interest) set.add(i.discordId);
  for (const s of signed) set.delete(s.discordId);
  return [...set];
}

// Called by the kickoff worker when signups open. Creates a PENDING ask row per
// audience member (leaving any existing answer untouched) and returns the
// discordIds to fan out `signup.ask` sends for.
export async function planSignupAskKickoff(roundId: string): Promise<string[]> {
  const round = await prisma.signupRound.findUnique({ where: { id: roundId } });
  if (!round || !acceptingAsks(round)) return [];
  const audience = await audienceDiscordIds(roundId);
  for (const discordId of audience) {
    await prisma.signupAsk.upsert({
      where: { roundId_discordId: { roundId, discordId } },
      create: { roundId, discordId },
      update: {}, // never clobber an answer already given
    });
  }
  return audience;
}

// Send (or re-send) one person's ask DM. Deletes the prior live DM first so the
// fresh one re-notifies and there's only ever one live ask. Called by the
// `signup.ask` worker for both the initial send and every reminder.
export async function sendOrRefreshAsk(roundId: string, discordId: string): Promise<void> {
  const client = tryGetDiscordClient();
  if (!client) throw new Error("Discord client not ready — will retry");

  const round = await prisma.signupRound.findUnique({ where: { id: roundId } });
  if (!round || !acceptingAsks(round)) return;
  const ask = await prisma.signupAsk.findUnique({ where: { roundId_discordId: { roundId, discordId } } });
  if (!ask || ask.status === "ACCEPTED" || ask.status === "DECLINED") return; // already answered

  // Decide the tone from where we are in the round's window.
  let variant: AskVariant = "initial";
  if (ask.remindersSent > 0) {
    variant = round.closesAt && Date.now() >= round.closesAt.getTime() - LAST_CALL_MS ? "lastcall" : "reminder";
  }

  const user = await client.users.fetch(discordId).catch(() => null);
  if (!user) return; // unknown user (left / seeded id) — skip

  // Delete the previous live ask so the new one pings and we don't stack asks.
  if (ask.dmChannelId && ask.dmMessageId) {
    await deleteChannelMessage(ask.dmChannelId, ask.dmMessageId).catch(() => {});
  }

  const content = askContent(round, await seasonLengthDays(), variant);
  let sent: { id: string; channelId: string };
  try {
    sent = await user.send({ content, components: [askButtons(roundId)] });
  } catch (err) {
    const code = (err as { code?: number })?.code;
    // 50007 = DMs off / blocked / no shared server, 10013 = unknown user.
    // Permanently undeliverable — leave PENDING (the next tick just skips again).
    if (code === 50007 || code === 10013) {
      console.warn(`[signup-ask] ${discordId} undeliverable (code ${code}) — skipping.`);
      return;
    }
    throw err; // transient — let pg-boss retry
  }

  await prisma.signupAsk.update({
    where: { id: ask.id },
    data: {
      dmChannelId: sent.channelId,
      dmMessageId: sent.id,
      remindersSent: { increment: 1 },
      lastRemindedAt: new Date(),
    },
  });
}

// Returns the (roundId, discordId) pairs due for a reminder right now, for the
// scheduled tick to fan out. Cadence (anchored to closesAt):
//   • mid-window nudge — PENDING only, once, after the halfway point
//   • last call        — PENDING or SNOOZED, once, in the final ~36h
// Snoozers skip the mid nudge but still get the last call. No closesAt → a
// single follow-up nudge 3 days after the initial ask.
export async function planReminderTick(): Promise<Array<{ roundId: string; discordId: string }>> {
  const round = await prisma.signupRound.findFirst({
    where: { status: "OPEN" },
    orderBy: { openedAt: "desc" },
  });
  if (!round || !acceptingAsks(round)) return [];

  const now = Date.now();
  const open = round.openedAt.getTime();
  const close = round.closesAt?.getTime() ?? null;

  const asks = await prisma.signupAsk.findMany({
    where: { roundId: round.id, status: { in: ["PENDING", "SNOOZED"] } },
  });

  const due: Array<{ roundId: string; discordId: string }> = [];
  for (const ask of asks) {
    if (ask.remindersSent === 0) continue; // initial send hasn't happened yet — the kickoff owns that
    const last = ask.lastRemindedAt?.getTime() ?? 0;
    let send = false;
    if (close) {
      const lastCallStart = close - LAST_CALL_MS;
      const midPoint = open + (close - open) * 0.5;
      if (now >= lastCallStart && now < close && last < lastCallStart) {
        send = true; // last call (PENDING + SNOOZED)
      } else if (ask.status === "PENDING" && now >= midPoint && now < lastCallStart && ask.remindersSent < 2 && last < midPoint) {
        send = true; // mid-window nudge (PENDING only, snoozers excluded)
      }
    } else if (ask.status === "PENDING" && ask.remindersSent < 2 && now - last >= NO_DEADLINE_NUDGE_MS) {
      send = true; // no deadline to anchor on — one follow-up nudge
    }
    if (send) due.push({ roundId: round.id, discordId: ask.discordId });
  }
  return due;
}

// Called when someone signs up through ANY path (the ask DM, the channel
// button, or the website): mark their ask ACCEPTED so reminders stop, and add
// them to the 🔔 reminder list for future seasons (signing up = interested).
export async function markSignedUp(roundId: string, discordId: string): Promise<void> {
  await prisma.signupAsk.updateMany({
    where: { roundId, discordId },
    data: { status: "ACCEPTED", respondedAt: new Date() },
  });
  await prisma.seasonInterest.upsert({
    where: { discordId },
    create: { discordId },
    update: {},
  });
}

// Re-render the public channel signup post (the count) after an ask-driven
// signup, since that path has no channel-message interaction to edit in place.
export async function refreshChannelSignupPost(roundId: string): Promise<void> {
  const round = await prisma.signupRound.findUnique({ where: { id: roundId } });
  if (!round?.channelId || !round.messageId) return;
  const client = tryGetDiscordClient();
  if (!client) return;
  const channel = await client.channels.fetch(round.channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) return;
  const msg = await (channel as { messages: { fetch: (id: string) => Promise<{ edit: (o: unknown) => Promise<unknown> }> } }).messages
    .fetch(round.messageId)
    .catch(() => null);
  if (!msg) return;
  const signups = await prisma.signup.findMany({ where: { roundId }, orderBy: { signedUpAt: "asc" } });
  const accepting = acceptingAsks(round);
  await msg.edit({
    embeds: [signupEmbed(round, signups, await seasonLengthDays(), accepting)],
    components: [signupButtons(round, accepting)],
  }).catch(() => {});
}
