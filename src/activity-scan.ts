// Activity scan worker. Walks the league's HUMAN channels (division channels +
// #league-chat / #league-bot-commands / #league-feedback) and records each
// Discord user's most-recent message, so admins can spot registered players who
// have gone silent. Runs async (the activity.scan pg-boss job); the ActivityScan
// row is updated as it goes so /league scan-status can poll progress.

import { prisma } from "./db.js";
import { getDiscordClient } from "./discord.js";
import { getConfig, LeagueConfigKey } from "./league-config.js";

// Hard cap on messages fetched per channel, so a busy channel can't run the
// scan away on rate limits. 100/fetch → at most this/100 fetches per channel.
const PER_CHANNEL_CAP = 3000;

async function collectScanChannels(seasonId: string): Promise<string[]> {
  const ids = new Set<string>();
  const divisions = await prisma.division.findMany({
    where: { seasonId, discordChannelId: { not: null } },
    select: { discordChannelId: true },
  });
  for (const d of divisions) if (d.discordChannelId) ids.add(d.discordChannelId);
  for (const key of [
    LeagueConfigKey.GeneralChannelId, // #league-chat
    LeagueConfigKey.BotCommandsChannelId,
    LeagueConfigKey.FeedbackChannelId,
  ]) {
    const v = await getConfig(key);
    if (v) ids.add(v);
  }
  return [...ids];
}

export async function runActivityScan(scanId: string): Promise<void> {
  const scan = await prisma.activityScan.findUnique({ where: { id: scanId } });
  if (!scan) return;
  try {
    const season = await prisma.season.findUnique({
      where: { id: scan.seasonId },
      select: { startedAt: true },
    });
    const since = (season?.startedAt ?? new Date(0)).getTime();
    const channels = await collectScanChannels(scan.seasonId);
    await prisma.activityScan.update({ where: { id: scanId }, data: { channelsTotal: channels.length } });

    const client = getDiscordClient();
    const lastPost = new Map<string, number>(); // discordId -> ms of most recent message
    let totalScanned = 0;
    let channelsDone = 0;

    for (const channelId of channels) {
      try {
        const ch = await client.channels.fetch(channelId).catch(() => null);
        if (ch && ch.isTextBased() && "messages" in ch) {
          let before: string | undefined;
          let perChannel = 0;
          while (perChannel < PER_CHANNEL_CAP) {
            const batch = await ch.messages.fetch({ limit: 100, before });
            if (batch.size === 0) break;
            let oldestTs = Number.POSITIVE_INFINITY;
            for (const m of batch.values()) {
              perChannel++;
              totalScanned++;
              if (m.createdTimestamp < oldestTs) oldestTs = m.createdTimestamp;
              if (m.author.bot) continue;
              const prev = lastPost.get(m.author.id) ?? 0;
              if (m.createdTimestamp > prev) lastPost.set(m.author.id, m.createdTimestamp);
            }
            before = batch.last()?.id;
            if (oldestTs < since) break; // paginated back past season start — enough
            if (batch.size < 100) break; // no more history
          }
        }
      } catch (err) {
        console.warn(`[activity-scan] channel ${channelId} failed:`, err);
      }
      channelsDone++;
      await prisma.activityScan
        .update({ where: { id: scanId }, data: { channelsDone, messagesScanned: totalScanned } })
        .catch(() => {});
    }

    const lastPostByDiscordId: Record<string, string> = {};
    for (const [discordId, ts] of lastPost) lastPostByDiscordId[discordId] = new Date(ts).toISOString();

    await prisma.activityScan.update({
      where: { id: scanId },
      data: {
        status: "DONE",
        finishedAt: new Date(),
        channelsDone,
        messagesScanned: totalScanned,
        lastPostByDiscordId,
      },
    });
  } catch (err) {
    console.warn("[activity-scan] failed:", err);
    await prisma.activityScan
      .update({
        where: { id: scanId },
        data: { status: "FAILED", finishedAt: new Date(), error: (err as Error).message.slice(0, 500) },
      })
      .catch(() => {});
  }
}
