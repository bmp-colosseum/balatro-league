// Read-side for the moderation transcripts (captured by the bot's mod-log).
// Staff-only — callers gate with requireAdmin. The bot is the only writer; these
// are pure reads for the /admin/transcripts views.

import { prisma } from "@/lib/prisma";

export interface TranscriptSummary {
  threadId: string;
  kind: string; // "match" | "dispute"
  matchId: string | null;
  count: number;
  deleted: number; // how many messages were deleted (kept as evidence)
  participants: string[];
  firstAt: Date | null;
  lastAt: Date | null;
}

// One row per captured thread, newest activity first.
export async function listTranscripts(limit = 200): Promise<TranscriptSummary[]> {
  const groups = await prisma.threadMessage.groupBy({
    by: ["threadId"],
    _count: { _all: true },
    _min: { postedAt: true },
    _max: { postedAt: true },
    orderBy: { _max: { postedAt: "desc" } },
    take: limit,
  });
  const threadIds = groups.map((g) => g.threadId);
  if (threadIds.length === 0) return [];

  const rows = await prisma.threadMessage.findMany({
    where: { threadId: { in: threadIds } },
    select: { threadId: true, authorName: true, kind: true, matchId: true, deletedAt: true },
  });
  const meta = new Map<string, { kind: string; matchId: string | null; participants: Set<string>; deleted: number }>();
  for (const r of rows) {
    let m = meta.get(r.threadId);
    if (!m) {
      m = { kind: r.kind, matchId: r.matchId, participants: new Set(), deleted: 0 };
      meta.set(r.threadId, m);
    }
    m.participants.add(r.authorName);
    if (r.matchId) m.matchId = r.matchId;
    if (r.deletedAt) m.deleted += 1;
  }

  return groups.map((g) => {
    const m = meta.get(g.threadId);
    return {
      threadId: g.threadId,
      kind: m?.kind ?? "match",
      matchId: m?.matchId ?? null,
      count: g._count._all,
      deleted: m?.deleted ?? 0,
      participants: [...(m?.participants ?? [])],
      firstAt: g._min.postedAt,
      lastAt: g._max.postedAt,
    };
  });
}

export interface TranscriptMessage {
  id: string;
  kind: string;
  matchId: string | null;
  authorName: string;
  authorDiscordId: string;
  content: string;
  postedAt: Date;
  editedAt: Date | null;
  originalContent: string | null;
  deletedAt: Date | null;
  attachments: Array<{ id: string; filename: string; contentType: string | null; sourceUrl: string }>;
}

export interface TranscriptHeader {
  threadId: string;
  kind: string;
  matchId: string | null;
  participants: string[];
  count: number;
  deleted: number;
  firstAt: Date | null;
  lastAt: Date | null;
}

// Full chronological transcript for one thread + a header summary. Bytes are NOT
// loaded here (served lazily by the attachment route); we only carry the metadata
// needed to render.
export async function loadTranscript(
  threadId: string,
): Promise<{ header: TranscriptHeader; messages: TranscriptMessage[] }> {
  const messages = await prisma.threadMessage.findMany({
    where: { threadId },
    orderBy: { postedAt: "asc" },
    select: {
      id: true,
      kind: true,
      matchId: true,
      authorName: true,
      authorDiscordId: true,
      content: true,
      postedAt: true,
      editedAt: true,
      originalContent: true,
      deletedAt: true,
      attachments: { select: { id: true, filename: true, contentType: true, sourceUrl: true } },
    },
  });
  const header: TranscriptHeader = {
    threadId,
    kind: messages.find((m) => m.kind)?.kind ?? "match",
    matchId: messages.find((m) => m.matchId)?.matchId ?? null,
    participants: [...new Set(messages.map((m) => m.authorName))],
    count: messages.length,
    deleted: messages.filter((m) => m.deletedAt).length,
    firstAt: messages[0]?.postedAt ?? null,
    lastAt: messages[messages.length - 1]?.postedAt ?? null,
  };
  return { header, messages };
}

// For the attachment route: the stored bytes (if any) + how to fall back.
export async function loadAttachment(id: string) {
  return prisma.threadMessageAttachment.findUnique({
    where: { id },
    select: { bytes: true, contentType: true, filename: true, sourceUrl: true },
  });
}
