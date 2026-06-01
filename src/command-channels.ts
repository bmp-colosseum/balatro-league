// Channel-scope check for slash commands. Used by the InteractionCreate
// handler in src/index.ts to gate commands marked `channelScope: "match-flow"`
// to (a) the configured bot-commands channel, or (b) any per-division text
// channel managed by the bot.
//
// Division channels are looked up by Division.discordChannelId — set when
// the bot bootstraps a season's division channels. This lets us avoid an
// env-driven whitelist that admin would have to update every season.

import { resolveBotCommandsChannelId } from "./bot-commands-channel.js";
import { prisma } from "./db.js";
import type { ChannelScope } from "./commands/types.js";

export interface ChannelCheckResult {
  allowed: boolean;
  // Markdown-ready reason to show the user when blocked. Includes a Discord
  // <#channelId> mention for the bot-commands channel when set so they can
  // click straight to it.
  reason?: string;
}

export async function checkChannelScope(
  scope: ChannelScope | undefined,
  channelId: string | null,
): Promise<ChannelCheckResult> {
  if (!scope || scope === "any") return { allowed: true };
  if (!channelId) return { allowed: false, reason: "This command must be used in a channel." };

  if (scope === "match-flow") {
    const botCommandsChannelId = await resolveBotCommandsChannelId();
    if (botCommandsChannelId && channelId === botCommandsChannelId) {
      return { allowed: true };
    }
    const div = await prisma.division.findFirst({
      where: { discordChannelId: channelId },
      select: { id: true },
    });
    if (div) return { allowed: true };
    const botCommandsMention = botCommandsChannelId
      ? `<#${botCommandsChannelId}>`
      : "the bot-commands channel (admin: run /league set-bot-commands-channel)";
    return {
      allowed: false,
      reason: `Run this in your division channel or ${botCommandsMention}.`,
    };
  }

  if (scope === "division-only") {
    const div = await prisma.division.findFirst({
      where: { discordChannelId: channelId },
      select: { id: true },
    });
    if (div) return { allowed: true };
    return {
      allowed: false,
      reason: "Run this in your division channel — league matches are scoped to a division.",
    };
  }

  return { allowed: true };
}
