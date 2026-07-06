// Capture inbound DMs players send the bot so staff can read + reply from the
// web DM console (/admin/dms). The bot has NO conversational logic here — this
// only records the message. Guild messages are ignored (mod-log owns those).
// Idempotent on discordMessageId so a re-delivered gateway event can't
// double-insert. Requires the DirectMessages intent + Partials.Channel/Message
// (wired in index.ts) to receive DM events for uncached channels.

import type { Message } from "discord.js";
import { prisma } from "./db.js";

export async function captureInboundDm(message: Message): Promise<void> {
  try {
    // DMs only. inGuild() is true for guild messages -> skip.
    if (message.inGuild()) return;
    // Never store the bot's own messages (or any other bot's).
    if (message.author?.bot) return;

    const content = message.content ?? "";
    const attachments = [...message.attachments.values()].map((a) => ({
      filename: a.name ?? "file",
      url: a.url,
    }));
    // Nothing meaningful to record (e.g. an empty system message).
    if (!content && attachments.length === 0) return;

    const authorName = message.author.globalName ?? message.author.username;

    await prisma.inboundDm.upsert({
      where: { discordMessageId: message.id },
      create: {
        discordMessageId: message.id,
        authorDiscordId: message.author.id,
        authorName,
        content,
        attachmentsJson: attachments.length ? JSON.stringify(attachments) : null,
        receivedAt: message.createdAt,
      },
      // Re-delivered event — leave the stored copy untouched.
      update: {},
    });
  } catch (err) {
    console.warn("[inbound-dm] capture failed:", err);
  }
}
