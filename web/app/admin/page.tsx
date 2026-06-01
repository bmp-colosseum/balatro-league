import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin";
import { SiteNav } from "@/components/SiteNav";
import { AdminNav } from "@/components/AdminNav";

export const dynamic = "force-dynamic";

// Identify fake players for the count
const MOCK_PREFIXES = ["mock-", "sim-"];
function isMockId(id: string) {
  return MOCK_PREFIXES.some((p) => id.startsWith(p));
}

export default async function AdminHome() {
  await requireAdmin();

  const [activeSeason, totalPlayers, allPlayerIds, confirmed, disputed] = await Promise.all([
    prisma.season.findFirst({
      where: { isActive: true },
      include: { _count: { select: { divisions: true } } },
    }),
    prisma.player.count(),
    prisma.player.findMany({ select: { discordId: true } }),
    prisma.pairing.count({ where: { status: "CONFIRMED" } }),
    prisma.pairing.count({ where: { status: "DISPUTED" } }),
  ]);

  const fakeCount = allPlayerIds.filter((p) => isMockId(p.discordId)).length;

  return (
    <>
      <SiteNav activePath="/admin" />
      <AdminNav activePath="/admin" />
      <main>
        <h2>Admin dashboard</h2>

        {activeSeason ? (
          <>
            <div className="grid grid-3">
              <div className="stat"><div className="label">Active season</div><div className="value" style={{ fontSize: 20 }}>{activeSeason.name}</div></div>
              <div className="stat"><div className="label">Divisions</div><div className="value">{activeSeason._count.divisions}</div></div>
              <div className="stat"><div className="label">Matches confirmed</div><div className="value">{confirmed}</div></div>
            </div>
            <div className="grid grid-3" style={{ marginTop: 16 }}>
              <div className="stat"><div className="label">Players (total)</div><div className="value">{totalPlayers}</div></div>
              <div className="stat"><div className="label">Fake players</div><div className="value">{fakeCount}</div></div>
              <div className="stat"><div className="label">Disputed matches</div><div className="value">{disputed}</div></div>
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
