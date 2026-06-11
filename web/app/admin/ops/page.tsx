// Ops page — OWNER/DEVOPS-only infra tools. Currently just the
// match-thread sweep trigger; new infra-level buttons (force-close
// thread by ID, list orphans, etc.) belong here too.

import { requireOwnerOrDevops } from "@/lib/admin";
import { SiteNav } from "@/components/SiteNav";
import { Button } from "@/components/ui/button";
import { AdminNav } from "@/components/AdminNav";
import { runMatchSweepAction } from "./actions";

export const dynamic = "force-dynamic";

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
  searchParams: Promise<{ sweepDiag?: string }>;
}) {
  await requireOwnerOrDevops();
  const { sweepDiag } = await searchParams;
  const diag = parseDiag(sweepDiag);

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
          <div className="card" style={{ borderColor: "#2ecc71" }}>
            <strong style={{ color: "#2ecc71" }}>✓ Sweep complete</strong>
            <table className="table-dense" style={{ marginTop: 8 }}>
              <tbody>
                <tr><td className="muted">Expired invites cancelled</td><td>{diag.expiredInvitesCancelled ?? 0}</td></tr>
                <tr><td className="muted">Idle (24h+) sessions cancelled</td><td>{diag.idleSessionsCancelled ?? 0}</td></tr>
                <tr><td className="muted">Leaked threads processed / deleted</td><td>{diag.leakedThreadsProcessed ?? 0} / {diag.leakedThreadsDeleted ?? 0}</td></tr>
                <tr><td colSpan={2} style={{ paddingTop: 8, fontSize: 11, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.5 }}>Orphan scan</td></tr>
                <tr>
                  <td className="muted">DISCORD_GUILD_ID configured</td>
                  <td>{diag.guildIdConfigured ? "yes" : <span style={{ color: "#e74c3c" }}>NO — orphan scan skipped</span>}</td>
                </tr>
                <tr>
                  <td className="muted">Match-parent channels scanned</td>
                  <td>{diag.matchParentChannels ?? 0}{diag.matchParentChannels === 0 && <span style={{ color: "#e74c3c" }}> — no channels found, scan skipped</span>}</td>
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
            The bot runs the first three passes every minute. This button fires all
            four on demand — useful when the bot is down, or to catch the gap the
            cron can&apos;t see.
          </p>
          <ul className="muted" style={{ fontSize: 12, marginTop: 4, paddingLeft: 18 }}>
            <li><strong>Expired invites</strong> — WAITING_ACCEPT sessions past their expiry, cancel + delete thread.</li>
            <li><strong>Idle sessions</strong> — any non-terminal session with no activity for 24h+, cancel + delete thread.</li>
            <li><strong>Leaked threads</strong> — finished/cancelled sessions whose inline thread-close failed; retry delete.</li>
            <li><strong>Orphan threads</strong> (manual-only) — scans both <em>active</em> AND <em>archived</em> threads under known match-parent channels (challenges + divisions). Any without a MatchSession row gets deleted.</li>
          </ul>
          <form action={runMatchSweepAction} style={{ marginTop: 8 }}>
            <Button type="submit" variant="secondary">Run sweep now</Button>
          </form>
        </div>
      </main>
    </>
  );
}
