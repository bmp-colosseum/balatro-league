// Small reusable "post a message to #devops" helper. Mirrors the posting
// the queue-stall alarm does, factored out so other safeguards (config
// preflight checks, health checks, …) can alert ops without duplicating
// the channel-resolve + ping logic. Best-effort: logs and returns false if
// there's no devops channel / client.

import { ChannelType, type TextChannel } from "discord.js";
import { prisma } from "./db.js";
import { tryGetDiscordClient } from "./discord.js";
import { resolveDevopsChannelId } from "./devops-channel.js";

export async function postDevopsAlert(message: string, pingDevops = false): Promise<boolean> {
  const channelId = await resolveDevopsChannelId();
  const client = tryGetDiscordClient();
  if (!channelId || !client) {
    console.warn("[devops-alert] no devops channel/client; logging only:", message);
    return false;
  }
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || channel.type !== ChannelType.GuildText) {
      console.warn(`[devops-alert] channel ${channelId} not a text channel`);
      return false;
    }
    let prefix = "";
    if (pingDevops) {
      const bindings = await prisma.roleBinding.findMany({ where: { tier: "DEVOPS" } });
      const mentions = bindings.map((b) => `<@&${b.discordRoleId}>`).join(" ");
      if (mentions) prefix = mentions + " ";
    }
    await (channel as TextChannel).send({ content: prefix + message });
    return true;
  } catch (err) {
    console.warn("[devops-alert] post failed:", err);
    return false;
  }
}
