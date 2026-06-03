// Ops page — OWNER/DEVOPS-only infra tools. Currently just the
// match-thread sweep trigger; new infra-level buttons (force-close
// thread by ID, list orphans, etc.) belong here too.

import { requireOwnerOrDevops } from "@/lib/admin";
import { SiteNav } from "@/components/SiteNav";
import { AdminNav } from "@/components/AdminNav";
import { runMatchSweepAction } from "./actions";

export const dynamic = "force-dynamic";

export default async function AdminOpsPage({
  searchParams,
}: {
  searchParams: Promise<{ sweepOk?: string }>;
}) {
  await requireOwnerOrDevops();
  const { sweepOk } = await searchParams;

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

        {sweepOk && (
          <div className="card" style={{ borderColor: "#2ecc71", color: "#2ecc71" }}>
            ✓ Sweep complete. {sweepOk}
          </div>
        )}

        <div className="card">
          <strong>Match-thread sweep</strong>
          <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            The bot runs this every minute. Click here to fire it on demand — useful
            if the bot is down, or if you can see stale threads and want them flushed now.
            Three passes: expired invites (WAITING_ACCEPT past expiry), idle sessions
            (no activity for 24h+), and leaked threads (finished/cancelled sessions whose
            thread close failed). Hits Discord REST directly; no bot needed.
          </p>
          <form action={runMatchSweepAction} style={{ marginTop: 8 }}>
            <button type="submit" className="secondary">Run sweep now</button>
          </form>
        </div>
      </main>
    </>
  );
}
