import Link from "next/link";
import { requireAdmin } from "@/lib/admin";
import { SiteNav } from "@/components/SiteNav";
import { AdminNav } from "@/components/AdminNav";
import { Callout } from "@/components/Callout";
import { loadScheduleAudit } from "@/lib/loaders/schedule-audit";

export const dynamic = "force-dynamic";

// Read-only diagnostic: surfaces any match that was STARTED against an
// off-schedule opponent on a locked schedule (see loadScheduleAudit). Lives
// under /admin so it's where admins look; nothing here mutates anything.
export default async function ScheduleAuditPage() {
  await requireAdmin();
  const audit = await loadScheduleAudit();

  return (
    <>
      <SiteNav activePath="/admin" />
      <AdminNav activePath="/admin/schedule-audit" />
      <main>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
          <h2 style={{ margin: 0 }}>🔍 Data audit</h2>
          {audit !== "NO_SEASON" && (
            <span className="muted" style={{ fontSize: 13 }}>{audit.seasonLabel}</span>
          )}
        </div>

        {audit === "NO_SEASON" && <div className="card">No active season to audit.</div>}

        {/* Broken scores: a reported match whose result awards nobody points. */}
        {audit !== "NO_SEASON" && (
          <>
            <h3 style={{ margin: "12px 0 4px" }}>Broken scores</h3>
            <p className="muted" style={{ margin: "0 0 6px", fontSize: 13 }}>
              CONFIRMED matches whose score isn&apos;t a valid <strong>2-0 / 1-1 / 0-2</strong> (0-0 = an intentional
              void is fine). The standings scorer only credits those, so anything else — e.g. a <strong>1-0</strong> —
              is <strong>reported but awards nobody points</strong>. Fix by re-recording the correct result on the
              division page (record result / override).
            </p>
            {audit.brokenScores.length === 0 ? (
              <Callout type="success">✓ No broken scores — every confirmed result is a valid 2-0 / 1-1 / 0-2.</Callout>
            ) : (
              <div className="card" style={{ padding: 0, overflow: "hidden" }}>
                <table style={{ margin: 0 }}>
                  <thead>
                    <tr>
                      <th>Division</th>
                      <th>Players</th>
                      <th style={{ textAlign: "center" }}>Recorded</th>
                    </tr>
                  </thead>
                  <tbody>
                    {audit.brokenScores.map((m) => (
                      <tr key={m.matchId}>
                        <td>{m.divisionName}</td>
                        <td>
                          {m.playerA} <span className="muted">vs</span> {m.playerB}
                        </td>
                        <td style={{ textAlign: "center" }}>
                          <span className="pill" style={{ fontSize: 11, background: "rgba(231,76,60,0.18)", color: "var(--danger)" }}>
                            {m.gamesWonA}-{m.gamesWonB}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <h3 style={{ margin: "18px 0 4px" }}>Off-schedule matches</h3>
          </>
        )}

        <p className="muted" style={{ marginTop: 4, fontSize: 13 }}>
          On a locked schedule you only play your assigned matchups. This lists any match that was{" "}
          <strong>started against an off-schedule opponent</strong> — a match session whose pair has no assigned
          matchup in its division. (The result was always blocked from being recorded; this catches the threads
          that got opened before the start path enforced it.) Shootout tiebreakers are excluded.
        </p>

        {audit === "NO_SEASON" ? null : !audit.scheduleLocked ? (
          <Callout type="info">
            This season&apos;s schedule <strong>isn&apos;t locked</strong>, so every same-division pairing is a valid
            matchup — there&apos;s nothing to enforce and nothing off-schedule by definition. This audit only means
            something once the schedule is locked.
          </Callout>
        ) : audit.offSchedule.length === 0 ? (
          <Callout type="success">
            ✓ No off-schedule matches found. All {audit.leagueSessionCount} league match session(s) this season are
            between assigned opponents.
          </Callout>
        ) : (
          <>
            <Callout type="danger">
              Found <strong>{audit.offSchedule.length}</strong> off-schedule match session(s) out of{" "}
              {audit.leagueSessionCount} this season. <strong>Live</strong> ones still have an open thread you may
              want to cancel; terminal ones (cancelled/complete) are historical and left no valid result.
            </Callout>
            <div className="card" style={{ padding: 0, overflow: "hidden" }}>
              <table style={{ margin: 0 }}>
                <thead>
                  <tr>
                    <th>Started</th>
                    <th>Division</th>
                    <th>Players</th>
                    <th>State</th>
                    <th>Thread</th>
                  </tr>
                </thead>
                <tbody>
                  {audit.offSchedule.map((m) => (
                    <tr key={m.sessionId}>
                      <td className="muted" style={{ whiteSpace: "nowrap", fontSize: 12 }}>
                        {m.createdAt.toISOString().slice(0, 10)}
                      </td>
                      <td>{m.divisionName}</td>
                      <td>
                        <Link href={`/profile/${m.playerAId}`} style={{ color: "var(--text)" }}>{m.playerA}</Link>
                        <span className="muted"> vs </span>
                        <Link href={`/profile/${m.playerBId}`} style={{ color: "var(--text)" }}>{m.playerB}</Link>
                      </td>
                      <td>
                        <span
                          className="pill"
                          style={{
                            fontSize: 11,
                            background: m.live ? "rgba(231,76,60,0.18)" : "rgba(149,165,166,0.18)",
                            color: m.live ? "var(--danger)" : "var(--muted)",
                          }}
                        >
                          {m.live ? "LIVE" : "closed"} · {m.state}
                        </span>
                      </td>
                      <td className="muted" style={{ fontSize: 12 }}>
                        {m.threadId ? m.threadId : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
              A <strong>LIVE</strong> row is an open off-schedule thread — cancel it in Discord (or via admin) since
              it can&apos;t be reported anyway. <strong>closed</strong> rows already ended with no recorded result, so
              there&apos;s nothing to undo; they&apos;re shown for completeness.
            </p>
          </>
        )}
      </main>
    </>
  );
}
