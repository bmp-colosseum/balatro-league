// Dedicated /report route. Same flow as /me's report form, but a
// top-level entry point so players can bookmark it / find it from the
// nav without scrolling past their profile. Both surfaces go through
// reportSetFromWeb so the rules stay identical.

import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { loadReportPageData } from "@/lib/loaders/report";
import { CANONICAL_DECKS, CANONICAL_STAKES } from "@/lib/balatro-info";
import { tierColors } from "@/lib/tier-colors";
import { SiteNav } from "@/components/SiteNav";
import { DiscordId } from "@/components/DiscordId";
import { ReportForm } from "@/components/ReportForm";
import { DisputeForm } from "@/components/DisputeForm";
import { submitReportFromReportPage, submitReportPageDispute } from "./actions";

export const dynamic = "force-dynamic";

export default async function ReportPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; err?: string; disputeOk?: string; disputeErr?: string }>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/auth/signin?from=/report");

  const { ok, err, disputeOk, disputeErr } = await searchParams;
  const user = session.user as { discordId: string };

  const { player, division, recentMatches } = await loadReportPageData(user.discordId);
  const tc = division ? tierColors(division.tierPosition) : null;

  return (
    <>
      <SiteNav activePath="/report" />
      <main>
        <h2>Report a match</h2>

        {ok && (
          <div className="card" style={{ borderColor: "var(--success)", color: "var(--success)" }}>
            ✓ Reported. Your opponent got a DM with a dispute link.
          </div>
        )}
        {err && (
          <div className="card" style={{ borderColor: "var(--danger)", color: "var(--danger)" }}>
            {err}
          </div>
        )}

        {!player ? (
          <div className="card">
            <strong>Not in the league yet</strong>
            <p className="muted">
              You're logged in but not in the league yet. Sign up in Discord first.
            </p>
          </div>
        ) : !division || !tc ? (
          <div className="card muted">
            You're not in an active division right now. Report results here when you are.
          </div>
        ) : (
          <div className="card">
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
              <span className="muted">Your division:</span>
              <span className="pill" style={{ background: tc.bg, color: tc.fg }}>{division.tierName}</span>
              <Link href={`/divisions/${division.divisionId}`} style={{ textDecoration: "none" }}>{division.divisionName}</Link>
              <span className="muted" style={{ marginLeft: "auto", fontSize: 12 }}>{division.seasonName}</span>
            </div>

            {division.reportableOpponents.length === 0 ? (
              <p className="muted">You've played everyone in your division.</p>
            ) : (
              <ReportForm
                action={submitReportFromReportPage}
                opponents={division.reportableOpponents}
                decks={CANONICAL_DECKS.map((d) => d.name)}
                stakes={CANONICAL_STAKES.map((s) => s.name)}
              />
            )}

            <p className="muted" style={{ fontSize: 11, marginTop: 12 }}>
              Recorded right away and posted to <strong>#results</strong>. Your opponent gets a DM to dispute if the score is wrong.
            </p>
          </div>
        )}

        {disputeOk && (
          <div className="card" style={{ borderColor: "var(--success)", color: "var(--success)" }}>
            ✓ Dispute filed. A helper has been pinged in #results.
          </div>
        )}
        {disputeErr && (
          <div className="card" style={{ borderColor: "var(--danger)", color: "var(--danger)" }}>
            {disputeErr}
          </div>
        )}

        {player && division && recentMatches.length > 0 && (
          <details className="card">
            <summary style={{ cursor: "pointer" }}>
              <strong>Your recent matches ({recentMatches.length})</strong>
            </summary>
            <p className="muted" style={{ fontSize: 11, marginTop: 8 }}>
              Wrong score? Click Dispute to flag it for a helper.
            </p>
            <table style={{ marginTop: 8 }}>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Opponent</th>
                  <th>Score</th>
                  <th>Result</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {recentMatches.map((m) => {
                  const date = m.date ? m.date.toISOString().slice(0, 10) : "—";
                  const isDisputed = m.status === "DISPUTED";
                  // A 0-0 is a void (finished, no points) — distinct from a 1-1 draw.
                  const isVoid = m.myGames === 0 && m.opponentGames === 0;
                  const outcome =
                    isDisputed ? { bg: "rgba(241,196,15,0.15)", fg: "var(--accent)", label: "DISPUTED" }
                    : isVoid ? { bg: "rgba(149,165,166,0.18)", fg: "var(--muted)", label: "V" }
                    : m.outcome === "WIN" ? { bg: "rgba(46,204,113,0.15)", fg: "var(--success)", label: "W" }
                    : m.outcome === "LOSS" ? { bg: "rgba(231,76,60,0.15)", fg: "var(--danger)", label: "L" }
                    : { bg: "rgba(241,196,15,0.15)", fg: "var(--accent)", label: "D" };
                  return (
                    <tr key={m.pairingId} style={isDisputed ? { opacity: 0.7 } : undefined}>
                      <td>{date}</td>
                      <td>
                        <Link href={`/profile/${m.opponentPlayerId}`} style={{ color: "var(--text)" }}>{m.opponentDisplayName}</Link>
                        <DiscordId value={m.opponentDiscordId} username={m.opponentUsername} />
                      </td>
                      <td><strong>{m.myGames}-{m.opponentGames}</strong></td>
                      <td><span className="pill" style={{ background: outcome.bg, color: outcome.fg, fontSize: isDisputed ? 10 : undefined }}>{outcome.label}</span></td>
                      <td>
                        <DisputeForm
                          action={submitReportPageDispute}
                          pairingId={m.pairingId}
                          opponentName={m.opponentDisplayName}
                          isDisputed={isDisputed}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </details>
        )}
      </main>
    </>
  );
}
