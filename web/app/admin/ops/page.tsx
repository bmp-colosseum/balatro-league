// Ops page — OWNER/DEVOPS-only infra tools. Currently just the
// match-thread sweep trigger; new infra-level buttons (force-close
// thread by ID, list orphans, etc.) belong here too.

import { requireOwnerOrDevops } from "@/lib/admin";
import { SiteNav } from "@/components/SiteNav";
import { ConfirmButton } from "@/components/ConfirmButton";
import { SubmitButton } from "@/components/SubmitButton";
import { Callout } from "@/components/Callout";
import { AdminNav } from "@/components/AdminNav";
import { loadQueueSummaries, loadFailedJobs } from "@/lib/loaders/queue-status";
import { runMatchSweepAction, retryFailedJob, dismissFailedJob, clearQueuePending } from "./actions";

export const dynamic = "force-dynamic";

// Match the bot's stall detector threshold (jobs 'created' > 300s = flagged).
const STALL_THRESHOLD_MS = 300_000;

function ago(d: Date | null): string {
  if (!d) return "—";
  const ms = Date.now() - new Date(d).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

type SweepDiag = {
  expiredInvitesCancelled?: number;
  idleSessionsCancelled?: number;
  leakedThreadsProcessed?: number;
  leakedThreadsDeleted?: number;
  guildIdConfigured?: boolean;
  matchParentChannels?: number;
  activeThreadsInGuild?: number;
  activeThreadsUnderMatchParents?: number;
  archivedThreadsUnderMatchParents?: number;
  orphanThreadsFound?: number;
  orphanThreadsDeleted?: number;
};

function parseDiag(raw: string | undefined): SweepDiag | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SweepDiag;
  } catch {
    return null;
  }
}

