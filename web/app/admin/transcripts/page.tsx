import Link from "next/link";
import { requireAdmin } from "@/lib/admin";
import { SiteNav } from "@/components/SiteNav";
import { AdminNav } from "@/components/AdminNav";
import { listTranscripts } from "@/lib/loaders/transcripts";

export const dynamic = "force-dynamic";

function fmt(d: Date | null): string {
  return d ? new Date(d).toLocaleString() : "—";
}

function typeLabel(kind: string): string {
  return kind === "dispute" ? "⚖ dispute" : kind === "support" ? "🎫 support" : "🎮 match";
}

const TABS: Array<{ key: string; label: string }> = [
  { key: "", label: "All" },
  { key: "match", label: "🎮 Matches" },
  { key: "dispute", label: "⚖ Disputes" },
  { key: "support", label: "🎫 Support" },
];

export default async function TranscriptsPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string }>;
}) {
  await requireAdmin();
  const { kind } = await searchParams;
  const all = await listTranscripts();
  const active = kind === "match" || kind === "dispute" || kind === "support" ? kind : "";
  const rows = active ? all.filter((r) => r.kind === active) : all;

  return (
    <>
      <SiteNav activePath="/admin" />
      <AdminNav activePath="/admin/transcripts" />
      <main>
        <h2>Transcripts</h2>
        <p className="muted">
          Messages captured from <strong>match</strong>, <strong>dispute</strong>, and <strong>support</strong> threads for
          moderation — people are told via a pinned notice in each thread. Kept about a week, then auto-purged. Staff-only;
          never public.
        </p>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "10px 0 14px" }}>
          {TABS.map((t) => {
            const count = t.key ? all.filter((r) => r.kind === t.key).length : all.length;
            const isActive = active === t.key;
            return (
              <Link
                key={t.key}
                href={t.key ? `/admin/transcripts?kind=${t.key}` : "/admin/transcripts"}
                className={isActive ? "pill" : "pill"}
                style={{
                  background: isActive ? "var(--accent-2)" : "var(--surface-2)",
                  color: isActive ? "var(--bg)" : "var(--muted)",
                  textDecoration: "none",
                }}
              >
                {t.label} <span style={{ opacity: 0.7 }}>({count})</span>
              </Link>
            );
          })}
        </div>

        {rows.length === 0 ? (
          <div className="card muted">No transcripts captured{active ? ` in this category` : ""} yet.</div>
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
                    <td className="muted">{typeLabel(r.kind)}</td>
                    <td className="muted">
                      {r.count}
                      {r.deleted > 0 && (
                        <span style={{ color: "var(--danger)" }}> · {r.deleted} deleted</span>
                      )}
                    </td>
                    <td className="muted">{fmt(r.lastAt)}</td>
                    <td>
                      <Link href={`/admin/transcripts/${r.threadId}`} className="link-action" style={{ color: "var(--accent-2-text)" }}>
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
