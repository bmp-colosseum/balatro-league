import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/admin";
import { loadEndSeasonPreview } from "@/lib/loaders/admin";
import { SiteNav } from "@/components/SiteNav";
import { AdminNav } from "@/components/AdminNav";
import { endSeason } from "../../actions";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";

export default async function EndSeasonPreviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireAdmin();
  const { id } = await params;
  const preview = await loadEndSeasonPreview(id);
  if (!preview) notFound();
  const { season, unfinishedPairings, divisions, deltasByPlayer } = preview;
  const totalDeltas = deltasByPlayer.size;

  return (
    <>
      <SiteNav activePath="/admin" />
      <AdminNav activePath="/admin/seasons" />
      <main>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <h2 style={{ margin: 0 }}>End "{season.name}"</h2>
          <Link href="/admin/seasons" className="muted" style={{ marginLeft: "auto" }}>
            ← Back
          </Link>
        </div>
        <p className="muted">
          Preview of new rankings (1 = best). Each division's top finisher promotes to the
          previous division (↑ green on /standings); bottom finisher relegates to the next
          division (↓ red). Middle finishers keep their position. So top of Rare 1 moves
          into Legendary's bottom slot, bottom of Legendary drops to top of Rare 1, bottom
          of Rare 1 swaps with top of Rare 2, and so on. Dropped players keep their current
          ranking.
        </p>

        {unfinishedPairings > 0 && (
          <div className="card" style={{ borderColor: "#f1c40f", color: "#f1c40f" }}>
            ⚠ {unfinishedPairings} pairing(s) still unplayed across this season. Ending now will rank
            players on their partial records — confirm with the league before clicking through.
          </div>
        )}

        {divisions.map((d) => (
          <div key={d.divisionId} className="card">
            <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
              <strong>{d.divisionName}</strong>
              <span className="muted" style={{ fontSize: 12 }}>(tier {d.tierPosition} — {d.tierName})</span>
            </div>
            <table style={{ marginTop: 8 }}>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Player</th>
                  <th title="Rank before this end-season recompute (1 = best)">Old rank</th>
                  <th title="Rank after this end-season recompute (1 = best)">New rank</th>
                  <th title="↑ = climbed in rank, ↓ = dropped">Movement</th>
                </tr>
              </thead>
              <tbody>
                {d.standings.length === 0 ? (
                  <tr><td colSpan={5} className="muted">No active members in this division.</td></tr>
                ) : d.standings.map((row, idx) => {
                  const delta = deltasByPlayer.get(row.player.id);
                  if (!delta) {
                    return (
                      <tr key={row.player.id}>
                        <td>{idx + 1}</td>
                        <td>
                          <Link href={`/profile/${row.player.id}`} style={{ color: "var(--text)" }}>{row.player.displayName}</Link>
                          {" "}<span className="muted">(dropped)</span>
                        </td>
                        <td colSpan={3} className="muted">no change</td>
                      </tr>
                    );
                  }
                  // Rating is now a rank (1 = best). A NEGATIVE delta
                  // means the player MOVED UP (e.g. went from rank 5 to
                  // rank 1 → delta = -4). Color + arrow flip accordingly:
                  // movement toward 1 (lower number) is green/↑, away is
                  // red/↓.
                  const improved = delta.delta < 0;
                  const worsened = delta.delta > 0;
                  const positions = Math.abs(delta.delta);
                  return (
                    <tr key={row.player.id}>
                      <td>{idx + 1}</td>
                      <td>
                        <Link href={`/profile/${row.player.id}`} style={{ color: "var(--text)" }}>
                          <strong>{row.player.displayName}</strong>
                        </Link>
                      </td>
                      <td>{delta.oldRating != null ? `#${delta.oldRating}` : "—"}</td>
                      <td>#{delta.newRating}</td>
                      <td style={{ color: improved ? "#2ecc71" : worsened ? "#e74c3c" : undefined }}>
                        {improved ? `↑ ${positions}` : worsened ? `↓ ${positions}` : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ))}

        <div className="card">
          <strong>Confirm</strong>
          <p className="muted">
            This will update {totalDeltas} player rating(s) and mark the season inactive.
            Player ratings are used by next season's auto-seed in the build-season wizard.
          </p>
          <form action={endSeason} style={{ display: "flex", gap: 8 }}>
            <input type="hidden" name="id" value={season.id} />
            <Button type="submit">End season + apply ratings</Button>
            <Link href="/admin/seasons" className="secondary">Cancel</Link>
          </form>
        </div>
      </main>
    </>
  );
}
