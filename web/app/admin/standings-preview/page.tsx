import { requireAdmin } from "@/lib/admin";
import { SiteNav } from "@/components/SiteNav";
import { AdminNav } from "@/components/AdminNav";
import { Callout } from "@/components/Callout";
import { Button } from "@/components/ui/button";
import { rankLabel, type StandingRow } from "@/lib/standings";
import type { BestNStandingRow } from "@/lib/standings-best-n";
import {
  loadStandingsPreview,
  loadStandingsPreviewSeasonOptions,
  type StandingsPreviewCandidate,
  type StandingsPreviewDivision,
  type StandingsPreviewPlayerDiff,
} from "@/lib/loaders/standings-preview";

export const dynamic = "force-dynamic";

const selectStyle = {
  fontSize: 13,
  padding: "5px 8px",
  borderRadius: 6,
  border: "1px solid var(--border, rgba(255,255,255,0.12))",
  background: "var(--surface-2, rgba(255,255,255,0.05))",
  color: "var(--text)",
} as const;

// Compact table shared by the "Current" and "Best N" sides of each
// division's comparison. `showOf` adds the counted/of column (only
// meaningful on the best-N side -- the current side counts everything, so
// counted === of === played there and the column would be redundant).
function CompactTable({
  rows,
  diffByPlayerId,
  showOf,
}: {
  rows: (StandingRow | BestNStandingRow)[];
  diffByPlayerId: Map<string, StandingsPreviewPlayerDiff>;
  showOf: boolean;
}) {
  return (
    <div className="table-scroll">
      <table className="table-dense" style={{ margin: 0 }}>
        <thead>
          <tr>
            <th></th>
            <th>Player</th>
            <th>Pts</th>
            <th>Record</th>
            {showOf && <th title="Results counted toward this best-N standing">Of</th>}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td colSpan={showOf ? 5 : 4} className="muted">No rows.</td></tr>
          ) : (
            rows.map((r, i) => {
              const diff = diffByPlayerId.get(r.player.id);
              const rowStyle = diff?.boundaryChanged
                ? { background: "rgba(241,196,15,0.14)" }
                : diff?.rankChanged
                  ? { background: "rgba(118,199,255,0.08)" }
                  : undefined;
              const bestN = showOf ? (r as BestNStandingRow) : null;
              return (
                <tr key={r.player.id} style={rowStyle}>
                  <td>{rankLabel(r, i)}</td>
                  <td>
                    {r.player.displayName}
                    {diff?.boundaryChanged && (
                      <span title={diff.boundaryNote ?? undefined} style={{ marginLeft: 4, color: "var(--accent)" }}>
                        !
                      </span>
                    )}
                    {!diff?.boundaryChanged && diff?.rankChanged && (
                      <span style={{ marginLeft: 4, color: "var(--info)" }}>
                        {(diff.bestNRank ?? 0) < (diff.currentRank ?? 0) ? "^" : "v"}
                      </span>
                    )}
                  </td>
                  <td><strong>{r.points}</strong></td>
                  <td className="muted" style={{ whiteSpace: "nowrap" }}>
                    {r.wins}W - {r.draws}D - {r.losses}L
                  </td>
                  {showOf && bestN && (
                    <td className="muted">{bestN.counted} of {bestN.of}</td>
                  )}
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}

// One candidate's column: its compact table plus its own notes list (the
// two candidates can disagree on who moves, so each gets its own notes).
function CandidateColumn({ label, title, candidate }: { label: string; title: string; candidate: StandingsPreviewCandidate }) {
  const diffByPlayerId = new Map(candidate.players.map((p) => [p.playerId, p]));
  const notes = candidate.players.filter((p) => p.boundaryChanged && p.boundaryNote);

  return (
    <div>
      <div className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }} title={title}>
        {label}
      </div>
      <CompactTable rows={candidate.rows} diffByPlayerId={diffByPlayerId} showOf={true} />
      {notes.length > 0 && (
        <ul style={{ margin: "8px 0 0", paddingLeft: 16, fontSize: 11 }}>
          {notes.map((n) => (
            <li key={n.playerId}>
              <strong>{n.displayName}</strong> -- {n.boundaryNote}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DivisionCard({ d }: { d: StandingsPreviewDivision }) {
  const currentDiffByPlayerId = new Map<string, StandingsPreviewPlayerDiff>();

  return (
    <div className="card" style={{ marginTop: 12 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <strong style={{ fontSize: 15 }}>{d.tierName} - {d.name}</strong>
        <span className="pill" style={{ fontSize: 11 }}>
          counts best {d.n} of {Math.max(0, d.k - 1)}
        </span>
        <span className="muted" style={{ fontSize: 12 }}>
          {d.dropouts} unreplaced dropout{d.dropouts === 1 ? "" : "s"} - {d.k} players originally
        </span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(260px, 100%), 1fr))", gap: 12, marginTop: 10 }}>
        <div>
          <div className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>
            Current
          </div>
          <CompactTable rows={d.currentRows} diffByPlayerId={currentDiffByPlayerId} showOf={false} />
        </div>
        <CandidateColumn
          label="Best N - count (preview)"
          title="A result against the dropout is a normal result, eligible to count or be dropped like any other."
          candidate={d.countMode}
        />
        <CandidateColumn
          label="Best N - void (preview)"
          title="Every result against the dropout is erased for everyone first; nobody gains or loses from having played them."
          candidate={d.voidMode}
        />
      </div>
    </div>
  );
}

export default async function StandingsPreviewPage({
  searchParams,
}: {
  searchParams: Promise<{ season?: string }>;
}) {
  await requireAdmin();
  const sp = await searchParams;
  const seasonOptions = await loadStandingsPreviewSeasonOptions();

  if (seasonOptions.length === 0) {
    return (
      <>
        <SiteNav activePath="/admin" />
        <AdminNav activePath="/admin/standings-preview" />
        <main>
          <h2>Best-N standings preview</h2>
          <div className="card muted">No seasons to preview.</div>
        </main>
      </>
    );
  }

  const defaultSeasonId = seasonOptions.find((s) => s.isActive)?.id ?? seasonOptions[0]!.id;
  const selectedSeasonId = sp.season && seasonOptions.some((s) => s.id === sp.season) ? sp.season : defaultSeasonId;
  const preview = await loadStandingsPreview(selectedSeasonId);

  return (
    <>
      <SiteNav activePath="/admin" />
      <AdminNav activePath="/admin/standings-preview" />
      <main>
        <h2>Best-N standings preview</h2>
        <p className="muted" style={{ fontSize: 13, marginTop: 4 }}>
          Preview of the proposed &ldquo;best N&rdquo; dropout-adjusted scoring rule, side by side with the{" "}
          <strong>current</strong> standings. <strong>Nothing is applied anywhere</strong> -- this page only reads
          data; live standings are completely unaffected by visiting it.
        </p>

        <form method="get" style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap", marginTop: 8 }}>
          <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
            <span className="muted">Season</span>
            <select name="season" defaultValue={selectedSeasonId} style={selectStyle}>
              {seasonOptions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}{s.isActive ? " (active)" : ""}
                </option>
              ))}
            </select>
          </label>
          <Button type="submit" variant="secondary">View {"->"}</Button>
        </form>

        {!preview.season ? (
          <div className="card muted" style={{ marginTop: 12 }}>Season not found.</div>
        ) : (
          <>
            <div className="card" style={{ marginTop: 12, display: "flex", gap: 16, flexWrap: "wrap", fontSize: 13 }}>
              <span>{preview.season.label}</span>
              <span className="muted">
                <strong>{preview.summary.divisionsWithDropout}</strong> of{" "}
                <strong>{preview.summary.totalDivisions}</strong> division{preview.summary.totalDivisions === 1 ? "" : "s"} have
                an unreplaced dropout
              </span>
              <span className="muted">
                count: <strong>{preview.summary.countMode.rankChanges}</strong> rank change{preview.summary.countMode.rankChanges === 1 ? "" : "s"},{" "}
                <strong>{preview.summary.countMode.boundaryChanges}</strong> promotion/relegation change{preview.summary.countMode.boundaryChanges === 1 ? "" : "s"}
              </span>
              <span className="muted">
                void: <strong>{preview.summary.voidMode.rankChanges}</strong> rank change{preview.summary.voidMode.rankChanges === 1 ? "" : "s"},{" "}
                <strong>{preview.summary.voidMode.boundaryChanges}</strong> promotion/relegation change{preview.summary.voidMode.boundaryChanges === 1 ? "" : "s"}
              </span>
            </div>

            {preview.divisions.length === 0 ? (
              <Callout type="success" style={{ marginTop: 12 }}>
                No divisions in {preview.season.label} have an unreplaced dropout -- best-N would make no difference
                anywhere this season.
              </Callout>
            ) : (
              preview.divisions.map((d) => <DivisionCard key={d.id} d={d} />)
            )}
          </>
        )}
      </main>
    </>
  );
}
