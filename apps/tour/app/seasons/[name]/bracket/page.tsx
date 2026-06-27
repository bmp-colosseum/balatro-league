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
            <span className="muted">Champion:</span> <strong>{bracket.champion}</strong>
          </p>
        )}
        <div className="card" style={{ overflowX: "auto" }}>
          <div className="bracket">
            {bracket.rounds.map((r) => (
              <div className="bracket-round" key={r.round}>
                <div className="bracket-label">{r.label}</div>
                {r.series.map((s, i) => (
                  <div className="bracket-match" key={i}>
                    <div className={`bracket-team${s.winner === "A" ? " win" : ""}`}>
                      <span>{s.aSeed ? `#${s.aSeed} ` : ""}{s.aName}</span>
                      <span className="score">{s.scoreA ?? "—"}</span>
                    </div>
                    <div className={`bracket-team${s.winner === "B" ? " win" : ""}`}>
                      <span>{s.bSeed ? `#${s.bSeed} ` : ""}{s.bName}</span>
                      <span className="score">{s.scoreB ?? "—"}</span>
                    </div>
                  </div>
                ))}
              </div>
            ))}
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
          <div className="bracket-title flex items-center gap-2"><Trophy className="size-4" /> {run.champion}</div>
          <div className="bracket">
            {run.rounds.map((r) => (
              <div className="bracket-round" key={r.round}>
                <div className="bracket-label">{r.label}</div>
                <div className="bracket-match">
                  <div className="bracket-team win">
                    <span>{run.champion}</span>
                    <span className="score">{r.champScore}</span>
                  </div>
                  <div className="bracket-team">
                    <span>{r.opponent ?? "—"}</span>
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
                <tr key={q.seed}><td className="rank">{q.seed}</td><td>{q.name}</td><td className="sub">{q.conference}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
        {picture.quarterfinals.length > 0 && (
          <div className="card">
            <div className="bracket-title">Projected first round</div>
            <ul className="list-none p-0" style={{ margin: 0 }}>
              {picture.quarterfinals.map((m, i) => (
                <li key={i} className="py-0.5">{m.a} <span className="muted">vs</span> {m.b}</li>
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
