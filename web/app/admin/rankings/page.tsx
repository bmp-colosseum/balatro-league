import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin";
import { tierColors } from "@/lib/tier-colors";
import { SiteNav } from "@/components/SiteNav";
import { AdminNav } from "@/components/AdminNav";
import { setRating, bulkRatings } from "./actions";

export const dynamic = "force-dynamic";

export default async function AdminRankingsPage() {
  await requireAdmin();

  const players = await prisma.player.findMany({
    include: {
      memberships: {
        where: { division: { season: { isActive: true } } },
        include: { division: { include: { tier: true } } },
      },
    },
    orderBy: [{ rating: { sort: "desc", nulls: "last" } }, { displayName: "asc" }],
  });

  // Latest BMP MMR snapshot per player (any season — we want whatever's
  // most current, regardless of which season it was tied to).
  const latestSnapshots = await prisma.playerMmrSnapshot.findMany({
    where: { playerId: { in: players.map((p) => p.id) } },
    orderBy: { capturedAt: "desc" },
    distinct: ["playerId"],
  });
  const snapshotByPlayerId = new Map(
    latestSnapshots.filter((s) => s.playerId).map((s) => [s.playerId!, s] as const),
  );

  return (
    <>
      <SiteNav activePath="/admin" />
      <AdminNav activePath="/admin/rankings" />
      <main>
        <h2>Rankings</h2>
        <p className="muted">
          Set a skill rating per player (higher = better). Used by Auto-seed-by-rating to place
          top players in top tiers.
        </p>

        <div className="card">
          <strong>Bulk paste ratings</strong>
          <p className="muted">
            One per line: <code>discord_id,rating[,note]</code> or{" "}
            <code>display_name,rating[,note]</code>.
          </p>
          <form action={bulkRatings}>
            <label style={{ flex: "1 1 100%" }}>
              <textarea
                name="lines"
                rows={6}
                style={{ width: "100%", fontFamily: "ui-monospace, monospace" }}
                placeholder={`Alice,540,Glass tier\nBob,210\n111111111111111111,720,Polychrome`}
              />
            </label>
            <button type="submit">Apply</button>
          </form>
        </div>

        <div className="card">
          <strong>All players ({players.length})</strong>
          <table>
            <thead>
              <tr>
                <th>Player</th>
                <th>Discord ID</th>
                <th>Current division</th>
                <th>BMP MMR</th>
                <th>Rating (note)</th>
              </tr>
            </thead>
            <tbody>
              {players.length === 0 ? (
                <tr><td colSpan={5} className="muted">No players yet.</td></tr>
              ) : players.map((p) => {
                const div = p.memberships[0]?.division;
                const snap = snapshotByPlayerId.get(p.id);
                return (
                  <tr key={p.id}>
                    <td>
                      <strong>{p.displayName}</strong>
                    </td>
                    <td><span className="muted">{p.discordId}</span></td>
                    <td>
                      {div ? (
                        <TierPill name={div.name} position={div.tier.position} />
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td style={{ fontSize: 12 }}>
                      {snap?.rankedMmr != null ? (
                        <span>
                          <strong>{snap.rankedMmr}</strong>{" "}
                          <span className="muted">({snap.rankedTier})</span>
                        </span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td>
                      <form action={setRating} style={{ display: "flex", gap: 6 }}>
                        <input type="hidden" name="playerId" value={p.id} />
                        <input type="number" name="rating" defaultValue={p.rating ?? ""} placeholder="unrated" style={{ width: 90 }} />
                        <input type="text" name="ratingNote" defaultValue={p.ratingNote ?? ""} placeholder="note (optional)" style={{ width: 240 }} />
                        <button type="submit">Save</button>
                      </form>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </main>
    </>
  );
}

function TierPill({ name, position }: { name: string; position: number }) {
  const c = tierColors(position);
  return <span className="pill" style={{ background: c.bg, color: c.fg }}>{name}</span>;
}
