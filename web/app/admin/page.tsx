import { requireAdmin } from "@/lib/admin";
import { loadAdminHomeStats } from "@/lib/loaders/admin";
import { SiteNav } from "@/components/SiteNav";
import { AdminNav } from "@/components/AdminNav";

export const dynamic = "force-dynamic";

export default async function AdminHome() {
  await requireAdmin();
  const stats = await loadAdminHomeStats();

  return (
    <>
      <SiteNav activePath="/admin" />
      <AdminNav activePath="/admin" />
      <main>
        <h2>Admin dashboard</h2>

        {stats.activeSeason ? (
          <>
            <div className="grid grid-3">
              <div className="stat"><div className="label">Active season</div><div className="value" style={{ fontSize: 20 }}>{stats.activeSeason.name}</div></div>
              <div className="stat"><div className="label">Divisions</div><div className="value">{stats.activeSeason.divisionCount}</div></div>
              <div className="stat"><div className="label">Matches confirmed</div><div className="value">{stats.confirmedPairings}</div></div>
            </div>
            <div className="grid grid-3" style={{ marginTop: 16 }}>
              <div className="stat"><div className="label">Players (total)</div><div className="value">{stats.totalPlayers}</div></div>
              <div className="stat"><div className="label">Fake players</div><div className="value">{stats.fakePlayerCount}</div></div>
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
