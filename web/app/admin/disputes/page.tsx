// Helper / admin queue for resolving disputed matches. Lists every
// DISPUTED Pairing across active-season divisions with:
//   - Current recorded result + proposed correction side by side
//   - Disputer + reason
//   - Three actions: Accept proposed (one-click), Reject (keep original),
//     Custom Edit (link to the division admin page for manual entry)
//
// Past-season disputes (rare — would only happen if a season finished
// with a dispute open) are filtered out; helpers shouldn't be editing
// frozen history.

import Link from "next/link";
import { requireAdmin } from "@/lib/admin";
import { prisma } from "@/lib/prisma";
import { AdminNav } from "@/components/AdminNav";
import { SiteNav } from "@/components/SiteNav";
import { acceptDisputeProposal, rejectDispute } from "./actions";

export const dynamic = "force-dynamic";

export default async function AdminDisputesPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; err?: string }>;
}) {
  await requireAdmin();
  const { ok, err } = await searchParams;

  const disputes = await prisma.pairing.findMany({
    where: {
      status: "DISPUTED",
      division: { season: { isActive: true } },
    },
    include: {
      playerA: true,
      playerB: true,
      disputer: true,
      reporter: true,
      division: { include: { season: true, tier: true } },
    },
    orderBy: { disputedAt: "desc" },
  });

  return (
    <>
      <SiteNav activePath="/admin" />
      <AdminNav activePath="/admin/disputes" />
      <main>
        <h2>Disputed matches ({disputes.length})</h2>
        <p className="muted" style={{ fontSize: 12 }}>
          Players filed disputes from <code>/profile</code> or <code>/report</code>. If they proposed
          a corrected result, Accept Proposed applies it in one click. Otherwise use the division
          admin page to enter the right result manually.
        </p>

        {ok === "accepted" && (
          <div className="card" style={{ borderColor: "#2ecc71", color: "#2ecc71" }}>
            ✓ Proposed correction accepted. Standings updated.
          </div>
        )}
        {ok === "rejected" && (
          <div className="card" style={{ borderColor: "#2ecc71", color: "#2ecc71" }}>
            ✓ Dispute rejected, original result kept.
          </div>
        )}
        {err && (
          <div className="card" style={{ borderColor: "#e74c3c", color: "#e74c3c" }}>
            {err}
          </div>
        )}

        {disputes.length === 0 ? (
          <div className="card muted">No open disputes. Nice.</div>
        ) : (
          disputes.map((d) => {
            const hasProposal =
              d.disputeProposedGamesWonA != null && d.disputeProposedGamesWonB != null;
            return (
              <div key={d.id} className="card">
                <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
                  <strong>
                    <Link href={`/profile/${d.playerA.id}`} style={{ color: "var(--text)" }}>{d.playerA.displayName}</Link>
                    {" vs "}
                    <Link href={`/profile/${d.playerB.id}`} style={{ color: "var(--text)" }}>{d.playerB.displayName}</Link>
                  </strong>
                  <Link href={`/admin/divisions/${d.divisionId}`} className="muted" style={{ fontSize: 12 }}>
                    {d.division.name} · {d.division.tier.name}
                  </Link>
                  <span className="muted" style={{ marginLeft: "auto", fontSize: 11 }}>
                    Disputed{" "}
                    {d.disputedAt ? d.disputedAt.toISOString().slice(0, 16).replace("T", " ") : "—"}
                    {" by "}
                    {d.disputer ? (
                      <Link href={`/profile/${d.disputer.id}`} style={{ color: "var(--text)" }}>{d.disputer.displayName}</Link>
                    ) : "(unknown)"}
                  </span>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 8 }}>
                  <div style={{ padding: 8, background: "var(--surface-2)", borderRadius: 4 }}>
                    <div className="muted" style={{ fontSize: 11 }}>Recorded</div>
                    <div style={{ fontSize: 18, fontWeight: 600 }}>
                      {d.playerA.displayName} <strong>{d.gamesWonA}–{d.gamesWonB}</strong> {d.playerB.displayName}
                    </div>
                    {d.reporter && (
                      <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                        Reported by{" "}
                        <Link href={`/profile/${d.reporter.id}`} style={{ color: "var(--text)" }}>{d.reporter.displayName}</Link>
                      </div>
                    )}
                  </div>
                  <div style={{ padding: 8, background: hasProposal ? "rgba(46,204,113,0.08)" : "var(--surface-2)", borderRadius: 4, borderLeft: hasProposal ? "3px solid #2ecc71" : undefined }}>
                    <div className="muted" style={{ fontSize: 11 }}>Disputer says it should be</div>
                    {hasProposal ? (
                      <div style={{ fontSize: 18, fontWeight: 600 }}>
                        {d.playerA.displayName} <strong>{d.disputeProposedGamesWonA}–{d.disputeProposedGamesWonB}</strong> {d.playerB.displayName}
                      </div>
                    ) : (
                      <div className="muted">— no specific proposal —</div>
                    )}
                  </div>
                </div>

                {d.disputeReason && (
                  <div className="muted" style={{ fontSize: 12, marginBottom: 8, padding: 8, background: "var(--surface-2)", borderRadius: 4 }}>
                    <strong>Reason:</strong> {d.disputeReason}
                  </div>
                )}

                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {hasProposal && (
                    <form action={acceptDisputeProposal}>
                      <input type="hidden" name="pairingId" value={d.id} />
                      <button type="submit" style={{ background: "#2ecc71", color: "#fff" }}>
                        ✓ Accept proposed
                      </button>
                    </form>
                  )}
                  <form action={rejectDispute}>
                    <input type="hidden" name="pairingId" value={d.id} />
                    <button type="submit" className="secondary">
                      Keep original
                    </button>
                  </form>
                  <Link href={`/admin/divisions/${d.divisionId}`} className="muted" style={{ fontSize: 12, alignSelf: "center", marginLeft: "auto" }}>
                    Custom edit on division page →
                  </Link>
                  {d.disputeThreadId && (
                    <span className="muted" style={{ fontSize: 11, alignSelf: "center" }}>
                      🧵 thread spawned
                    </span>
                  )}
                </div>
              </div>
            );
          })
        )}
      </main>
    </>
  );
}
