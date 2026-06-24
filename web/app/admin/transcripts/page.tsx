import Link from "next/link";
import { requireAdmin } from "@/lib/admin";
import { SiteNav } from "@/components/SiteNav";
import { AdminNav } from "@/components/AdminNav";
import { listTranscripts } from "@/lib/loaders/transcripts";

export const dynamic = "force-dynamic";

function fmt(d: Date | null): string {
  return d ? new Date(d).toLocaleString() : "—";
}

export default async function TranscriptsPage() {
  await requireAdmin();
  const rows = await listTranscripts();

  return (
    <>
      <SiteNav activePath="/admin" />
      <AdminNav activePath="/admin/transcripts" />
      <main>
        <h2>Match transcripts</h2>
        <p className="muted">
          Messages captured from <strong>match</strong> and <strong>dispute</strong> threads for moderation — players are
          told via a pinned notice in each thread. Kept about a week, then auto-purged. Staff-only; never public.
        </p>

        {rows.length === 0 ? (
          <div className="card muted">No transcripts captured yet.</div>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th style={{ textAlign: "left" }}>Participants</th>
                  <th style={{ textAlign: "left" }}>Type</th>
                  <th style={{ textAlign: "left" }}>Messages</th>
                  <th style={{ textAlign: "left" }}>Last activity</th>
                  <th style={{ textAlign: "left" }}></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.threadId}>
                    <td><strong>{r.participants.join(", ") || "—"}</strong></td>
                    <td className="muted">{r.kind === "dispute" ? "⚖ dispute" : "🎮 match"}</td>
                    <td className="muted">
                      {r.count}
                      {r.deleted > 0 && (
                        <span style={{ color: "var(--danger)" }}> · {r.deleted} deleted</span>
                      )}
                    </td>
                    <td className="muted">{fmt(r.lastAt)}</td>
                    <td>
                      <Link href={`/admin/transcripts/${r.threadId}`} className="link-action" style={{ color: "var(--accent-2)" }}>
                        View →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </>
  );
}
