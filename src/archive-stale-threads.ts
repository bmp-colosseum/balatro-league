// Safety-net cron: lock + archive Discord threads for MatchSessions
// that have completed or been cancelled but whose thread is still
// open. The inline closeMatchChannel() on completion handles the
// happy path; this catches the cases where that call failed (bot
// restart mid-completion, Discord 5xx, etc.) so we don't leak
// active threads against the 1000-thread soft cap.
//
// Idempotent: marks MatchSession.threadArchivedAt once processed so
// subsequent sweeps skip the session. Even unrecoverable failures
// (thread deleted, permissions revoked, channel gone) mark the row
// — otherwise the cron would hammer the same broken thread forever.

import { ChannelType, type ThreadChannel } from "discord.js";
import { prisma } from "./db.js";
import { tryGetDiscordClient } from "./discord.js";
import { logDiscordError } from "./log-discord-error.js";

const GRACE_HOURS = 24;
const MAX_PER_RUN = 50;

export async function archiveStaleThreads(): Promise<{
  scanned: number;
  archived: number;
  alreadyArchived: number;
  vanished: number;
}> {
  const client = tryGetDiscordClient();
  if (!client) {
    console.warn("[archive.stale-threads] Discord client not ready; skipping");
    return { scanned: 0, archived: 0, alreadyArchived: 0, vanished: 0 };
  }

  // Grace window: gives the inline closure a chance to run + Discord
  // a chance to auto-archive on its own before we sweep. Anything
  // older than 24h that's still flagged unarchived is definitely
  // stuck and worth touching.
  const cutoff = new Date(Date.now() - GRACE_HOURS * 60 * 60 * 1000);
  const sessions = await prisma.matchSession.findMany({
    where: {
      state: { in: ["COMPLETE", "CANCELLED"] },
      threadId: { not: null },
      threadArchivedAt: null,
      createdAt: { lt: cutoff },
    },
    select: { id: true, threadId: true },
    orderBy: { createdAt: "asc" },
    take: MAX_PER_RUN,
  });

  let archived = 0;
  let alreadyArchived = 0;
  let vanished = 0;
  for (const s of sessions) {
    if (!s.threadId) continue;
    let outcome: "archived" | "already" | "vanished" = "vanished";
    try {
      const channel = await client.channels.fetch(s.threadId);
      if (!channel) {
        outcome = "vanished";
      } else if (
        channel.type === ChannelType.PrivateThread ||
        channel.type === ChannelType.PublicThread
      ) {
        const thread = channel as ThreadChannel;
        if (thread.archived) {
          outcome = "already";
        } else {
          await thread.setLocked(true, "Match complete (cron sweep)").catch((err) =>
            logDiscordError("archive-stale-threads.setLocked", err, { threadId: s.threadId!, sessionId: s.id }),
          );
          await thread.setArchived(true, "Match complete (cron sweep)").catch((err) =>
            logDiscordError("archive-stale-threads.setArchived", err, { threadId: s.threadId!, sessionId: s.id }),
          );
          outcome = "archived";
        }
      } else {
        // Not a thread (legacy per-match text channel). Nothing to do here;
        // closeMatchChannel handled those inline. Mark as processed so the
        // sweep doesn't keep picking them up.
        outcome = "already";
      }
    } catch {
      // Thread deleted, bot kicked, or permissions revoked — nothing to do.
      outcome = "vanished";
    }
    // Mark processed regardless of outcome — re-trying a vanished thread
    // every hour wastes API budget.
    await prisma.matchSession.update({
      where: { id: s.id },
      data: { threadArchivedAt: new Date() },
    });
    if (outcome === "archived") archived++;
    else if (outcome === "already") alreadyArchived++;
    else vanished++;
  }

  console.log(
    `[archive.stale-threads] scanned=${sessions.length} archived=${archived} ` +
      `alreadyArchived=${alreadyArchived} vanished=${vanished}`,
  );
  return { scanned: sessions.length, archived, alreadyArchived, vanished };
}
