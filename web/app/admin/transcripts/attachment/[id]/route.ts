import { requireAdmin } from "@/lib/admin";
import { loadAttachment } from "@/lib/loaders/transcripts";

// Serve a captured attachment's stored bytes (staff-only). Falls back to the
// original Discord CDN url when we didn't store bytes (non-image / oversized) —
// that url may have expired once the thread was deleted, but it's the best we
// have in that case.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  const { id } = await params;
  const att = await loadAttachment(id);
  if (!att) return new Response("Not found", { status: 404 });

  if (att.bytes) {
    return new Response(Buffer.from(att.bytes), {
      headers: {
        "Content-Type": att.contentType ?? "application/octet-stream",
        "Content-Disposition": `inline; filename="${att.filename.replace(/"/g, "")}"`,
        "Cache-Control": "private, max-age=300",
      },
    });
  }
  return Response.redirect(att.sourceUrl, 302);
}
