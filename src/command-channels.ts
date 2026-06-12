// Channel-scope check for slash commands. Used by the InteractionCreate
// handler in src/index.ts to gate commands marked `channelScope: "match-flow"`
// to (a) the configured bot-commands channel, or (b) any per-division text
// channel managed by the bot.
//
// Division channels are looked up by Division.discordChannelId — set when
// the bot bootstraps a season's division channels. This lets us avoid an
// env-driven whitelist that admin would have to update every season.

import { resolveBotCommandsChannelIds } from "./bot-commands-channel.js";
import { prisma } from "./db.js";
import type { ChannelScope } from "./commands/types.js";

// Human-readable list of the allowed channels for an error message. Shows
// clickable <#id> mentions, or guidance when none are configured.
function allowedMention(ids: string[]): string {
  if (ids.length === 0) return "the bot-commands channel (admin: set it in /admin/config)";
  return ids.map((id) => `<#${id}>`).join(" or ");
}

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
  // For threads, the PARENT channel id. A command run in a thread is allowed if
  // the thread's parent channel is allowed — so e.g. /helper still works inside
  // a match/dispute thread spawned under the bot-commands channel.
  parentId?: string | null,
): Promise<ChannelCheckResult> {
  if (!scope || scope === "any") return { allowed: true };
  if (!channelId) return { allowed: false, reason: "This command must be used in a channel." };
  const ids = [channelId, ...(parentId ? [parentId] : [])];

  if (scope === "match-flow") {
    const allowed = await resolveBotCommandsChannelIds();
    if (ids.some((id) => allowed.includes(id))) return { allowed: true };
    const div = await prisma.division.findFirst({
      where: { discordChannelId: { in: ids } },
      select: { id: true },
    });
    if (div) return { allowed: true };
    return {
      allowed: false,
      reason: `Run this in your division channel or ${allowedMention(allowed)}.`,
    };
  }

  if (scope === "division-only") {
    const div = await prisma.division.findFirst({
      where: { discordChannelId: { in: ids } },
      select: { id: true },
    });
    if (div) return { allowed: true };
    return {
      allowed: false,
      reason: "Run this in your division channel — league matches are scoped to a division.",
    };
  }

  if (scope === "bot-commands-only") {
    const allowed = await resolveBotCommandsChannelIds();
    if (ids.some((id) => allowed.includes(id))) return { allowed: true };
    return {
      allowed: false,
      reason: `Run this in ${allowedMention(allowed)} — keeps public bot output out of the other channels.`,
    };
  }

  return { allowed: true };
}
