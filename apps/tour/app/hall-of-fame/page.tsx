import Link from "next/link";
import { Trophy } from "lucide-react";
import { getAllChampions } from "@/lib/champions";

export const dynamic = "force-dynamic";

export default async function HallOfFame() {
  const champions = await getAllChampions();

  return (
    <main>
      <h1 className="flex items-center gap-2"><Trophy className="size-6 text-[var(--accent)]" /> Hall of Fame</h1>
      <p className="sub">Every Team Tour champion and their playoff run.</p>

      {champions.map((c) => (
        <div className="card" key={c.season}>
          <div className="bracket-title flex items-center gap-2">
            <Link href={`/seasons/${encodeURIComponent(c.season)}`}>{c.season}</Link>
            <span className="text-[var(--muted)]">—</span>
            <Trophy className="size-4" /> <Link href={`/teams/${c.championTeamSeasonId}`}>{c.champion}</Link>
          </div>
          <div className="bracket">
            {c.rounds.map((r) => (
              <div className="bracket-round" key={r.round}>
                <div className="bracket-label">{r.label}</div>
                <div className="bracket-match">
                  <div className="bracket-team win">
                    <span><Link href={`/teams/${c.championTeamSeasonId}`}>{c.champion}</Link></span>
                    <span className="score">{r.champScore}</span>
                  </div>
                  <div className="bracket-team">
                    <span>{r.opponentTeamSeasonId ? <Link href={`/teams/${r.opponentTeamSeasonId}`}>{r.opponent}</Link> : (r.opponent ?? "—")}</span>
                    <span className="score">{r.oppScore}</span>
                  </div>
                </div>
              </div>
            ))}
            <div className="bracket-round">
              <div className="bracket-label">Champion</div>
              <div className="bracket-champion flex items-center justify-center gap-1.5">
                <Trophy className="size-4" /> <Link href={`/teams/${c.championTeamSeasonId}`}>{c.champion}</Link>
              </div>
            </div>
          </div>
        </div>
      ))}

      {champions.length === 0 && <p className="sub">No champions recorded yet.</p>}
    </main>
  );
}
