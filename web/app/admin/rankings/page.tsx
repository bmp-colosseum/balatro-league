import { requireAdmin } from "@/lib/admin";
import { loadAdminRankings } from "@/lib/loaders/admin";
import { tierColors } from "@/lib/tier-colors";
import { SiteNav } from "@/components/SiteNav";
import { AdminNav } from "@/components/AdminNav";
import { setRating, bulkRatings, refreshActiveSeasonMmrs } from "./actions";

export const dynamic = "force-dynamic";

export default async function AdminRankingsPage() {
  await requireAdmin();
  const players = await loadAdminRankings();

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
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
            <strong>All players ({players.length})</strong>
            <form action={refreshActiveSeasonMmrs}>
              <button type="submit" className="secondary" style={{ fontSize: 12 }}>
                Refresh BMP MMRs (active season)
              </button>
            </form>
          </div>
          <p className="muted" style={{ fontSize: 12 }}>
            Auto-refreshes daily @ 12:00 UTC for current-season players. Click for
            an on-demand refresh — fans out a snapshot job per player, drains at
            ~1 req/3sec so a full season takes a few minutes.
          </p>
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
              ) : players.map((p) => (
                <tr key={p.id}>
                  <td><strong>{p.displayName}</strong></td>
                  <td><span className="muted">{p.discordId}</span></td>
                  <td>
                    {p.division ? (
                      <TierPill name={p.division.name} position={p.division.tierPosition} />
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td style={{ fontSize: 12 }}>
                    {p.latestMmr?.rankedMmr != null ? (
                      <span>
                        <strong>{p.latestMmr.rankedMmr}</strong>{" "}
                        <span className="muted">({p.latestMmr.rankedTier})</span>
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
              ))}
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
