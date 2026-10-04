import { requireAdmin } from "@/lib/admin";
import { loadDmAttachmentFile } from "@/lib/loaders/dms";

// Stream a stored DM attachment's bytes (staff-only). An attachment row that
// failed to store (too large / download failed / message no longer
// available) has no bytes to serve -- treated as not-found here; its error
// text is shown on the thread view (/admin/dms) instead, which never links
// to this route for an error row.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  const { id } = await params;
  const file = await loadDmAttachmentFile(id);
  if (!file || file.error) return new Response("Not found", { status: 404 });

  const isImage = !!file.contentType && file.contentType.startsWith("image/");
  const safeName = file.filename.replace(/"/g, "");

  return new Response(Buffer.from(file.data), {
    headers: {
      "Content-Type": file.contentType ?? "application/octet-stream",
      "Content-Disposition": `${isImage ? "inline" : "attachment"}; filename="${safeName}"`,
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
