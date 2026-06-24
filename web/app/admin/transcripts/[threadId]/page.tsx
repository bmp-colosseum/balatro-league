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
  const { header } = await loadTranscript(threadId);
  const htmlUrl = `/admin/transcripts/${threadId}/html`;

  return (
    <>
      <SiteNav activePath="/admin" />
      <AdminNav activePath="/admin/transcripts" />
      <main>
        <p className="muted" style={{ marginBottom: 4 }}>
          <Link href="/admin/transcripts" className="link-action" style={{ color: "var(--accent-2)" }}>← All transcripts</Link>
        </p>
        <h2>{header.kind === "dispute" ? "⚖ Dispute" : "🎮 Match"} transcript</h2>
        <div className="card" style={{ marginBottom: 12 }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 18px", fontSize: 13 }}>
            <span><span className="muted">Players:</span> <strong>{header.participants.join(", ") || "—"}</strong></span>
            <span><span className="muted">Messages:</span> {header.count}{header.deleted > 0 && <span style={{ color: "var(--danger)" }}> · {header.deleted} deleted</span>}</span>
            {header.firstAt && <span><span className="muted">Span:</span> {time(header.firstAt)} → {time(header.lastAt as Date)}</span>}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 18px", fontSize: 12, marginTop: 4 }}>
            <span className="muted">Match ID: {header.matchId ?? "— (not finished / unlinked)"}</span>
            <span className="muted">Thread ID: {header.threadId}</span>
          </div>
        </div>

        <p className="muted" style={{ fontSize: 13, display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center" }}>
          <span>Edited and deleted messages are kept as evidence and marked below.</span>
          <a href={htmlUrl} target="_blank" rel="noopener" className="link-action" style={{ color: "var(--accent-2)" }}>
            Open / download ↗
          </a>
        </p>

        {/* The transcript itself, served as a self-contained HTML document and
            embedded here. Same-origin, so the staff session cookie authorizes it
            (and the inline attachment images). */}
        <iframe
          title="Transcript"
          src={htmlUrl}
          style={{
            width: "100%",
            height: "72vh",
            border: "1px solid var(--border)",
            borderRadius: 8,
            background: "#fff",
          }}
        />
      </main>
    </>
  );
}
