import "server-only";

import { prisma } from "@/lib/prisma";
import {
  buildDmThread,
  buildAttachmentViews,
  type InboundDmLite,
  type DmDeliveryLite,
  type InboundDmStatus,
  type DeliveryStatus,
  type ThreadItem,
  type DmAttachmentRef,
  type DmAttachmentView,
  type StoredDmAttachmentLite,
} from "@/lib/dm-format-core";
import { classifyConversation, type ConversationCategory, type ConversationStateLite } from "@/lib/dm-inbox-core";

// Loaders for the web DM console (/admin/dms). Read-only reductions over the
// InboundDm (what people sent us) + DmDelivery (what the bot tried to send)
// tables. Player display names are resolved best-effort so staff see a human
// name next to the raw Discord id.

// What the thread view renders per attachment: the original Discord link
// (fallback only) merged with the downloaded-and-stored copy, when one
// exists -- see buildAttachmentViews (dm-format-core.ts) for the pairing.
export type DmAttachment = DmAttachmentView;

// A player-message thread item, with its attachments joined back in (the
// pure buildDmThread core doesn't know about attachments -- they're a
// loader-level concern, merged in after the merge/sort).
export type ConversationItem =
  | (ThreadItem & { type: "player"; attachments: DmAttachment[] })
  | (ThreadItem & { type: "staff" })
  | (ThreadItem & { type: "bot" });

export interface ConversationView {
  discordId: string;
  displayName: string; // resolved Player.displayName, else last-known authorName snapshot, else discordId
  username: string | null; // resolved Player.username (@handle) if known
  unreadCount: number;
  lastActivityAt: Date;
  // What the reply form at the bottom of this thread will quote + mark
  // replied on send; null once everything's been answered.
  latestUnansweredContent: string | null;
  // Which inbox tab this conversation belongs in (dm-inbox-core.classifyConversation).
  category: ConversationCategory;
  // DmConversationState fields, surfaced for the per-card Archive/Unarchive
  // button and an "archived by" hint -- null means never archived.
  archivedAt: Date | null;
  archivedByName: string | null;
  items: ConversationItem[];
}

// attachmentsJson is a nullable JSON string of [{ filename, url }]. Parse
// defensively — a malformed blob must never break the console.
function parseAttachments(json: string | null): DmAttachmentRef[] {
  if (!json) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: DmAttachmentRef[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const rec = item as Record<string, unknown>;
    const url = typeof rec.url === "string" ? rec.url : "";
    if (!url) continue;
    const filename = typeof rec.filename === "string" && rec.filename ? rec.filename : "attachment";
    out.push({ filename, url });
  }
  return out;
}

// One query for every stored DmAttachment row across the given InboundDm
// ids (no N+1 -- the thread view needs this for every player message with
// attachments, up to 500 conversations' worth at once).
async function loadStoredAttachments(inboundDmIds: string[]): Promise<Map<string, StoredDmAttachmentLite[]>> {
  const ids = [...new Set(inboundDmIds)];
  if (ids.length === 0) return new Map();
  const rows = await prisma.dmAttachment.findMany({
    where: { inboundDmId: { in: ids } },
    // Insertion order -- both attachmentsJson and the DmAttachment rows are
    // built from the same per-message attachment list, in the same order
    // (see src/inbound-dm.ts / src/dm-attachment-backfill.ts), so this is
    // what buildAttachmentViews's positional pairing relies on.
    orderBy: { createdAt: "asc" },
    select: { id: true, inboundDmId: true, filename: true, contentType: true, size: true, error: true },
  });
  const map = new Map<string, StoredDmAttachmentLite[]>();
  for (const r of rows) {
    const arr = map.get(r.inboundDmId) ?? [];
    arr.push({ id: r.id, filename: r.filename, contentType: r.contentType, size: r.size, error: r.error });
    map.set(r.inboundDmId, arr);
  }
  return map;
}

interface ResolvedPlayer {
  displayName: string;
  username: string | null;
}

async function resolvePlayers(discordIds: string[]): Promise<Map<string, ResolvedPlayer>> {
  const ids = [...new Set(discordIds)];
  if (ids.length === 0) return new Map();
  const players = await prisma.player.findMany({
    where: { discordId: { in: ids } },
    select: { discordId: true, displayName: true, username: true },
  });
  return new Map(players.map((p) => [p.discordId, { displayName: p.displayName, username: p.username }]));
}

