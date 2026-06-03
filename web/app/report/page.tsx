// Dedicated /report route. Same flow as /me's report form, but a
// top-level entry point so players can bookmark it / find it from the
// nav without scrolling past their profile. Both surfaces go through
// reportSetFromWeb so the rules stay identical.

import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { loadReportPageData } from "@/lib/loaders/report";
import { tierColors } from "@/lib/tier-colors";
import { SiteNav } from "@/components/SiteNav";
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
          <div className="card" style={{ borderColor: "#2ecc71", color: "#2ecc71" }}>
            ✓ Reported. Your opponent has 2 minutes to confirm or dispute in #results, then it auto-confirms.
          </div>
        )}
        {err && (
          <div className="card" style={{ borderColor: "#e74c3c", color: "#e74c3c" }}>
            {err}
          </div>
        )}

        {!player ? (
          <div className="card">
            <strong>Not in the league yet</strong>
            <p className="muted">
              You're logged in but no Player record exists for your Discord ID. Sign up via the Discord
              bot first.
            </p>
          </div>
        ) : !division || !tc ? (
          <div className="card muted">
            You're not in an active public division right now — when you are, this is where you'll
            report results from.
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
              <p className="muted">No opponents left — you've played everyone in your division.</p>
            ) : (
              <form action={submitReportFromReportPage} style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                <span className="muted" style={{ fontSize: 12 }}>vs</span>
                <select name="opponentId" required style={{ flex: "1 1 240px" }}>
                  <option value="">— pick an opponent —</option>
                  {division.reportableOpponents.map((o) => (
                    <option key={o.playerId} value={o.playerId}>
                      {o.displayName}{o.alreadyPending ? " (already pending)" : ""}
                    </option>
                  ))}
                </select>
                <select name="result" required defaultValue="2-0">
                  <option value="2-0">2-0 (I won both)</option>
                  <option value="1-1">1-1 (draw)</option>
                  <option value="0-2">0-2 (I lost both)</option>
                </select>
                <button type="submit">Report</button>
              </form>
            )}

            <p className="muted" style={{ fontSize: 11, marginTop: 12 }}>
              Reports go to <strong>#results</strong> in Discord with Confirm + Dispute buttons. Your opponent
              has 2 minutes — if no one clicks, it auto-confirms. Something wrong? Dispute it inline below
              or ping a <strong>League Helper</strong> in Discord.
            </p>
          </div>
        )}

        {disputeOk && (
          <div className="card" style={{ borderColor: "#2ecc71", color: "#2ecc71" }}>
            ✓ Dispute filed. A helper has been pinged in #results.
          </div>
        )}
        {disputeErr && (
          <div className="card" style={{ borderColor: "#e74c3c", color: "#e74c3c" }}>
            {disputeErr}
          </div>
        )}

        {player && division && recentMatches.length > 0 && (
          <details className="card">
            <summary style={{ cursor: "pointer" }}>
              <strong>Your recent matches ({recentMatches.length})</strong>
            </summary>
            <p className="muted" style={{ fontSize: 11, marginTop: 8 }}>
              Made a mistake or got an unfair confirm? Click Dispute to flag it for a helper.
              Tell them what it should have been and they can one-click apply your correction.
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
                  const outcome =
                    isDisputed ? { bg: "rgba(241,196,15,0.15)", fg: "#f1c40f", label: "DISPUTED" }
                    : m.outcome === "WIN" ? { bg: "rgba(46,204,113,0.15)", fg: "#2ecc71", label: "W" }
                    : m.outcome === "LOSS" ? { bg: "rgba(231,76,60,0.15)", fg: "#e74c3c", label: "L" }
                    : { bg: "rgba(241,196,15,0.15)", fg: "#f1c40f", label: "D" };
                  return (
                    <tr key={m.pairingId} style={isDisputed ? { opacity: 0.7 } : undefined}>
                      <td>{date}</td>
                      <td>
                        <Link href={`/profile/${m.opponentPlayerId}`} style={{ color: "var(--text)" }}>{m.opponentDisplayName}</Link>
                      </td>
                      <td><strong>{m.myGames}–{m.opponentGames}</strong></td>
                      <td><span className="pill" style={{ background: outcome.bg, color: outcome.fg, fontSize: isDisputed ? 10 : undefined }}>{outcome.label}</span></td>
                      <td>
                        <details>
                          <summary style={{ cursor: "pointer", fontSize: 11 }} className="muted">
                            {isDisputed ? "Update dispute" : "Dispute"}
                          </summary>
                          <form action={submitReportPageDispute} style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 4, minWidth: 220 }}>
                            <input type="hidden" name="pairingId" value={m.pairingId} />
                            <label style={{ fontSize: 11 }} className="muted">What it should be (your POV):</label>
                            <select name="proposed" defaultValue="unsure" style={{ fontSize: 12 }}>
                              <option value="unsure">— not sure, let helper decide —</option>
                              <option value="2-0">2-0 (I won both)</option>
                              <option value="1-1">1-1 (draw)</option>
                              <option value="0-2">0-2 (I lost both)</option>
                            </select>
                            <textarea
                              name="reason"
                              rows={2}
                              placeholder="Optional context for the helper…"
                              maxLength={500}
                              style={{ fontSize: 12 }}
                            />
                            <button type="submit" className="secondary" style={{ fontSize: 11 }}>
                              Submit dispute
                            </button>
                          </form>
                        </details>
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
