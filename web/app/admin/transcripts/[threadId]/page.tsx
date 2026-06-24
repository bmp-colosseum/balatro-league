import Link from "next/link";
import { requireAdmin } from "@/lib/admin";
import { SiteNav } from "@/components/SiteNav";
import { AdminNav } from "@/components/AdminNav";
import { loadTranscript } from "@/lib/loaders/transcripts";

export const dynamic = "force-dynamic";

function time(d: Date): string {
  return new Date(d).toLocaleString();
}

export default async function TranscriptDetailPage({
  params,
}: {
  params: Promise<{ threadId: string }>;
}) {
  await requireAdmin();
  const { threadId } = await params;
  const messages = await loadTranscript(threadId);

  return (
    <>
      <SiteNav activePath="/admin" />
      <AdminNav activePath="/admin/transcripts" />
      <main>
        <p className="muted" style={{ marginBottom: 4 }}>
          <Link href="/admin/transcripts" className="link-action" style={{ color: "var(--accent-2)" }}>← All transcripts</Link>
        </p>
        <h2>Transcript</h2>
        <p className="muted">
          Captured from the thread for moderation. Edited and deleted messages are kept as evidence and marked below.
        </p>

        {messages.length === 0 ? (
          <div className="card muted">No messages captured for this thread (it may have been purged).</div>
        ) : (
          <div className="flex flex-col gap-2">
            {messages.map((m) => (
              <div
                key={m.id}
                className="card"
                style={m.deletedAt ? { borderColor: "var(--danger)" } : undefined}
              >
                <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                  <strong>{m.authorName}</strong>
                  <span className="muted" style={{ fontSize: 12 }}>{time(m.postedAt)}</span>
                  {m.editedAt && (
                    <span className="muted" style={{ fontSize: 11 }}>· edited</span>
                  )}
                  {m.deletedAt && (
                    <span style={{ fontSize: 11, color: "var(--danger)" }}>· 🗑 deleted {time(m.deletedAt)}</span>
                  )}
                </div>

                <div
                  style={{
                    whiteSpace: "pre-wrap",
                    marginTop: 4,
                    textDecoration: m.deletedAt ? "line-through" : undefined,
                    opacity: m.deletedAt ? 0.85 : 1,
                  }}
                >
                  {m.content || <span className="muted">(no text)</span>}
                </div>

                {m.editedAt && m.originalContent != null && (
                  <div className="muted" style={{ marginTop: 6, fontSize: 12, borderLeft: "2px solid var(--border)", paddingLeft: 8 }}>
                    <span style={{ fontSize: 11 }}>original:</span>
                    <div style={{ whiteSpace: "pre-wrap" }}>{m.originalContent}</div>
                  </div>
                )}

                {m.attachments.length > 0 && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
                    {m.attachments.map((a) => {
                      const isImage = !!a.contentType && a.contentType.startsWith("image/");
                      return isImage ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          key={a.id}
                          src={`/admin/transcripts/attachment/${a.id}`}
                          alt={a.filename}
                          style={{ maxWidth: 240, maxHeight: 240, borderRadius: 6, border: "1px solid var(--border)" }}
                        />
                      ) : (
                        <a key={a.id} href={`/admin/transcripts/attachment/${a.id}`} className="muted" style={{ fontSize: 13 }}>
                          📎 {a.filename}
                        </a>
                      );
                    })}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </main>
    </>
  );
}
