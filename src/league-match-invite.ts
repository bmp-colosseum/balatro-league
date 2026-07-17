import {
  ChannelType,
  ThreadAutoArchiveDuration,
  type Client,
  type TextChannel,
} from "discord.js";
import { prisma } from "./db.js";
import { getLeagueSettingsForSeason } from "./league-settings.js";
import { bootstrapPresetsAndPointers, presetForSeason } from "./match-config.js";
import { renderMatch } from "./match-render.js";
import { postModerationNotice } from "./mod-log.js";
import { ensureLeagueMatchesChannel } from "./league-matches-channel.js";
import { recordAudit } from "./audit.js";
import { bannedPlayerIds, BANNED_MESSAGE } from "./bans.js";
import { sanitizeName } from "./sanitize.js";
import type { Player } from "@prisma/client";

export interface CreateLeagueMatchInviteResult {
  ok: boolean;
  /** User-facing reason when ok=false (e.g. "you already have a match going"). */
  error?: string;
  sessionId?: string;
  threadId?: string | null;
  inviteUrl?: string | null;
  expiryMinutes?: number;
}

// In-process serialization for the match-CLAIM (validity checks → session
// create). The bot is a single process, so chaining every claim through one
// promise means two concurrent matchers for the SAME pair (two queue clicks, a
// click racing the sweep, two /start-matches) can never both pass the duplicate-
// pair check and create overlapping sessions between the same two players. Only
// the cheap DB claim is serialized; the slow thread/invite I/O runs unlocked after.
let creationLock: Promise<unknown> = Promise.resolve();
function withCreationLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = creationLock.then(fn, fn);
  creationLock = next.then(
    () => undefined,
    () => undefined,
  );
  return next as Promise<T>;
}

