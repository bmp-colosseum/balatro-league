// DMs the first-timer onboarding guide (src/onboarding-guide.ts) to one
// player. Idempotent per Discord user via DmDelivery (kind
// "onboarding-guide") -- a player with an existing "sent" row is skipped, so
// re-running the web admin's "send to all new players" action never
// double-DMs anyone. Used by the bot's notify.onboarding-guide pg-boss worker
// (src/queue.ts); the web admin's "Preview: DM the guide to me" button
// enqueues the same job targeted at the admin's own player id.

import { prisma } from "./db.js";
import { tryGetDiscordClient } from "./discord.js";
import { isUndeliverableDm } from "./discord-helpers.js";
import { recordDmDelivery } from "./dm-delivery.js";
import { webUrl } from "./web-url.js";
import { formatSeasonLabel } from "./format-season.js";
import { seasonWindowLines } from "./season-timing.js";
import { getConfig, LeagueConfigKey } from "./league-config.js";
import { env } from "./env.js";
import { buildOnboardingGuideMessages } from "./onboarding-guide.js";

export const ONBOARDING_GUIDE_KIND = "onboarding-guide";

export type OnboardingGuideOutcome =
  | "sent"
  | "skipped-already-sent"
  | "skipped-no-player"
  | "skipped-undeliverable";

// Send (or skip, if already sent) the onboarding guide DM to one player.
// Throws on a transient failure (client not ready) so pg-boss retries;
// permanently-undeliverable DMs (closed/blocked) are recorded as failed and
// NOT retried, same convention as the other notify.* workers in queue.ts.
export async function sendOnboardingGuideDm(playerId: string): Promise<OnboardingGuideOutcome> {
  const player = await prisma.player.findUnique({
    where: { id: playerId },
    select: { discordId: true },
  });
  if (!player) return "skipped-no-player";

  const already = await prisma.dmDelivery.findFirst({
    where: { discordId: player.discordId, kind: ONBOARDING_GUIDE_KIND, status: "sent" },
    select: { id: true },
  });
  if (already) return "skipped-already-sent";

  const client = tryGetDiscordClient();
  if (!client) throw new Error("Discord client not ready -- will retry");

  const season = await prisma.season.findFirst({
    where: { isActive: true },
    select: { number: true, subtitle: true, startedAt: true, scheduledStartAt: true, scheduledEndAt: true },
  });
  const seasonLabel = season ? formatSeasonLabel(season) : "the current season";
  const windowLines = season
    ? seasonWindowLines({
        scheduledStartAt: season.scheduledStartAt,
        startedAt: season.startedAt,
        scheduledEndAt: season.scheduledEndAt,
        isActive: true,
      })
    : [];
  const supportChannelId = await getConfig(LeagueConfigKey.SupportChannelId);
  const guildId = env.DISCORD_GUILD_ID;
  const supportChannelUrl =
    guildId && supportChannelId ? `https://discord.com/channels/${guildId}/${supportChannelId}` : null;

  const messages = buildOnboardingGuideMessages({
    seasonLabel,
    seasonWindowLines: windowLines,
    standingsUrl: webUrl("standings"),
    supportChannelUrl,
  });

  try {
    const user = await client.users.fetch(player.discordId);
    for (const content of messages) {
      await user.send({ content });
    }
    await recordDmDelivery({
      discordId: player.discordId,
      status: "sent",
      content: messages.join("\n\n---\n\n"),
      kind: ONBOARDING_GUIDE_KIND,
    });
    return "sent";
  } catch (err) {
    if (isUndeliverableDm(err)) {
      const code = (err as { code?: number })?.code;
      console.warn(`[onboarding-guide] ${player.discordId} undeliverable -- skipping:`, (err as Error)?.message);
      await recordDmDelivery({
        discordId: player.discordId,
        status: "failed",
        kind: ONBOARDING_GUIDE_KIND,
        errorCode: typeof code === "number" ? code : null,
        errorMsg: (err as Error)?.message ?? null,
      });
      return "skipped-undeliverable"; // terminal -- don't retry an unreachable DM
    }
    console.warn(`[onboarding-guide] send to ${player.discordId} failed -- will retry:`, err);
    throw err;
  }
}
