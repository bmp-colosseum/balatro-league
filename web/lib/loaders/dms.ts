import "server-only";

import { prisma } from "@/lib/prisma";

// Loaders for the web DM console (/admin/dms). Read-only reductions over the
// InboundDm (what people sent us) + DmDelivery (what the bot tried to send)
// tables. Player display names are resolved best-effort so staff see a human
// name next to the raw Discord id.

export interface DmAttachment {
  filename: string;
  url: string;
}

export interface InboundDmRow {
  id: string;
  authorDiscordId: string;
  authorName: string; // snapshot at receipt
  displayName: string; // resolved Player.displayName, else authorName
  username: string | null; // resolved Player.username (@handle) if known
  content: string;
  attachments: DmAttachment[];
  receivedAt: Date;
  status: string; // unread | read | replied
  repliedAt: Date | null;
  repliedBy: string | null;
  replyText: string | null;
}

export interface DmInbox {
  rows: InboundDmRow[];
  counts: { unread: number; total: number };
}

// attachmentsJson is a nullable JSON string of [{ filename, url }]. Parse
// defensively — a malformed blob must never break the console.
function parseAttachments(json: string | null): DmAttachment[] {
  if (!json) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: DmAttachment[] = [];
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

// Inbound DMs, unread first then newest first, capped at 200. Counts are the
// true totals (not the capped page) so the badge/summary stay accurate.
export async function loadDmInbox(): Promise<DmInbox> {
  const [raw, unread, total] = await Promise.all([
    prisma.inboundDm.findMany({ orderBy: { receivedAt: "desc" }, take: 200 }),
    prisma.inboundDm.count({ where: { status: "unread" } }),
    prisma.inboundDm.count(),
  ]);

  const byDiscordId = await resolvePlayers(raw.map((r) => r.authorDiscordId));

  const rows: InboundDmRow[] = raw.map((r) => {
    const p = byDiscordId.get(r.authorDiscordId);
    return {
      id: r.id,
      authorDiscordId: r.authorDiscordId,
      authorName: r.authorName,
      displayName: p?.displayName ?? r.authorName,
      username: p?.username ?? null,
      content: r.content,
      attachments: parseAttachments(r.attachmentsJson),
      receivedAt: r.receivedAt,
      status: r.status,
      repliedAt: r.repliedAt,
      repliedBy: r.repliedBy,
      replyText: r.replyText,
    };
  });

  // Stable sort keeps the newest-first order within each status group, so this
  // yields "unread (newest first), then the rest (newest first)".
  rows.sort((a, b) => (a.status === "unread" ? 0 : 1) - (b.status === "unread" ? 0 : 1));

  return { rows, counts: { unread, total } };
}

export async function unreadDmCount(): Promise<number> {
  return prisma.inboundDm.count({ where: { status: "unread" } });
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