interface ArchiveStateRow {
  archivedAt: Date | null;
  archivedByName: string | null;
}

// Archive state rows are sparse -- most conversations never get one. Missing
// from this map means "never archived" (classifyConversation treats a null
// state the same as { archivedAt: null }).
async function loadConversationStates(discordIds: string[]): Promise<Map<string, ArchiveStateRow>> {
  const ids = [...new Set(discordIds)];
  if (ids.length === 0) return new Map();
  const rows = await prisma.dmConversationState.findMany({
    where: { discordId: { in: ids } },
    select: { discordId: true, archivedAt: true, archivedByName: true },
  });
  return new Map(rows.map((r) => [r.discordId, { archivedAt: r.archivedAt, archivedByName: r.archivedByName }]));
}

// One conversation per player: every InboundDm they've sent (capped 500,
// newest first) merged with every DmDelivery addressed to them in the last 90
// days (capped 3000) -- bot sends, failures, and staff replies all in one
// time-ordered thread. The merge/sort/unread-bookkeeping is the pure
// buildDmThread core; this just gathers the reads and resolves display names.
export async function loadDmConversations(): Promise<ConversationView[]> {
  const deliveriesSince = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const [inboundRaw, deliveriesRaw] = await Promise.all([
    prisma.inboundDm.findMany({ orderBy: { receivedAt: "desc" }, take: 500 }),
    prisma.dmDelivery.findMany({ where: { sentAt: { gte: deliveriesSince } }, orderBy: { sentAt: "desc" }, take: 3000 }),
  ]);

  const refsById = new Map(inboundRaw.map((r) => [r.id, parseAttachments(r.attachmentsJson)]));
  const idsWithAttachments = inboundRaw.filter((r) => (refsById.get(r.id)?.length ?? 0) > 0).map((r) => r.id);
  const storedById = await loadStoredAttachments(idsWithAttachments);
  const attachmentsById = new Map(
    inboundRaw.map((r) => [r.id, buildAttachmentViews(refsById.get(r.id) ?? [], storedById.get(r.id) ?? [])]),
  );
  // inboundRaw is newest-first, so the first row per author we see is their
  // most recent -- a reasonable display-name fallback when there's no Player.
  const lastKnownAuthorName = new Map<string, string>();
  for (const r of inboundRaw) {
    if (!lastKnownAuthorName.has(r.authorDiscordId)) lastKnownAuthorName.set(r.authorDiscordId, r.authorName);
  }

  const inbound: InboundDmLite[] = inboundRaw.map((r) => ({
    id: r.id,
    authorDiscordId: r.authorDiscordId,
    content: r.content,
    receivedAt: r.receivedAt,
    status: r.status as InboundDmStatus,
    replyText: r.replyText,
    repliedAt: r.repliedAt,
    repliedByName: r.repliedByName,
  }));
  const deliveries: DmDeliveryLite[] = deliveriesRaw.map((d) => ({
    id: d.id,
    discordId: d.discordId,
    status: d.status as DeliveryStatus,
    sentAt: d.sentAt,
    content: d.content,
    kind: d.kind,
    senderName: d.senderName,
    inReplyToInboundDmId: d.inReplyToInboundDmId,
    errorCode: d.errorCode,
    errorMsg: d.errorMsg,
  }));

  const conversations = buildDmThread(inbound, deliveries);
  const [byDiscordId, statesByDiscordId] = await Promise.all([
    resolvePlayers(conversations.map((c) => c.discordId)),
    loadConversationStates(conversations.map((c) => c.discordId)),
  ]);

  return conversations.map((c) => {
    const p = byDiscordId.get(c.discordId);
    const state = statesByDiscordId.get(c.discordId) ?? null;
    const stateLite: ConversationStateLite | null = state ? { archivedAt: state.archivedAt } : null;
    return {
      discordId: c.discordId,
      displayName: p?.displayName ?? lastKnownAuthorName.get(c.discordId) ?? c.discordId,
      username: p?.username ?? null,
      unreadCount: c.unreadCount,
      lastActivityAt: c.lastActivityAt,
      latestUnansweredContent: c.latestUnanswered?.content ?? null,
      category: classifyConversation(c, stateLite),
      archivedAt: state?.archivedAt ?? null,
      archivedByName: state?.archivedByName ?? null,
      items: c.items.map((it) =>
        it.type === "player" ? { ...it, attachments: attachmentsById.get(it.id) ?? [] } : it,
      ) as ConversationItem[],
    };
  });
}

