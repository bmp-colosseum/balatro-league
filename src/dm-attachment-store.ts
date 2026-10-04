// Shell for DmAttachment storage: downloads one Discord attachment's bytes
// and writes a DmAttachment row. Used by both the live capture path
// (src/inbound-dm.ts, right after the message's attachments are seen) and
// the backfill job (src/dm-attachment-backfill.ts, re-fetching from an older
// InboundDm whose Discord CDN urls have since expired).
//
// Best-effort by contract: every public function here swallows its own
// errors and always writes a row (with `error` set) rather than throwing --
// a download failure must never break the caller's message capture.

import { prisma } from "./db.js";
import {
  decideAttachmentStorage,
  resolveContentType,
  sanitizeAttachmentFilename,
} from "./dm-attachment-core.js";

const DOWNLOAD_TIMEOUT_MS = 20_000;

export interface DmAttachmentInput {
  filename: string;
  contentType: string | null;
  url: string;
  // Discord reports the attachment's byte size up front on the Message
  // object -- when known, the size cap is checked BEFORE downloading a
  // single byte, so an oversized file never gets fetched at all.
  knownSize?: number | null;
}

// Plain Uint8Array<ArrayBuffer>, not a Node Buffer -- Prisma's generated
// Bytes field type is a structural Uint8Array shape backed by a real
// ArrayBuffer, and (TS 5.7 + current @types/node) both Buffer and the bare
// `Uint8Array` alias default to the wider ArrayBufferLike (which also
// covers SharedArrayBuffer), so neither structurally satisfies it without
// pinning the type parameter explicitly to ArrayBuffer.
const EMPTY_BYTES: Uint8Array<ArrayBuffer> = new Uint8Array(0);

async function writeSkippedOrFailedRow(
  inboundDmId: string,
  filename: string,
  contentType: string | null | undefined,
  url: string,
  size: number,
  error: string,
): Promise<void> {
  await prisma.dmAttachment.create({
    data: {
      inboundDmId,
      filename,
      contentType: resolveContentType(contentType, filename),
      size,
      data: EMPTY_BYTES,
      discordUrl: url,
      error,
    },
  });
}

// Download + store ONE attachment. Never throws -- a download or DB failure
// is logged and, where possible, recorded as an error row instead.
export async function storeDmAttachment(inboundDmId: string, att: DmAttachmentInput): Promise<void> {
  const filename = sanitizeAttachmentFilename(att.filename);

  try {
    // Known size over the cap -- skip the download entirely.
    if (att.knownSize != null) {
      const decision = decideAttachmentStorage(att.knownSize);
      if (!decision.store) {
        await writeSkippedOrFailedRow(inboundDmId, filename, att.contentType, att.url, att.knownSize, decision.error!);
        return;
      }
    }

    let bytes: Uint8Array<ArrayBuffer>;
    try {
      const res = await fetch(att.url, {
        redirect: "follow",
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // res.arrayBuffer() is a real ArrayBuffer (never SharedArrayBuffer),
      // so wrapping it directly in a Uint8Array keeps the structural type
      // Prisma's Bytes field expects -- no Buffer involved.
      bytes = new Uint8Array(await res.arrayBuffer());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[dm-attachment] download failed for ${att.url}:`, err);
      await writeSkippedOrFailedRow(inboundDmId, filename, att.contentType, att.url, att.knownSize ?? 0, `download failed: ${msg}`);
      return;
    }

    // Re-check against the ACTUAL byte count -- Discord's reported size can
    // be absent (knownSize undefined) or, rarely, wrong.
    const decision = decideAttachmentStorage(bytes.byteLength);
    await prisma.dmAttachment.create({
      data: {
        inboundDmId,
        filename,
        contentType: resolveContentType(att.contentType, filename),
        size: bytes.byteLength,
        data: decision.store ? bytes : EMPTY_BYTES,
        discordUrl: att.url,
        error: decision.error,
      },
    });
  } catch (err) {
    // Covers a DB failure on either create() above -- the capture call site
    // must never throw because of attachment storage.
    console.warn(`[dm-attachment] store failed for ${att.filename}:`, err);
  }
}

// Store a batch (one message's attachments). Each attachment is independent
// -- one failing never stops the rest.
export async function storeDmAttachments(inboundDmId: string, attachments: DmAttachmentInput[]): Promise<void> {
  for (const att of attachments) {
    await storeDmAttachment(inboundDmId, att);
  }
}

// Record that a message Discord no longer has (deleted DM, or the bot was
// removed/blocked before backfill could run) is permanently unrecoverable --
// used by backfillDmAttachments so it isn't retried forever. filename/url
// come from the stale attachmentsJson entry being backfilled.
export async function storeUnavailableDmAttachment(
  inboundDmId: string,
  filename: string,
  url: string,
): Promise<void> {
  try {
    await writeSkippedOrFailedRow(inboundDmId, sanitizeAttachmentFilename(filename), null, url, 0, "message no longer available");
  } catch (err) {
    console.warn(`[dm-attachment] failed to record unavailable row for ${inboundDmId}:`, err);
  }
}