export default async function AdminOpsPage({
  searchParams,
}: {
  searchParams: Promise<{ sweepDiag?: string; queueOk?: string; queueErr?: string }>;
}) {
  await requireOwnerOrDevops();
  const { sweepDiag, queueOk, queueErr } = await searchParams;
  const diag = parseDiag(sweepDiag);
  const [queues, failed] = await Promise.all([loadQueueSummaries(), loadFailedJobs(50)]);

  return (
    <>
      <SiteNav activePath="/admin" />
      <AdminNav activePath="/admin/ops" />
      <main>
        <h2>🛠 Ops</h2>
        <p className="muted">
          OWNER + DEVOPS only. Infra-level actions that touch Discord / queues / DB state
          directly — not for league mods or helpers.
        </p>

        {diag && (
          <div className="card card-success">
            <strong style={{ color: "var(--success)" }}>✓ Sweep complete</strong>
            <table className="table-dense" style={{ marginTop: 8 }}>
              <tbody>
                <tr><td className="muted">Expired invites cancelled</td><td>{diag.expiredInvitesCancelled ?? 0}</td></tr>
                <tr><td className="muted">Idle (24h+) sessions cancelled</td><td>{diag.idleSessionsCancelled ?? 0}</td></tr>
                <tr><td className="muted">Leaked threads processed / deleted</td><td>{diag.leakedThreadsProcessed ?? 0} / {diag.leakedThreadsDeleted ?? 0}</td></tr>
                <tr><td colSpan={2} style={{ paddingTop: 8, fontSize: 11, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.5 }}>Orphan scan</td></tr>
                <tr>
                  <td className="muted">DISCORD_GUILD_ID configured</td>
                  <td>{diag.guildIdConfigured ? "yes" : <span style={{ color: "var(--danger)" }}>NO — orphan scan skipped</span>}</td>
                </tr>
                <tr>
                  <td className="muted">Match-parent channels scanned</td>
                  <td>{diag.matchParentChannels ?? 0}{diag.matchParentChannels === 0 && <span style={{ color: "var(--danger)" }}> — no channels found, scan skipped</span>}</td>
                </tr>
                <tr><td className="muted">Active threads in guild (any parent)</td><td>{diag.activeThreadsInGuild ?? 0}</td></tr>
                <tr><td className="muted">Active threads under match-parents</td><td>{diag.activeThreadsUnderMatchParents ?? 0}</td></tr>
                <tr><td className="muted">Archived threads under match-parents</td><td>{diag.archivedThreadsUnderMatchParents ?? 0}</td></tr>
                <tr><td className="muted">Orphan threads found / deleted</td><td><strong>{diag.orphanThreadsFound ?? 0} / {diag.orphanThreadsDeleted ?? 0}</strong></td></tr>
              </tbody>
            </table>
          </div>
        )}

        <div className="card">
          <strong>Match-thread sweep</strong>
          <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            The bot runs the first three passes every minute. This button runs all
            four now — useful when the bot is down, or to catch what the scheduled
            run can&apos;t see.
          </p>
          <ul className="muted" style={{ fontSize: 12, marginTop: 4, paddingLeft: 18 }}>
            <li><strong>Expired invites</strong> — WAITING_ACCEPT sessions past their expiry, cancel + delete thread.</li>
            <li><strong>Idle sessions</strong> — any non-terminal session with no activity for 24h+, cancel + delete thread.</li>
            <li><strong>Leaked threads</strong> — finished/cancelled sessions whose inline thread-close failed; retry delete.</li>
            <li><strong>Orphan threads</strong> (manual-only) — scans both <em>active</em> AND <em>archived</em> threads under known match-parent channels (challenges + divisions). Any without a MatchSession row gets deleted.</li>
          </ul>
          <form action={runMatchSweepAction} style={{ marginTop: 8 }}>
            <ConfirmButton
              message="Run the orphan-thread sweep now? This deletes Discord threads with no active match."
              variant="destructive"
            >
              Run sweep now
            </ConfirmButton>
          </form>
        </div>

        {/* ── Job queue (pg-boss) ────────────────────────────────────── */}
        <h3 style={{ marginTop: 28 }}>Job queue</h3>
        <p className="muted" style={{ fontSize: 12 }}>
          Background work (DMs, announcements, bootstraps, signup asks…). A queue whose oldest pending job is
          older than <strong>5 min</strong> is flagged — that&apos;s what trips the DevOps stall alert.
        </p>
        {queueOk && <Callout type="success">✓ {queueOk.replace(/-/g, " ")}.</Callout>}
        {queueErr && <Callout type="danger">{queueErr.replace(/-/g, " ")}</Callout>}

        <div className="card" style={{ overflowX: "auto" }}>
          {queues.length === 0 ? (
            <span className="muted">No jobs in any queue right now.</span>
          ) : (
            <table className="table-dense" style={{ width: "100%" }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "left" }}>Queue</th>
                  <th>Pending</th>
                  <th>Retry</th>
                  <th>Active</th>
                  <th>Failed</th>
                  <th>Oldest pending</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {queues.map((q) => {
                  const stalled = q.oldestPending != null && Date.now() - new Date(q.oldestPending).getTime() > STALL_THRESHOLD_MS;
                  const pending = q.created + q.retry;
                  return (
                    <tr key={q.name}>
                      <td><code style={{ fontSize: 12 }}>{q.name}</code></td>
                      <td style={{ textAlign: "center" }}>{q.created || ""}</td>
                      <td style={{ textAlign: "center", color: q.retry ? "var(--admin)" : undefined }}>{q.retry || ""}</td>
                      <td style={{ textAlign: "center" }}>{q.active || ""}</td>
                      <td style={{ textAlign: "center", color: q.failed ? "var(--danger)" : undefined }}>{q.failed || ""}</td>
                      <td style={{ textAlign: "center", color: stalled ? "var(--danger)" : "var(--muted)", fontWeight: stalled ? 700 : 400 }}>
                        {q.oldestPending ? `${ago(q.oldestPending)}${stalled ? " ⚠" : ""}` : "—"}
                      </td>
                      <td style={{ textAlign: "right" }}>
                        {pending > 0 && (
                          <form action={clearQueuePending} style={{ display: "inline" }}>
                            <input type="hidden" name="queueName" value={q.name} />
                            <ConfirmButton
                              message={`Delete all ${pending} pending job(s) in "${q.name}"? This drops queued work (e.g. unsent DMs) — it does NOT cancel jobs already running.`}
                              variant="secondary"
                              size="sm"
                            >
                              Clear pending
                            </ConfirmButton>
                          </form>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        <h3 style={{ marginTop: 20 }}>
          Recent failures{failed.length > 0 && <span className="muted" style={{ fontWeight: "normal", fontSize: 14 }}> · {failed.length}</span>}
        </h3>
        <p className="muted" style={{ fontSize: 12 }}>
          Jobs that exhausted their retries, newest first, with the actual error. <strong>Retry</strong> re-queues it;
          <strong> dismiss</strong> drops it. (Older failures age out of the queue automatically.)
        </p>
        {failed.length === 0 ? (
          <div className="card" style={{ color: "var(--success)" }}>✓ No failed jobs.</div>
        ) : (
          <div className="flex flex-col gap-2">
            {failed.map((j) => (
              <div key={j.id} className="card card-danger">
                <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                  <code style={{ fontSize: 12 }}>{j.name}</code>
                  <span className="muted" style={{ fontSize: 11 }}>failed {ago(j.failedAt)} ago · {j.retryCount} retries</span>
                  <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                    <form action={retryFailedJob} style={{ display: "inline" }}>
                      <input type="hidden" name="jobId" value={j.id} />
                      <SubmitButton variant="secondary" size="sm">Retry</SubmitButton>
                    </form>
                    <form action={dismissFailedJob} style={{ display: "inline" }}>
                      <input type="hidden" name="jobId" value={j.id} />
                      <SubmitButton variant="secondary" size="sm">Dismiss</SubmitButton>
                    </form>
                  </span>
                </div>
                <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: 12, margin: "6px 0 0", color: "var(--danger)" }}>
                  {j.error}
                </pre>
              </div>
            ))}
          </div>
        )}
      </main>
    </>
  );
}
