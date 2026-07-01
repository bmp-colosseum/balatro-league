import Link from "next/link";
import { ArrowLeft, Trophy } from "lucide-react";
import { getPublicBracket, getChampionRun } from "@/lib/playoffs";
import { getPlayoffPicture } from "@/lib/playoff-picture";

export const dynamic = "force-dynamic";

export default async function BracketPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const seasonName = decodeURIComponent(name);
  const enc = encodeURIComponent(seasonName);

  const [bracket, run, picture] = await Promise.all([
    getPublicBracket(seasonName),
    getChampionRun(seasonName),
    getPlayoffPicture(seasonName),
  ]);

  const back = (
    <p>
      <Link href={`/seasons/${enc}`} className="inline-flex items-center gap-1"><ArrowLeft className="size-3.5" /> {seasonName}</Link>
    </p>
  );

  // 1. Full live/finished bracket (B8 seasons with seeded entries).
  if (bracket) {
    return (
      <main>
        {back}
        <h1>Playoff bracket</h1>
        {bracket.champion && (
          <p className="flex items-center gap-1.5">
            <Trophy className="size-4 text-[var(--accent)]" />
            <span className="muted">Champion:</span> <strong>{bracket.championTeamSeasonId ? <Link href={`/teams/${bracket.championTeamSeasonId}`}>{bracket.champion}</Link> : bracket.champion}</strong>
          </p>
        )}
        <p className="sub">Click a series to see the player-by-player sets.</p>
        <div className="card" style={{ overflowX: "auto" }}>
          <div className="bracket">
            {bracket.rounds.map((r) => (
              <div className="bracket-round" key={r.round}>
                <div className="bracket-label">{r.label}</div>
                <div className="bracket-matches">
                  {r.series.map((s, i) => (
                    <details className="bracket-match" key={i} style={{ cursor: s.sets.length ? "pointer" : "default" }}>
                      <summary style={{ listStyle: "none" }}>
                        <div className={`bracket-team${s.winner === "A" ? " win" : ""}`}>
                          <span>{s.aSeed ? `#${s.aSeed} ` : ""}{s.aTeamSeasonId ? <Link href={`/teams/${s.aTeamSeasonId}`}>{s.aName}</Link> : s.aName}</span>
                          <span className="score">{s.scoreA ?? "—"}</span>
                        </div>
                        <div className={`bracket-team${s.winner === "B" ? " win" : ""}`}>
                          <span>{s.bSeed ? `#${s.bSeed} ` : ""}{s.bTeamSeasonId ? <Link href={`/teams/${s.bTeamSeasonId}`}>{s.bName}</Link> : s.bName}</span>
                          <span className="score">{s.scoreB ?? "—"}</span>
                        </div>
                      </summary>
                      {s.sets.length > 0 && (
                        <table style={{ margin: "0.25rem 0.5rem 0.5rem", fontSize: "0.85em" }}>
                          <tbody>
                            {s.sets.map((st, j) => (
                              <tr key={j}>
                                <td style={{ color: st.winner === "A" ? "var(--success)" : undefined }}><Link href={`/players/${st.playerAId}`}>{st.playerA}</Link></td>
                                <td className="num" style={{ width: 44, textAlign: "center" }}>{st.scoreA}–{st.scoreB}</td>
                                <td style={{ textAlign: "right", color: st.winner === "B" ? "var(--success)" : undefined }}><Link href={`/players/${st.playerBId}`}>{st.playerB}</Link></td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </details>
                  ))}
                </div>
              </div>
            ))}
            {bracket.championTeamSeasonId && (
              <div className="bracket-round">
                <div className="bracket-label">Champion</div>
                <div className="bracket-matches">
                  <div className="bracket-champion flex items-center justify-center gap-1.5">
                    <Trophy className="size-4" /> <Link href={`/teams/${bracket.championTeamSeasonId}`}>{bracket.champion}</Link>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </main>
    );
  }

  // 2. Historical champion-path (only the winner's run is recorded).
  if (run) {
    return (
      <main>
        {back}
        <h1>Playoff bracket</h1>
        <p className="sub">Only the champion&apos;s run was recorded for this season.</p>
        <div className="card">
          <div className="bracket-title flex items-center gap-2"><Trophy className="size-4" /> <Link href={`/teams/${run.championTeamSeasonId}`}>{run.champion}</Link></div>
          <div className="bracket">
            {run.rounds.map((r) => (
              <div className="bracket-round" key={r.round}>
                <div className="bracket-label">{r.label}</div>
                <div className="bracket-match">
                  <div className="bracket-team win">
                    <span><Link href={`/teams/${run.championTeamSeasonId}`}>{run.champion}</Link></span>
                    <span className="score">{r.champScore}</span>
                  </div>
                  <div className="bracket-team">
                    <span>{r.opponentTeamSeasonId ? <Link href={`/teams/${r.opponentTeamSeasonId}`}>{r.opponent}</Link> : (r.opponent ?? "—")}</span>
                    <span className="score">{r.oppScore}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </main>
    );
  }

  // 3. Playoffs not started — show the projected picture from the standings.
  if (picture && picture.qualifiers.length > 0) {
    return (
      <main>
        {back}
        <h1>Playoff bracket</h1>
        <p className="sub">Playoffs haven&apos;t started — projected field + first round, from the current standings.</p>
        <div className="card">
          <div className="bracket-title">Projected field</div>
          <table>
            <thead><tr><th className="rank">Seed</th><th>Team</th><th>Conference</th></tr></thead>
            <tbody>
              {picture.qualifiers.map((q) => (
                <tr key={q.seed}><td className="rank">{q.seed}</td><td><Link href={`/teams/${q.teamSeasonId}`}>{q.name}</Link></td><td className="sub">{q.conference}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
        {picture.quarterfinals.length > 0 && (
          <div className="card">
            <div className="bracket-title">Projected first round</div>
            <ul className="list-none p-0" style={{ margin: 0 }}>
              {picture.quarterfinals.map((m, i) => (
                <li key={i} className="py-0.5"><Link href={`/teams/${m.aTeamSeasonId}`}>{m.a}</Link> <span className="muted">vs</span> <Link href={`/teams/${m.bTeamSeasonId}`}>{m.b}</Link></li>
              ))}
            </ul>
          </div>
        )}
      </main>
    );
  }

  return (
    <main>
      {back}
      <h1>Playoff bracket</h1>
      <div className="card"><p className="sub">No playoff bracket for this season yet.</p></div>
    </main>
  );
}