// Create a league-match (or shootout) invite between two players already known
// to share `division` in `season`: validates there's no duplicate/in-flight
// match, creates the WAITING_ACCEPT MatchSession, opens the private thread under
// #league-matches, and posts the Accept/Decline invite. Lifted verbatim from
// start-match.ts so both the /start-match command and the league queue create
// matches the exact same way. `me` is the initiator (playerA on the session).
export async function createLeagueMatchInvite(opts: {
  client: Client;
  season: { id: string };
  division: { id: string };
  me: Player;
  opp: Player;
  isShootout?: boolean;
  /** Context channel stored on the session (where it was triggered from). */
  channelId: string;
  /** How the match was started — "queue" or "command" — recorded in the audit
   * log so queue usage can be counted (kept for the keep/kill decision). */
  source?: string;
  actor: Parameters<typeof recordAudit>[0]["actor"];
}): Promise<CreateLeagueMatchInviteResult> {
  const { client, season, division, me, opp, channelId, actor } = opts;
  const isShootout = opts.isShootout ?? false;

  type Created = Awaited<ReturnType<typeof prisma.matchSession.create>>;
  const claim = await withCreationLock(
    async (): Promise<{ error: string } | { session: Created; expiryMinutes: number }> => {
      // Banned players can't start OR be pulled into any match (league or shootout).
      const banned = await bannedPlayerIds([me.id, opp.id]);
      if (banned.has(me.id)) return { error: BANNED_MESSAGE };
      if (banned.has(opp.id)) {
        return { error: `${sanitizeName(opp.displayName)} is banned from the league right now, so you can't start a match with them.` };
      }
      const [playerAId, playerBId] = me.id < opp.id ? [me.id, opp.id] : [opp.id, me.id];
      const existing = await prisma.match.findUnique({
        where: {
          divisionId_playerAId_playerBId_format: { divisionId: division.id, playerAId, playerBId, format: "LEAGUE_BO2" },
        },
      });
      if (!isShootout && existing && existing.status === "CONFIRMED") {
        return {
          error: `You've already played ${sanitizeName(opp.displayName)} this season (${existing.gamesWonA}-${existing.gamesWonB}).`,
        };
      }
      // Schedule enforcement (mirrors the report path in reporting.ts): on a
      // locked schedule the ONLY valid league matchups are the pre-created
      // assigned ones. No BO2 row for this pair = they're not on each other's
      // schedule = refuse to even open the match. Without this, /start-match let
      // you spin up a thread with any division-mate (the report was blocked, but
      // the thread wasn't) — which is how an "unscheduled match" got started.
      // Shootouts (tiebreakers) are exempt: they aren't pre-scheduled pairings.
      if (!isShootout && !existing) {
        const { scheduleLocked } = (await prisma.season.findUnique({
          where: { id: season.id },
          select: { scheduleLocked: true },
        })) ?? { scheduleLocked: false };
        if (scheduleLocked) {
          return {
            error: `${sanitizeName(opp.displayName)} isn't on your schedule this season — you only play your assigned matchups. If this should be a match, ask an admin.`,
          };
        }
      }
      if (isShootout) {
        const existingShootout = await prisma.match.findUnique({
          where: {
            divisionId_playerAId_playerBId_format: { divisionId: division.id, playerAId, playerBId, format: "SHOOTOUT_BO1" },
          },
        });
        if (existingShootout) return { error: `A shootout result is already recorded for this pair.` };
      }

      // One match at a time BETWEEN THE SAME TWO PLAYERS — nothing stops either
      // of them being in other matches with other people at the same time (that's
      // fine, and often useful). This only blocks a duplicate concurrent session
      // for this exact pair. Reliable because the whole claim is serialized.
      const dupe = await prisma.matchSession.findFirst({
        where: {
          state: { notIn: ["COMPLETE", "CANCELLED"] },
          OR: [
            { playerAId: me.id, playerBId: opp.id },
            { playerAId: opp.id, playerBId: me.id },
          ],
        },
        select: { id: true },
      });
      if (dupe) {
        return {
          error: `You already have a match in progress with ${sanitizeName(opp.displayName)} — finish or cancel that one before starting another with them.`,
        };
      }

      await bootstrapPresetsAndPointers();
      const preset = await presetForSeason(season.id);
      if (!preset || preset.decks.length === 0 || preset.stakes.length === 0) {
        return { error: `This season's match config preset is empty — ask an admin to set one up.` };
      }

      const settings = await getLeagueSettingsForSeason(season.id);
      const expiresAt = new Date(Date.now() + settings.matchInviteExpiryMinutes * 60 * 1000);
      const created = await prisma.matchSession.create({
        data: {
          divisionId: division.id,
          playerAId: me.id,
          playerBId: opp.id,
          state: "WAITING_ACCEPT",
          channelId,
          expiresAt,
          isShootout,
          bestOf: isShootout ? 1 : 2,
        },
      });
      // Starting a match drops both players from the league queue — covers the
      // /start-match path too, not just queue-triggered matches.
      await prisma.queueEntry.deleteMany({ where: { playerId: { in: [me.id, opp.id] } } }).catch(() => {});
      return { session: created, expiryMinutes: settings.matchInviteExpiryMinutes };
    },
  );

  if ("error" in claim) return { ok: false, error: claim.error };
  const session = claim.session;
  const expiryMinutes = claim.expiryMinutes;

  // Private thread under #league-matches (no staff ManageThreads there, so it
  // stays between the two players until someone runs /helper).
  let threadId: string | null = null;
  try {
    let parent: TextChannel | null = null;
    const matchesChannelId = await ensureLeagueMatchesChannel();
    if (matchesChannelId) {
      const mc = await client.channels.fetch(matchesChannelId).catch(() => null);
      if (mc && mc.type === ChannelType.GuildText) parent = mc as TextChannel;
    }
    if (!parent) {
      const fallback = await client.channels.fetch(channelId).catch(() => null);
      if (fallback && fallback.type === ChannelType.GuildText) parent = fallback as TextChannel;
    }
    if (!parent) throw new Error("no parent channel for the match thread");
    const suffix = session.id.slice(-6);
    const thread = await parent.threads.create({
      name: `Match: ${me.displayName} vs ${opp.displayName} (${suffix})`,
      type: ChannelType.PrivateThread,
      autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
      invitable: false,
    });
    // Add both players in parallel — independent calls, so don't pay two
    // round-trips serially (matters when Discord's API is slow).
    await Promise.all([
      thread.members.add(me.discordId).catch(() => {}),
      thread.members.add(opp.discordId).catch(() => {}),
    ]);
    // First thing in the thread: the moderation-recording notice (pinned).
    await postModerationNotice(thread);
    threadId = thread.id;
  } catch (err) {
    console.warn("[league-match-invite] failed to create private thread:", err);
    // Roll the session back so a thread-less invite doesn't linger.
    await prisma.matchSession.update({ where: { id: session.id }, data: { state: "CANCELLED" } }).catch(() => {});
    return { ok: false, error: "Couldn't create the match thread — an admin may need to grant Create Private Threads." };
  }

  const updatedSession = await prisma.matchSession.update({
    where: { id: session.id },
    data: { threadId },
  });

  const { embeds, components, content } = renderMatch(updatedSession, me, opp);
  let inviteUrl: string | null = null;
  try {
    const thread = await client.channels.fetch(threadId);
    if (thread && thread.type === ChannelType.PrivateThread) {
      const sent = await thread.send({
        content:
          content ||
          `<@${opp.discordId}> — <@${me.discordId}> wants to play. Accept within ${expiryMinutes} min.`,
        embeds,
        components,
      });
      await prisma.matchSession
        .update({ where: { id: session.id }, data: { matchMessageId: sent.id } })
        .catch((err) => console.warn(`[league-match-invite] persist messageId failed:`, err));
      inviteUrl = sent.url;
    }
  } catch (err) {
    console.warn("[league-match-invite] failed to post invite into thread:", err);
  }

  recordAudit({
    actor,
    action: "match.create",
    targetType: "MatchSession",
    targetId: session.id,
    summary: `Invited ${opp.displayName} to ${isShootout ? "a showdown" : "a league match"}`,
    metadata: {
      isShootout,
      divisionId: division.id,
      seasonId: season.id,
      opponentDiscordId: opp.discordId,
      threadId,
      source: opts.source ?? "command",
    },
  });

  return {
    ok: true,
    sessionId: session.id,
    threadId,
    inviteUrl,
    expiryMinutes,
  };
}
