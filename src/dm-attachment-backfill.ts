// Bot-side backfill for DmAttachment rows on OLDER InboundDm messages --
// either captured before this feature existed, or where the live download at
// capture time failed. Re-fetches the ORIGINAL message from Discord (by DM
// channel + message id) to get a fresh signed CDN url (the one saved in
// attachmentsJson has likely expired after ~24h), then stores it through the
// same path live capture uses. A message Discord no longer has gets an
// explicit "message no longer available" error row per attachment so it
// isn't retried forever.
//
// Triggered manually only -- the /admin/ops "Recover DM attachments" button
// enqueues the dm-attachments.backfill job (src/queue.ts), never run on a
// schedule.

import type { Client } from "discord.js";
import { prisma } from "./db.js";
import { parseStoredAttachmentRefs, selectBackfillCandidateIds } from "./dm-attachment-core.js";
import { storeDmAttachments, storeUnavailableDmAttachment } from "./dm-attachment-store.js";

export interface DmAttachmentBackfillResult {
  scanned: number;
  recovered: number;
  unavailable: number;
  failed: number;
}

const DEFAULT_LIMIT = 100;

export async function backfillDmAttachments(
  client: Client,
  { limit = DEFAULT_LIMIT }: { limit?: number } = {},
): Promise<DmAttachmentBackfillResult> {
  // Gather: every InboundDm that carries attachment metadata, oldest first
  // (closest to the stored Discord-side copy also being gone for good), plus
  // which of those ids already have a DmAttachment row (no relation/N+1 --
  // one query each).
  const withMeta = await prisma.inboundDm.findMany({
    where: { attachmentsJson: { not: null } },
    orderBy: { receivedAt: "asc" },
    select: { id: true, discordMessageId: true, authorDiscordId: true, attachmentsJson: true },
  });
  const result: DmAttachmentBackfillResult = { scanned: 0, recovered: 0, unavailable: 0, failed: 0 };
  if (withMeta.length === 0) return result;

  const alreadyCaptured = await prisma.dmAttachment.findMany({
    where: { inboundDmId: { in: withMeta.map((r) => r.id) } },
    select: { inboundDmId: true },
    distinct: ["inboundDmId"],
  });

  // Decide (pure): which ids still need a pass, capped at `limit`.
  const candidateIds = selectBackfillCandidateIds(
    withMeta.map((r) => r.id),
    alreadyCaptured.map((r) => r.inboundDmId),
    limit,
  );
  const byId = new Map(withMeta.map((r) => [r.id, r]));

  // Act: one Discord round-trip per candidate.
  for (const id of candidateIds) {
    const row = byId.get(id);
    if (!row) continue;
    result.scanned++;
    const refs = parseStoredAttachmentRefs(row.attachmentsJson);
    if (refs.length === 0) continue;

    try {
      const user = await client.users.fetch(row.authorDiscordId);
      const dm = await user.createDM();
      const message = await dm.messages.fetch(row.discordMessageId);
      const fresh = [...message.attachments.values()];
      if (fresh.length === 0) {
        // The message still exists but Discord no longer has any attachment
        // on it -- same outcome as "unavailable" for our purposes.
        for (const ref of refs) await storeUnavailableDmAttachment(row.id, ref.filename, ref.url);
        result.unavailable++;
        continue;
      }
      await storeDmAttachments(
        row.id,
        fresh.map((a) => ({
          filename: a.name ?? "file",
          contentType: a.contentType ?? null,
          url: a.url,
          knownSize: typeof a.size === "number" ? a.size : null,
        })),
      );
      result.recovered++;
    } catch (err) {
      // User/DM channel/message fetch failed -- Discord no longer has it
      // (deleted DM, bot blocked, account gone, etc). Record it as
      // permanently unavailable per known attachment so this row stops
      // being picked up by every future backfill run.
      console.warn(`[dm-attachment-backfill] ${row.id} unavailable:`, err);
      try {
        for (const ref of refs) await storeUnavailableDmAttachment(row.id, ref.filename, ref.url);
        result.unavailable++;
      } catch (writeErr) {
        console.warn(`[dm-attachment-backfill] failed to record unavailable row for ${row.id}:`, writeErr);
        result.failed++;
      }
    }
  }

  return result;
}
