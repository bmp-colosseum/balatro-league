import { requireAdmin } from "@/lib/admin";
import { loadAdminHomeStats } from "@/lib/loaders/admin";
import { seasonCountdown } from "@/lib/season-countdown-core";
import { SiteNav } from "@/components/SiteNav";
import { AdminNav } from "@/components/AdminNav";

export const dynamic = "force-dynamic";

export default async function AdminHome() {
  await requireAdmin();
  const stats = await loadAdminHomeStats();
  const countdown = stats.activeSeason
    ? seasonCountdown({
        startMs: stats.activeSeason.startedAt.getTime(),
        scheduledEndMs: stats.activeSeason.scheduledEndAt?.getTime() ?? null,
        endedMs: stats.activeSeason.endedAt?.getTime() ?? null,
        nowMs: Date.now(),
      })
    : null;

  return (
    <>
      <SiteNav activePath="/admin" />
      <AdminNav activePath="/admin" />
      <main>
        <h2>Admin dashboard</h2>

        {stats.activeSeason ? (
          <>
            {countdown && (
              <p className="muted" style={{ fontSize: 13, marginTop: -4, marginBottom: 12 }}>
                {countdown.label}
                {countdown.kind === "no-end-set" && (
                  <>
                    {" - "}
                    <a href={`/seasons/${stats.activeSeason.id}#end-date`}>Set an end date</a>
                  </>
                )}
              </p>
            )}
            <div className="grid grid-3">
              <div className="stat"><div className="label">Active season</div><div className="value" style={{ fontSize: 20 }}>{stats.activeSeason.name}</div></div>
              <div className="stat"><div className="label">Divisions</div><div className="value">{stats.activeSeason.divisionCount}</div></div>
              <div className="stat"><div className="label">Matches confirmed</div><div className="value">{stats.confirmedPairings}</div></div>
            </div>
            <div className="grid grid-2" style={{ marginTop: 16 }}>
              <div className="stat"><div className="label">Players (total)</div><div className="value">{stats.totalPlayers}</div></div>
              <div className="stat"><div className="label">Disputed matches</div><div className="value">{stats.disputedPairings}</div></div>
            </div>
          </>
        ) : (
          <div className="card">
            <strong>No active season.</strong>
            <p className="muted">Head to <a href="/admin/seasons">Seasons</a> to start one.</p>
          </div>
        )}
      </main>
    </>
  );
}
