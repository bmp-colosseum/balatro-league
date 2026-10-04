// Pure core for DM-attachment storage decisions. The shell (src/dm-attachment-store.ts)
// gathers each attachment's metadata (and, when needed, its downloaded bytes),
// calls these functions to decide what to keep, then writes the DmAttachment
// row. Zero imports, zero I/O -- every branch here is a plain-data decision,
// exhaustively table-testable without a DB or a network.

// Skip (don't store) any single file over this size. The row is still
// written -- just with empty data and `error` explaining why -- so the admin
// console shows "too large" instead of a silently missing attachment.
export const MAX_DM_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MB

export interface AttachmentSizeDecision {
  store: boolean;
  error: string | null;
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

// Whether a file of this size should be persisted. Called twice in the
// shell's happy path -- once up front against Discord's reported size (so an
// oversized file is never even downloaded), and once more against the
// ACTUAL downloaded byte count (Discord's reported size is occasionally
// absent or wrong) -- both calls go through this one decision.
export function decideAttachmentStorage(sizeBytes: number): AttachmentSizeDecision {
  if (sizeBytes > MAX_DM_ATTACHMENT_BYTES) {
    return {
      store: false,
      error: `too large (${formatBytes(sizeBytes)}, max ${formatBytes(MAX_DM_ATTACHMENT_BYTES)})`,
    };
  }
  return { store: true, error: null };
}

// Discord filenames are attacker-controlled (a player names their own
// upload) and end up in a Content-Disposition header and on disk-adjacent
// display -- strip path separators/control characters and cap the length so
// it's always safe to use verbatim. Never returns an empty string.
const UNSAFE_FILENAME_CHARS = /[/\\\x00-\x1f"]/g;
const MAX_FILENAME_LENGTH = 200;

export function sanitizeAttachmentFilename(name: string): string {
  const stripped = name.replace(UNSAFE_FILENAME_CHARS, "_").trim();
  const safe = stripped.length > 0 ? stripped : "attachment";
  return safe.length > MAX_FILENAME_LENGTH ? safe.slice(0, MAX_FILENAME_LENGTH) : safe;
}

// Content-type fallback table for when Discord doesn't report one on the
// attachment metadata (rare, but observed for some file types) -- keyed by
// lowercased extension. Covers the types that actually show up in DMs
// (images matter most; everything else just needs a sane download type).
const EXTENSION_CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  wav: "audio/wav",
  pdf: "application/pdf",
  txt: "text/plain",
  json: "application/json",
  zip: "application/zip",
};

// Resolve the content type to persist: Discord's reported type if present,
// else a best-effort guess from the (already-sanitized) filename's
// extension, else null (served as application/octet-stream downstream).
export function resolveContentType(explicit: string | null | undefined, filename: string): string | null {
  if (explicit) return explicit;
  const ext = filename.split(".").pop()?.toLowerCase();
  if (!ext || ext === filename.toLowerCase()) return null; // no extension at all
  return EXTENSION_CONTENT_TYPES[ext] ?? null;
}

// Drives the admin console's "render as thumbnail vs. download link" split.
export function isImageContentType(contentType: string | null): boolean {
  return !!contentType && contentType.startsWith("image/");
}

export interface StoredAttachmentRef {
  filename: string;
  url: string;
}

// Defensive parse of InboundDm.attachmentsJson -- used by the backfill job
// (src/dm-attachment-backfill.ts) to recover which files to re-fetch from
// Discord. Same shape/defensiveness as web/lib/loaders/dms.ts's
// parseAttachments: a malformed blob must never crash the backfill, it just
// yields no refs for that row.
export function parseStoredAttachmentRefs(json: string | null): StoredAttachmentRef[] {
  if (!json) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: StoredAttachmentRef[] = [];
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

// Pure set-difference + cap: of the InboundDm ids that carry attachment
// metadata, which ones still need a backfill pass (no DmAttachment rows
// yet), capped at `limit`. The backfill shell gathers both id lists (one
// query each, no N+1), calls this to decide, then acts per selected id.
export function selectBackfillCandidateIds(
  candidateIds: string[],
  idsAlreadyCaptured: string[],
  limit: number,
): string[] {
  const captured = new Set(idsAlreadyCaptured);
  return candidateIds.filter((id) => !captured.has(id)).slice(0, limit);
}
