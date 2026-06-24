import { requireAdmin } from "@/lib/admin";
import { SiteNav } from "@/components/SiteNav";
import { AdminNav } from "@/components/AdminNav";
import { SubmitButton } from "@/components/SubmitButton";
import { loadActivityData } from "@/lib/loaders/activity";
import { startActivityScan, sendTestCheckin, cancelActivityScan, sendCheckinDms, setCheckinOptOut } from "./actions";

export const dynamic = "force-dynamic";

function ago(ms: number | null): string {
  if (ms === null) return "never posted";
  const days = Math.floor((Date.now() - ms) / 86_400_000);
  if (days <= 0) return "today";
  return `${days}d ago`;
}

function checkinBadge(status: string | null) {
  switch (status) {
    case "pending":
      return <span style={{ color: "var(--accent)" }}>⏳ asked</span>;
    case "in":
      return <span style={{ color: "var(--success)" }}>✅ still in</span>;
    case "out":
      return <span style={{ color: "var(--danger)" }}>🚪 out</span>;
    case "dm-failed":
      return <span style={{ color: "var(--danger)" }}>✉ DM failed</span>;
    default:
      return <span className="muted">—</span>;
  }
}

export default async function ActivityPage() {
  await requireAdmin();
  const data = await loadActivityData();
  const scan = data.scan;
  const running = scan?.status === "RUNNING";
  // Sendable = flagged players not opted out and not yet asked (or DM previously failed).
  const sendable = (data.ghosts ?? []).filter(
    (g) => !g.optedOut && (g.checkinStatus === null || g.checkinStatus === "dm-failed"),
  ).length;

  return (
    <>
      <SiteNav activePath="/admin" />
      <AdminNav activePath="/admin/activity" />
      <main>
        <h2>Player activity</h2>
        <p className="muted">
          Scan the league&apos;s chat channels to find registered players who&apos;ve gone silent — no posts this
          season and no match played or attempted. The bot does the scan; this page drives it.
        </p>

        <div className="card" style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
          <form action={sendTestCheckin}>
            <SubmitButton variant="secondary" pendingText="Sending…">🧪 Send me a test DM</SubmitButton>
          </form>
          <span className="muted" style={{ fontSize: 12 }}>
            DMs you the exact check-in message players would get (uses your division if you&apos;re in one). Confirms
            the jump link works in a DM before any real send.
          </span>
        </div>

        {!data.hasSeason ? (
          <div className="card muted">No active season.</div>
        ) : (
          <>
            <div className="card" style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
              <form action={startActivityScan}>
                <SubmitButton disabled={running} pendingText="Starting…">
                  {running ? "Scanning…" : scan ? "Re-scan" : "Run scan"}
                </SubmitButton>
              </form>
              {running && (
                <form action={cancelActivityScan}>
                  <SubmitButton variant="secondary" pendingText="Cancelling…">✖ Cancel / clear</SubmitButton>
                </form>
              )}
              {scan ? (
                <span style={{ fontSize: 14 }}>
                  <strong
                    style={{
                      color:
                        scan.status === "DONE"
                          ? "var(--success)"
                          : scan.status === "FAILED"
                            ? "var(--danger)"
                            : "var(--accent)",
                    }}
                  >
                    {scan.status === "DONE" ? "✅ done" : scan.status === "FAILED" ? "❌ failed" : "⏳ running"}
                  </strong>
                  <span className="muted">
                    {" "}
                    · {scan.channelsDone}/{scan.channelsTotal} channels · {scan.messagesScanned} messages
                  </span>
                </span>
              ) : (
                <span className="muted" style={{ fontSize: 14 }}>No scan yet.</span>
              )}
              {running && (
                <span className="muted" style={{ fontSize: 12 }}>Refresh this page to update progress.</span>
              )}
              {scan?.status === "FAILED" && scan.error && (
                <span className="muted" style={{ fontSize: 12 }}>Error: {scan.error}</span>
              )}
            </div>

            <h3 style={{ marginTop: 24 }}>
              Inactive registry{" "}
              <span className="muted" style={{ fontSize: 14, fontWeight: "normal" }}>
                · {data.activeTotal} active player{data.activeTotal === 1 ? "" : "s"}
              </span>
            </h3>

            {data.ghosts === null ? (
              <div className="card muted">
                Run a scan and let it finish — the registry needs the chat signal. (Match activity alone isn&apos;t
                enough to call someone silent.)
              </div>
            ) : data.ghosts.length === 0 ? (
              <div className="card" style={{ color: "var(--success)" }}>
                ✅ Nobody&apos;s fully silent — every active player has chatted, played, or at least started a match.
              </div>
            ) : (
              <>
                <p className="muted" style={{ fontSize: 13 }}>
                  <strong>{data.ghosts.length}</strong> player{data.ghosts.length === 1 ? "" : "s"} — silent in their
                  division channel this season, and no match played or attempted.
                </p>
                <div className="card" style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 10 }}>
                  <form action={sendCheckinDms}>
                    <SubmitButton disabled={sendable === 0} pendingText="Sending…">
                      📨 Send check-in DMs ({sendable})
                    </SubmitButton>
                  </form>
                  <a href="/admin/activity/export" className="muted" style={{ fontSize: 13 }}>⬇ Export CSV</a>
                  <span className="muted" style={{ fontSize: 12 }}>
                    DMs the not-yet-asked players (skips opt-outs + anyone already asked/answered — safe to re-run).
                  </span>
                </div>
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th style={{ textAlign: "left" }}>Player</th>
                        <th style={{ textAlign: "left" }}>Division</th>
                        <th style={{ textAlign: "left" }}>Last chat post</th>
                        <th style={{ textAlign: "left" }}>Before?</th>
                        <th style={{ textAlign: "left" }}>Check-in</th>
                        <th style={{ textAlign: "left" }}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.ghosts.map((g) => (
                        <tr key={g.playerId} style={{ opacity: g.optedOut ? 0.55 : 1 }}>
                          <td><strong>{g.name}</strong>{g.optedOut && <span className="muted" style={{ fontSize: 11 }}> · opted out</span>}</td>
                          <td className="muted">{g.division}</td>
                          <td className="muted">{ago(g.lastPostMs)}</td>
                          <td className="muted">{g.playedPrevSeason ? "↩ returning" : "new"}</td>
                          <td>{checkinBadge(g.checkinStatus)}</td>
                          <td>
                            <form action={setCheckinOptOut}>
                              <input type="hidden" name="playerId" value={g.playerId} />
                              <input type="hidden" name="optOut" value={(!g.optedOut).toString()} />
                              <SubmitButton variant="secondary" size="sm" pendingText="…">
                                {g.optedOut ? "Opt in" : "Opt out"}
                              </SubmitButton>
                            </form>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </>
        )}
      </main>
    </>
  );
}
