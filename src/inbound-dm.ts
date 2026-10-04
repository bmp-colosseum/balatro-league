// Capture inbound DMs players send the bot so staff can read + reply from the
// web DM console (/admin/dms). The bot has NO conversational logic here — this
// only records the message. Guild messages are ignored (mod-log owns those).
// Idempotent on discordMessageId so a re-delivered gateway event can't
// double-insert. Requires the DirectMessages intent + Partials.Channel/Message
// (wired in index.ts) to receive DM events for uncached channels.

import type { Message } from "discord.js";
import { prisma } from "./db.js";
import { storeDmAttachments } from "./dm-attachment-store.js";

export async function captureInboundDm(message: Message): Promise<void> {
  try {
    // DMs only. inGuild() is true for guild messages -> skip.
    if (message.inGuild()) return;
    // Never store the bot's own messages (or any other bot's).
    if (message.author?.bot) return;

    const content = message.content ?? "";
    const rawAttachments = [...message.attachments.values()];
    const attachmentsMeta = rawAttachments.map((a) => ({
      filename: a.name ?? "file",
      url: a.url,
    }));
    // Nothing meaningful to record (e.g. an empty system message).
    if (!content && attachmentsMeta.length === 0) return;

    const authorName = message.author.globalName ?? message.author.username;

    const row = await prisma.inboundDm.upsert({
      where: { discordMessageId: message.id },
      create: {
        discordMessageId: message.id,
        authorDiscordId: message.author.id,
        authorName,
        content,
        attachmentsJson: attachmentsMeta.length ? JSON.stringify(attachmentsMeta) : null,
        receivedAt: message.createdAt,
      },
      // Re-delivered event — leave the stored copy untouched.
      update: {},
    });

    // Download + persist each attachment's bytes (the Discord CDN url
    // expires in ~24h -- the row above only kept the url). A re-delivered
    // gateway event hits the SAME InboundDm row (upsert, update: {}) -- skip
    // re-downloading if this id already has attachment rows from the first
    // delivery.
    if (rawAttachments.length > 0) {
      const alreadyCaptured = await prisma.dmAttachment.count({ where: { inboundDmId: row.id } });
      if (alreadyCaptured === 0) {
        await storeDmAttachments(
          row.id,
          rawAttachments.map((a) => ({
            filename: a.name ?? "file",
            contentType: a.contentType ?? null,
            url: a.url,
            knownSize: typeof a.size === "number" ? a.size : null,
          })),
        );
      }
    }
  } catch (err) {
    console.warn("[inbound-dm] capture failed:", err);
  }
}
