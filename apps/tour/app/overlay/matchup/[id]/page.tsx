// Regular-season matchup scoreboard overlay (OBS browser source): two team names + the live set
// score (first to setsToWin). Live-updates via SSE (every set report fires `matchup:<id>`).
// URL: /overlay/matchup/<matchupId>.
import { getMatchupReport } from "@/lib/services/report";
import { LiveRefresh } from "@/components/LiveRefresh";
import { Scoreboard } from "@/components/Scoreboard";

export const dynamic = "force-dynamic";

export default async function MatchupOverlay({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await getMatchupReport(id);
  if (!r) return <main><div style={{ color: "var(--muted)" }}>No matchup.</div></main>;

  const winner = !r.winnerTeamName ? null : r.winnerTeamName === r.teamAName ? ("A" as const) : ("B" as const);
  const sub = r.decided ? `${r.winnerTeamName} wins` : `First to ${r.setsToWin} sets`;
  return (
    <main>
      <LiveRefresh channel={`matchup:${id}`} />
      <Scoreboard aName={r.teamAName} bName={r.teamBName} aScore={r.setsWonA} bScore={r.setsWonB} winner={winner} sub={sub} />
    </main>
  );
}
