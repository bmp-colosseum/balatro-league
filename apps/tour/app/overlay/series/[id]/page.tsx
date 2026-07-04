// Playoff series scoreboard overlay (OBS browser source): two team names + the live series
// score. Live-updates via SSE (reportSeries fires `series:<id>`). URL: /overlay/series/<seriesId>.
import { getSeriesReport } from "@/lib/services/playoffs";
import { LiveRefresh } from "@/components/LiveRefresh";
import { Scoreboard } from "@/components/Scoreboard";

export const dynamic = "force-dynamic";

export default async function SeriesOverlay({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await getSeriesReport(id);
  if (!r) return <main><div style={{ color: "var(--muted)" }}>No series.</div></main>;

  const sub = r.decided ? `${(r.winner === "A" ? r.aName : r.bName)} wins the ${r.roundLabel.toLowerCase()}` : `${r.seasonName} playoffs`;
  return (
    <main>
      <LiveRefresh channel={`series:${id}`} />
      <Scoreboard label={r.roundLabel} aName={r.aName} bName={r.bName} aScore={r.scoreA} bScore={r.scoreB} aSeed={r.aSeed} bSeed={r.bSeed} winner={r.winner} sub={sub} />
    </main>
  );
}
