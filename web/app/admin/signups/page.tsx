import Link from "next/link";
import { requireAdmin } from "@/lib/admin";
import { loadSignupRoundsIndex } from "@/lib/loaders/admin-signups";
import { SiteNav } from "@/components/SiteNav";
import { AdminNav } from "@/components/AdminNav";

export const dynamic = "force-dynamic";

const STATUS_STYLE: Record<string, { bg: string; fg: string }> = {
  OPEN: { bg: "rgba(46,204,113,0.2)", fg: "#2ecc71" },
  CLOSED: { bg: "rgba(241,196,15,0.2)", fg: "#f1c40f" },
  BUILT: { bg: "rgba(149,165,166,0.2)", fg: "#c0c8cb" },
};

export default async function SignupsIndexPage() {
  await requireAdmin();
  const rounds = await loadSignupRoundsIndex();

  return (
    <>
      <SiteNav activePath="/admin" />
      <AdminNav activePath="/admin/signups" />
      <main>
        <h2>Signups</h2>
        <p className="muted" style={{ fontSize: 12 }}>
          Every signup round. Open one to see the pre-season <strong>MMR distribution</strong> of who&apos;s
          signed up, or build it into a season.
        </p>

        <div className="card">
          <table className="table-dense">
            <thead>
              <tr>
                <th>Round</th>
                <th>Status</th>
                <th>Signups</th>
                <th>Opened</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rounds.length === 0 ? (
                <tr><td colSpan={5} className="muted">No signup rounds yet. Open one from a season in Seasons.</td></tr>
              ) : (
                rounds.map((r) => {
                  const st = STATUS_STYLE[r.status] ?? STATUS_STYLE.CLOSED!;
                  return (
                    <tr key={r.id}>
                      <td>
                        <Link href={`/admin/signups/${r.id}`} style={{ color: "var(--text)", fontWeight: 600 }}>
                          {r.name}
                        </Link>
                      </td>
                      <td><span className="pill" style={{ background: st.bg, color: st.fg }}>{r.status}</span></td>
                      <td><strong>{r.signups.length}</strong></td>
                      <td className="muted">{r.openedAt.toISOString().slice(0, 10)}</td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        <Link href={`/admin/signups/${r.id}`} style={{ fontSize: 12 }}>📊 MMR</Link>
                        {r.status === "BUILT" && r.resultingSeasonId ? (
                          <Link href={`/seasons/${r.resultingSeasonId}`} style={{ fontSize: 12, marginLeft: 12 }}>Season →</Link>
                        ) : (
                          <Link href={`/admin/signups/${r.id}/build`} style={{ fontSize: 12, marginLeft: 12 }}>Build →</Link>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </main>
    </>
  );
}
