import Link from "next/link";
import { requireAdmin } from "@/lib/admin";
import { loadSignupRoundsIndex } from "@/lib/loaders/admin-signups";
import { SiteNav } from "@/components/SiteNav";
import { AdminNav } from "@/components/AdminNav";
import { ConfirmButton } from "@/components/ConfirmButton";
import { deleteSignupRound } from "./actions";

export const dynamic = "force-dynamic";

const STATUS_STYLE: Record<string, { bg: string; fg: string }> = {
  OPEN: { bg: "rgba(46,204,113,0.2)", fg: "var(--success)" },
  CLOSED: { bg: "rgba(241,196,15,0.2)", fg: "var(--accent)" },
  BUILT: { bg: "rgba(88,101,242,0.18)", fg: "var(--accent-2)" },
  ENDED: { bg: "rgba(149,165,166,0.18)", fg: "var(--muted)" },
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
                  // A BUILT round whose season has ended reads as "ENDED" — the raw
                  // BUILT latch never advances, so it'd otherwise look in-progress forever.
                  const isEnded = !!r.resultingSeasonEndedAt;
                  const statusLabel = isEnded ? "ENDED" : r.status;
                  const st = STATUS_STYLE[statusLabel] ?? STATUS_STYLE.CLOSED!;
                  return (
                    <tr key={r.id}>
                      <td>
                        <Link href={`/admin/signups/${r.id}`} style={{ color: "var(--text)", fontWeight: 600 }}>
                          {r.name}
                        </Link>
                      </td>
                      <td><span className="pill" style={{ background: st.bg, color: st.fg }}>{statusLabel}</span></td>
                      <td><strong>{r.signups.length}</strong></td>
                      <td className="muted">{r.openedAt.toISOString().slice(0, 10)}</td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        <Link href={`/admin/signups/${r.id}`} style={{ fontSize: 12 }}>📊 MMR</Link>
                        {r.status === "BUILT" && r.resultingSeasonId ? (
                          <Link href={`/seasons/${r.resultingSeasonId}`} style={{ fontSize: 12, marginLeft: 12 }}>Season →</Link>
                        ) : (
                          <Link href={`/admin/signups/${r.id}/preview`} style={{ fontSize: 12, marginLeft: 12 }}>Set up →</Link>
                        )}
                        <form action={deleteSignupRound} style={{ display: "inline" }}>
                          <input type="hidden" name="roundId" value={r.id} />
                          <ConfirmButton
                            message={`Delete the "${r.name}" round and its ${r.signups.length} signup(s)?${r.resultingSeasonId ? " The season it built stays untouched — this only removes the old signup record." : " This can't be undone."}`}
                            variant="secondary"
                            style={{ fontSize: 11, marginLeft: 12 }}
                          >
                            Delete
                          </ConfirmButton>
                        </form>
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