export async function unreadDmCount(): Promise<number> {
  return prisma.inboundDm.count({ where: { status: "unread" } });
}

export interface DmAttachmentFile {
  filename: string;
  contentType: string | null;
  size: number;
  // Prisma's raw Bytes scalar (Uint8Array<ArrayBuffer>) -- left as-is, not
  // Buffer.from()'d here, so the route can wrap it in Buffer.from() itself
  // right where it's needed, same as
  // web/app/admin/transcripts/attachment/[id]/route.ts does for
  // ThreadMessageAttachment.bytes. (Buffer.from() of a plain, already-typed
  // Buffer re-widens its ArrayBuffer type parameter to ArrayBufferLike,
  // which Response's BodyInit then rejects -- so the conversion has to
  // happen exactly once, straight from the Prisma scalar.)
  data: Uint8Array<ArrayBuffer>;
  error: string | null;
}

// For the attachment-serving route (/admin/dms/attachments/[id]) -- the
// stored bytes + metadata needed to stream a response, or null if no row
// exists with this id.
export async function loadDmAttachmentFile(id: string): Promise<DmAttachmentFile | null> {
  const row = await prisma.dmAttachment.findUnique({
    where: { id },
    select: { filename: true, contentType: true, size: true, data: true, error: true },
  });
  if (!row) return null;
  return {
    filename: row.filename,
    contentType: row.contentType,
    size: row.size,
    data: row.data,
    error: row.error,
  };
}

export interface DmBatchSummary {
  batchKind: string | null;
  batchId: string | null;
  sentCount: number;
  failedCount: number;
  failedDiscordIds: string[];
  mostRecentAt: Date;
}

export interface FailedDeliveryRow {
  id: string;
  discordId: string;
  displayName: string;
  username: string | null;
  errorCode: number | null;
  errorMsg: string | null;
  sentAt: Date;
}

export interface DmDeliverySummary {
  batches: DmBatchSummary[];
  recentFailures: FailedDeliveryRow[];
}

// Recent outbound delivery: grouped per (batchId, batchKind) over the last
// ~30 days (capped 2000 rows), plus a flat list of the most recent ~50 failed
// sends so staff can see exactly who couldn't be reached and why.
export async function loadDmDeliverySummary(): Promise<DmDeliverySummary> {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const deliveries = await prisma.dmDelivery.findMany({
    where: { sentAt: { gte: since } },
    orderBy: { sentAt: "desc" },
    take: 2000,
  });

  const batchMap = new Map<string, DmBatchSummary>();
  for (const d of deliveries) {
    const key = `${d.batchId ?? "-"}::${d.batchKind ?? "-"}`;
    let b = batchMap.get(key);
    if (!b) {
      b = {
        batchKind: d.batchKind,
        batchId: d.batchId,
        sentCount: 0,
        failedCount: 0,
        failedDiscordIds: [],
        mostRecentAt: d.sentAt,
      };
      batchMap.set(key, b);
    }
    if (d.sentAt > b.mostRecentAt) b.mostRecentAt = d.sentAt;
    if (d.status === "failed") {
      b.failedCount++;
      if (!b.failedDiscordIds.includes(d.discordId)) b.failedDiscordIds.push(d.discordId);
    } else {
      b.sentCount++;
    }
  }
  const batches = [...batchMap.values()].sort(
    (a, b) => b.mostRecentAt.getTime() - a.mostRecentAt.getTime(),
  );

  // deliveries is already newest-first, so the first 50 failures are the most
  // recent 50.
  const failedRaw = deliveries.filter((d) => d.status === "failed").slice(0, 50);
  const byDiscordId = await resolvePlayers(failedRaw.map((d) => d.discordId));
  const recentFailures: FailedDeliveryRow[] = failedRaw.map((d) => {
    const p = byDiscordId.get(d.discordId);
    return {
      id: d.id,
      discordId: d.discordId,
      displayName: p?.displayName ?? d.discordId,
      username: p?.username ?? null,
      errorCode: d.errorCode,
      errorMsg: d.errorMsg,
      sentAt: d.sentAt,
    };
  });

  return { batches, recentFailures };
}
