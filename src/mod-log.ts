// Moderation transcript capture for match + dispute threads.
//
// Why this exists: match threads are DELETED when a match closes, so Discord
// keeps no record. If a player says something abusive (then deletes it / denies
// it), there's nothing to point to. This mirrors every human message in those
// threads into the DB AS IT'S POSTED — keeping edits and deletes — so staff have
// evidence. Players are told up front via a pinned notice in each thread.
//
// Scope is deliberately narrow: only threads that resolve to a MatchSession
// (league or casual match) or a Match's dispute thread. Everything else is
// ignored. Retention is short — a daily purge (modlog.purge) drops old rows.
//
// Capture is best-effort: a failure here must NEVER break the match flow, so
// every entry point swallows its own errors.

import type { Message, PartialMessage, ThreadChannel } from "discord.js";
import { prisma } from "./db.js";

// Disclosure posted as the bot's FIRST message in each tracked thread (and
// pinned), so players see it the moment the thread opens.
const NOTICE_TEXT =
  `🔒 **Heads up — messages in this thread are recorded for moderation purposes.**\n` +
  `Keep it civil: play your match, sort out scheduling, report the result. ` +
  `Staff can review this thread if there's a dispute or a conduct report.`;

// Post + pin the disclosure. Call this right after a match/dispute thread is
// created, BEFORE any other content, so it's the first thing in the thread.
// Best-effort — a failure here must never block opening the match.
export async function postModerationNotice(thread: ThreadChannel): Promise<void> {
  try {
    const msg = await thread.send(NOTICE_TEXT);
    await msg.pin().catch(() => {});
  } catch (err) {
    console.warn("[mod-log] notice post failed:", err);
  }
}

// Only mirror image attachments, and only when small enough to be worth keeping
// as evidence. (The CDN url is always recorded regardless; bytes are the backup
// for when the thread — and its signed url — disappear.)
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

// How long captured transcripts are kept before the daily modlog.purge drops
// them. Short on purpose — long enough to settle a fresh dispute, not an archive.
export const MODLOG_RETENTION_DAYS = 7;

type Resolution = { kind: "match" | "dispute"; matchId: string | null; matchSessionId: string | null };

// Positive resolutions are cached forever (a thread id maps to one session/match
// for its whole life). Negative results aren't cached — a brand-new match thread
// must never be missed because we cached "untracked" a moment too early.
const resolved = new Map<string, Resolution>();

async function resolveThread(threadId: string): Promise<Resolution | null> {
  const cached = resolved.get(threadId);
  if (cached) return cached;

  const session = await prisma.matchSession.findFirst({
    where: { threadId },
    select: { id: true, pairingId: true },
  });
  if (session) {
    const r: Resolution = { kind: "match", matchId: session.pairingId, matchSessionId: session.id };
    resolved.set(threadId, r);
    return r;
  }
  const match = await prisma.match.findFirst({
    where: { disputeThreadId: threadId },
    select: { id: true },
  });
  if (match) {
    const r: Resolution = { kind: "dispute", matchId: match.id, matchSessionId: null };
    resolved.set(threadId, r);
    return r;
  }
  return null;
}

// Pull image attachments down as bytes (best-effort), plus always record the
// url/filename/type so even a skipped/oversized file is on the record.
async function collectAttachments(
  message: Message,
): Promise<Array<{ filename: string; contentType: string | null; sourceUrl: string; bytes: Uint8Array<ArrayBuffer> | null }>> {
  const out: Array<{ filename: string; contentType: string | null; sourceUrl: string; bytes: Uint8Array<ArrayBuffer> | null }> = [];
  for (const att of message.attachments.values()) {
    const contentType = att.contentType ?? null;
    let bytes: Uint8Array<ArrayBuffer> | null = null;
    const isImage = !!contentType && contentType.startsWith("image/");
    if (isImage && att.size <= MAX_ATTACHMENT_BYTES) {
      try {
        const res = await fetch(att.url);
        if (res.ok) {
          const buf = new Uint8Array(await res.arrayBuffer());
          if (buf.length <= MAX_ATTACHMENT_BYTES) bytes = buf;
        }
      } catch {
        // Keep the url even if the download fails.
      }
    }
    out.push({ filename: att.name ?? "attachment", contentType, sourceUrl: att.url, bytes });
  }
  return out;
}

// messageCreate → mirror the message if it's in a tracked thread. Skips bots
// (the bot's own embeds/notice) and non-thread channels.
export async function captureCreate(message: Message): Promise<void> {
  try {
    if (!message.inGuild() || message.author?.bot) return;
    if (!message.channel.isThread()) return;
    const res = await resolveThread(message.channelId);
    if (!res) return;

    const attachments = await collectAttachments(message);
    const authorName = message.member?.displayName ?? message.author.username;
    await prisma.threadMessage.upsert({
      where: { discordMessageId: message.id },
      create: {
        discordMessageId: message.id,
        threadId: message.channelId,
        kind: res.kind,
        matchId: res.matchId,
        matchSessionId: res.matchSessionId,
        authorDiscordId: message.author.id,
        authorName,
        content: message.content ?? "",
        postedAt: message.createdAt,
        attachments: attachments.length
          ? { create: attachments.map((a) => ({ filename: a.filename, contentType: a.contentType, sourceUrl: a.sourceUrl, bytes: a.bytes })) }
          : undefined,
      },
      // Already captured (re-delivered event) — leave it untouched.
      update: {},
    });
    // The disclosure is posted as the thread's first message at creation
    // (postModerationNotice), so nothing to do here.
  } catch (err) {
    console.warn("[mod-log] capture failed:", err);
  }
}

// messageUpdate → record an edit, keeping the FIRST original content as evidence.
export async function captureEdit(updated: Message | PartialMessage): Promise<void> {
  try {
    const existing = await prisma.threadMessage.findUnique({
      where: { discordMessageId: updated.id },
      select: { id: true, content: true, originalContent: true },
    });
    if (!existing) return; // not a tracked thread / never captured
    let newContent = updated.content;
    if (newContent == null && updated.partial) {
      const full = await updated.fetch().catch(() => null);
      newContent = full?.content ?? null;
    }
    if (newContent == null || newContent === existing.content) return;
    await prisma.threadMessage.update({
      where: { id: existing.id },
      data: {
        content: newContent,
        // Keep the earliest original we have; don't overwrite on a second edit.
        originalContent: existing.originalContent ?? existing.content,
        editedAt: new Date(),
      },
    });
  } catch (err) {
    console.warn("[mod-log] edit capture failed:", err);
  }
}

// messageDelete → mark deleted but KEEP the content (the whole point). Works with
// partials (we only need the id). Harmless no-op for untracked messages.
export async function captureDelete(deleted: Message | PartialMessage): Promise<void> {
  try {
    await prisma.threadMessage.updateMany({
      where: { discordMessageId: deleted.id, deletedAt: null },
      data: { deletedAt: new Date() },
    });
  } catch (err) {
    console.warn("[mod-log] delete capture failed:", err);
  }
}

// Stamp the league Match id onto every captured row for a thread once the match
// completes — so the transcript is durably linked to the match even after the
// MatchSession is swept. Best-effort.
export async function backfillMatchId(threadId: string, matchId: string): Promise<void> {
  try {
    await prisma.threadMessage.updateMany({ where: { threadId }, data: { matchId } });
  } catch (err) {
    console.warn("[mod-log] match backfill failed:", err);
  }
}
