import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/admin";
import { loadEndSeasonPreview } from "@/lib/loaders/admin";
import { SiteNav } from "@/components/SiteNav";
import { AdminNav } from "@/components/AdminNav";
import { endSeason } from "../../actions";

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
          Preview of rating changes. Top finishers in each tier get rating ≈ the tier above them
          (sets up natural promotion next season); bottom finishers get rating ≈ the tier below
          them. Dropped players keep their current rating.
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
                  <th>Old</th>
                  <th>New</th>
                  <th>Δ</th>
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
                        <td>{row.player.displayName} <span className="muted">(dropped)</span></td>
                        <td colSpan={3} className="muted">no change</td>
                      </tr>
                    );
                  }
                  const positive = delta.delta > 0;
                  const negative = delta.delta < 0;
                  return (
                    <tr key={row.player.id}>
                      <td>{idx + 1}</td>
                      <td><strong>{row.player.displayName}</strong></td>
                      <td>{delta.oldRating ?? "—"}</td>
                      <td>{delta.newRating}</td>
                      <td style={{ color: positive ? "#2ecc71" : negative ? "#e74c3c" : undefined }}>
                        {delta.delta > 0 ? "+" : ""}{delta.delta}
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
            <button type="submit">End season + apply ratings</button>
            <Link href="/admin/seasons" className="secondary">Cancel</Link>
          </form>
        </div>
      </main>
    </>
  );
}
