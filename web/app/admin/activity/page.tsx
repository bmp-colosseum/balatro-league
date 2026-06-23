import { requireAdmin } from "@/lib/admin";
import { SiteNav } from "@/components/SiteNav";
import { AdminNav } from "@/components/AdminNav";
import { SubmitButton } from "@/components/SubmitButton";
import { loadActivityData } from "@/lib/loaders/activity";
import { startActivityScan, sendTestCheckin } from "./actions";

export const dynamic = "force-dynamic";

function ago(ms: number | null): string {
  if (ms === null) return "never posted";
  const days = Math.floor((Date.now() - ms) / 86_400_000);
  if (days <= 0) return "today";
  return `${days}d ago`;
}

export default async function ActivityPage() {
  await requireAdmin();
  const data = await loadActivityData();
  const scan = data.scan;
  const running = scan?.status === "RUNNING";

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
                  <strong>{data.ghosts.length}</strong> player{data.ghosts.length === 1 ? "" : "s"} — silent in chat
                  this season, and no match played or attempted. These are who you&apos;d check in with.
                </p>
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th style={{ textAlign: "left" }}>Player</th>
                        <th style={{ textAlign: "left" }}>Division</th>
                        <th style={{ textAlign: "left" }}>Last chat post</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.ghosts.map((g) => (
                        <tr key={g.playerId}>
                          <td><strong>{g.name}</strong></td>
                          <td className="muted">{g.division}</td>
                          <td className="muted">{ago(g.lastPostMs)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                  Next: a &ldquo;Send check-in DMs&rdquo; step (Still-playing / I&apos;m-out buttons) — coming in the
                  follow-up.
                </p>
              </>
            )}
          </>
        )}
      </main>
    </>
  );
}
