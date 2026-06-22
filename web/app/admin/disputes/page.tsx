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
import { Suspense } from "react";
import { requireAdmin } from "@/lib/admin";
import { loadAdminDisputes } from "@/lib/loaders/admin";
import { AdminNav } from "@/components/AdminNav";
import { SiteNav } from "@/components/SiteNav";
import { DiscordId } from "@/components/DiscordId";
import { FlashToast } from "@/components/FlashToast";
import { acceptDisputeProposal, rejectDispute, setDisputeResult } from "./actions";
import { Button } from "@/components/ui/button";
import { FormSelect } from "@/components/FormSelect";

export const dynamic = "force-dynamic";

export default async function AdminDisputesPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; err?: string }>;
}) {
  await requireAdmin();
  void searchParams; // flashes handled client-side by <FlashToast>

  const disputes = await loadAdminDisputes();

  return (
    <>
      <SiteNav activePath="/admin" />
      <AdminNav activePath="/admin/disputes" />
      <main>
        <h2>Disputed matches ({disputes.length})</h2>
        <p className="muted" style={{ fontSize: 12 }}>
          Players filed these disputes from <code>/profile</code> or <code>/report</code>. If they proposed
          a corrected result, Accept proposed applies it in one click. Otherwise use the division
          admin page to enter the right result by hand.
        </p>

        <Suspense fallback={null}>
          <FlashToast
            messages={{
              accepted: "Proposed correction accepted. Standings updated.",
              rejected: "Dispute rejected, original result kept.",
              custom: "Corrected result set.",
            }}
          />
        </Suspense>

        {disputes.length === 0 ? (
          <div className="card muted">No open disputes. Nice.</div>
        ) : (
          disputes.map((d) => {
            const hasProposal =
              d.disputeProposedGamesWonA != null && d.disputeProposedGamesWonB != null;
            return (
              <div key={d.pairingId} className="card">
                <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
                  <strong>
                    <Link href={`/profile/${d.playerA.id}`} style={{ color: "var(--text)" }}>{d.playerA.displayName}</Link>
                    <DiscordId value={d.playerA.discordId} username={d.playerA.username} />
                    {" vs "}
                    <Link href={`/profile/${d.playerB.id}`} style={{ color: "var(--text)" }}>{d.playerB.displayName}</Link>
                    <DiscordId value={d.playerB.discordId} username={d.playerB.username} />
                  </strong>
                  <Link href={`/divisions/${d.divisionId}`} className="muted" style={{ fontSize: 12 }}>
                    {d.divisionName} · {d.tierName}
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
                      {d.playerA.displayName} <strong>{d.gamesWonA}-{d.gamesWonB}</strong> {d.playerB.displayName}
                    </div>
                    {d.reporter && (
                      <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                        Reported by{" "}
                        <Link href={`/profile/${d.reporter.id}`} style={{ color: "var(--text)" }}>{d.reporter.displayName}</Link>
                        <DiscordId value={d.reporter.discordId} username={d.reporter.username} />
                      </div>
                    )}
                  </div>
                  <div style={{ padding: 8, background: hasProposal ? "rgba(46,204,113,0.08)" : "var(--surface-2)", borderRadius: 4, borderLeft: hasProposal ? "3px solid #2ecc71" : undefined }}>
                    <div className="muted" style={{ fontSize: 11 }}>Disputer says it should be</div>
                    {hasProposal ? (
                      <div style={{ fontSize: 18, fontWeight: 600 }}>
                        {d.playerA.displayName} <strong>{d.disputeProposedGamesWonA}-{d.disputeProposedGamesWonB}</strong> {d.playerB.displayName}
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
                      <input type="hidden" name="pairingId" value={d.pairingId} />
                      <Button type="submit" style={{ background: "var(--success)", color: "#fff" }}>
                        ✓ Accept proposed
                      </Button>
                    </form>
                  )}
                  <form action={rejectDispute}>
                    <input type="hidden" name="pairingId" value={d.pairingId} />
                    <Button type="submit" variant="secondary">
                      Keep original
                    </Button>
                  </form>
                  {/* Set a different result than reported OR proposed. */}
                  <form action={setDisputeResult} style={{ display: "flex", gap: 4, alignItems: "center" }}>
                    <input type="hidden" name="pairingId" value={d.pairingId} />
                    <FormSelect
                      name="result"
                      required
                      placeholder="set other result…"
                      options={[
                        { value: "2-0", label: `${d.playerA.displayName} won 2-0` },
                        { value: "1-1", label: "draw 1-1" },
                        { value: "0-2", label: `${d.playerB.displayName} won 2-0` },
                      ]}
                    />
                    <Button type="submit" variant="secondary">Apply</Button>
                  </form>
                  {d.disputeThreadId && (
                    <span className="muted" style={{ fontSize: 11, alignSelf: "center" }}>
                      🧵 thread created
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
