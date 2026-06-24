import { requireAdmin } from "@/lib/admin";
import { loadTranscript } from "@/lib/loaders/transcripts";
import { renderTranscriptHtml } from "@/lib/transcript-html";

// Serves the transcript as a self-contained HTML document (staff-only). Embedded
// in an iframe on the detail page, and openable / savable on its own. Built from
// captured DB rows, so deleted/edited messages are preserved.
export async function GET(_req: Request, { params }: { params: Promise<{ threadId: string }> }) {
  await requireAdmin();
  const { threadId } = await params;
  const { header, messages } = await loadTranscript(threadId);
  return new Response(renderTranscriptHtml(header, messages), {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
