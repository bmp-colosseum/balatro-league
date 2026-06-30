import Link from "next/link";
import { Trophy, ArrowLeft, Award } from "lucide-react";
import { StandingsTable } from "@/components/StandingsTable";
import { getSeasonStandings } from "@/lib/standings";
import { getChampionRun } from "@/lib/playoffs";
import { getPlayoffPicture } from "@/lib/playoff-picture";
import { getSeasonLeaders } from "@/lib/stats";
import { getSeasonAwards } from "@/lib/awards";

export const dynamic = "force-dynamic";

const pctOf = (w: number, l: number) => (w + l ? `${((100 * w) / (w + l)).toFixed(1)}%` : "—");

export default async function SeasonPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const seasonName = decodeURIComponent(name);
  const [data, run, picture, leaders, awards] = await Promise.all([
    getSeasonStandings(seasonName),
    getChampionRun(seasonName),
    getPlayoffPicture(seasonName),
    getSeasonLeaders(seasonName),
    getSeasonAwards(seasonName),
  ]);
  const mvp = awards.find((a) => a.kind === "MVP");

  if (!data) {
    return (
      <main>
        <p>
          <Link href="/" className="inline-flex items-center gap-1"><ArrowLeft className="size-3.5" /> seasons</Link>
        </p>
        <h1>Season not found</h1>
      </main>
    );
  }

  return (
    <main>
      <p>
        <Link href="/">← seasons</Link>
      </p>
      <h1>{data.seasonName}</h1>
      <p className="sub">
        Standings derived from {data.setCount} sets · §5 tiebreakers ·{" "}
        <Link href={`/seasons/${encodeURIComponent(seasonName)}/weeks`}>Week by week →</Link> ·{" "}
        <Link href={`/seasons/${encodeURIComponent(seasonName)}/draft`}>Draft board →</Link> ·{" "}
        <Link href={`/seasons/${encodeURIComponent(seasonName)}/timeline`}>Season timeline →</Link> ·{" "}
        <Link href={`/seasons/${encodeURIComponent(seasonName)}/bracket`}>Playoff bracket →</Link>
      </p>
      {mvp && mvp.player && (
        <p className="flex items-center gap-1.5">
          <Award className="size-4 text-[var(--accent)]" />
          <span className="muted">Season MVP:</span>{" "}
          {mvp.playerId ? <Link href={`/players/${mvp.playerId}`}>{mvp.player}</Link> : <span>{mvp.player}</span>}
          {mvp.team && <span className="muted">· {mvp.team}</span>}
        </p>
      )}
      {run && (
        <div className="card">
          <div className="bracket-title flex items-center gap-2"><Trophy className="size-4" /> Championship Run — <Link href={`/teams/${run.championTeamSeasonId}`}>{run.champion}</Link></div>
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
            <div className="bracket-round">
              <div className="bracket-label">Champion</div>
              <div className="bracket-champion flex items-center justify-center gap-1.5"><Trophy className="size-4" /> <Link href={`/teams/${run.championTeamSeasonId}`}>{run.champion}</Link></div>
            </div>
          </div>
        </div>
      )}
      {!run && picture && picture.quarterfinals.length > 0 && (
        <div className="card">
          <div className="bracket-title">
            Projected playoffs — top {picture.perGroup} per conference
          </div>
          <div className="bracket">
            <div className="bracket-round">
              <div className="bracket-label">Quarterfinals</div>
              {picture.quarterfinals.map((qf, i) => (
                <div className="bracket-match" key={i}>
                  <div className="bracket-team">
                    <span><Link href={`/teams/${qf.aTeamSeasonId}`}>{qf.a}</Link></span>
                  </div>
                  <div className="bracket-team">
                    <span><Link href={`/teams/${qf.bTeamSeasonId}`}>{qf.b}</Link></span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {data.groups.map((g) => (
        <div className="card" key={g.conferenceId}>
          {data.groups.length > 1 && <div className="bracket-title">{g.conferenceName} Conference</div>}
          <StandingsTable rows={g.rows} />
        </div>
      ))}

      {leaders.length > 0 && (
        <>
          <h2 style={{ fontSize: "1.1rem", margin: "1.5rem 0 0.5rem" }}>Season leaders</h2>
          <div className="card">
            <table>
              <thead>
                <tr>
                  <th className="rank">#</th>
                  <th>Player</th>
                  <th className="num">Sets</th>
                  <th className="num">Set %</th>
                  <th className="num">Games</th>
                </tr>
              </thead>
              <tbody>
                {leaders.map((p, i) => (
                  <tr key={p.playerId}>
                    <td className="rank">{i + 1}</td>
                    <td>
                      <Link href={`/players/${p.playerId}`}>{p.name}</Link>
                    </td>
                    <td className="num">
                      {p.setW}–{p.setL}
                    </td>
                    <td className="num">{pctOf(p.setW, p.setL)}</td>
                    <td className="num">
                      {p.gameW}–{p.gameL}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </main>
  );
}
