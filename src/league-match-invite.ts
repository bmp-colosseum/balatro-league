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
// promise means two concurrent matchers (two queue clicks, a click racing the
// sweep, two /start-matches) can never both pass the "already in a match" check
// and create overlapping sessions. Only the cheap DB claim is serialized; the
// slow thread/invite I/O runs unlocked afterward.
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
      const [playerAId, playerBId] = me.id < opp.id ? [me.id, opp.id] : [opp.id, me.id];
      const existing = await prisma.match.findUnique({
        where: {
          divisionId_playerAId_playerBId_format: { divisionId: division.id, playerAId, playerBId, format: "LEAGUE_BO2" },
        },
      });
      if (!isShootout && existing && existing.status === "CONFIRMED") {
        return {
          error: `You've already played ${opp.displayName} this season (${existing.gamesWonA}-${existing.gamesWonB}).`,
        };
      }
      if (isShootout) {
        const existingShootout = await prisma.match.findUnique({
          where: {
            divisionId_playerAId_playerBId_format: { divisionId: division.id, playerAId, playerBId, format: "SHOOTOUT_BO1" },
          },
        });
        if (existingShootout) return { error: `A shootout result is already recorded for this pair.` };
      }

      // Single-match invariant: NEITHER player may already be in a non-terminal
      // session — with this opponent OR anyone else. Stops a player being pulled
      // into two matches at once. Reliable because the whole claim is serialized.
      const busy = await prisma.matchSession.findFirst({
        where: {
          state: { notIn: ["COMPLETE", "CANCELLED"] },
          OR: [{ playerAId: me.id }, { playerBId: me.id }, { playerAId: opp.id }, { playerBId: opp.id }],
        },
        select: { playerAId: true, playerBId: true },
      });
      if (busy) {
        const meBusy = busy.playerAId === me.id || busy.playerBId === me.id;
        return {
          error: meBusy
            ? `You're already in a match — finish it (or have an admin cancel it) before starting another.`
            : `${opp.displayName} is already in a match — try again once they're free.`,
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
    await thread.members.add(me.discordId).catch(() => {});
    await thread.members.add(opp.discordId).catch(() => {});
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
