import Link from "next/link";
import { Trophy, ArrowLeft, Award } from "lucide-react";
import { StandingsTable } from "@/components/StandingsTable";
import { getSeasonStandings } from "@/lib/standings";
import { getChampionRun } from "@/lib/playoffs";
import { getSeasonLeaders } from "@/lib/stats";
import { getSeasonAwards } from "@/lib/awards";
import { canSeeDiscordIds } from "@/lib/discord-id";
import { DiscordIdTag } from "@/components/DiscordIdTag";

export const dynamic = "force-dynamic";

const pctOf = (w: number, l: number) => (w + l ? `${((100 * w) / (w + l)).toFixed(1)}%` : "—");

export default async function SeasonPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const seasonName = decodeURIComponent(name);
  const [data, run, leaders, awards, showIds] = await Promise.all([
    getSeasonStandings(seasonName),
    getChampionRun(seasonName),
    getSeasonLeaders(seasonName),
    getSeasonAwards(seasonName),
    canSeeDiscordIds(),
  ]);
  const mvp = awards.find((a) => a.kind === "MVP");
  const mvpR = mvp?.recipients[0] ?? null;

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
      <p className="sub">Standings from {data.setCount} sets. Ties broken by matchup %, then set %, then game %.</p>
      {mvpR && mvpR.player && (
        <p className="flex items-center gap-1.5">
          <Award className="size-4 text-[var(--accent)]" />
          <span className="muted">Season MVP:</span>{" "}
          {mvpR.playerId ? <Link href={`/players/${mvpR.playerId}`}>{mvpR.player}</Link> : <span>{mvpR.player}</span>}
          {mvpR.team && <span className="muted">- {mvpR.team}</span>}
        </p>
      )}
      {awards.length > 0 && (
        <div className="card">
          <div className="bracket-title flex items-center gap-2"><Award className="size-4" /> Awards</div>
          <div className="flex flex-col gap-3">
            {awards.map((a) => (
              <div key={a.id}>
                <div className="font-semibold">{a.label}</div>
                {a.description && <div className="sub" style={{ marginTop: 2 }}>{a.description}</div>}
                <div className="mt-1 flex flex-wrap gap-2">
                  {a.recipients.length === 0 && <span className="sub">To be announced.</span>}
                  {a.recipients.map((r, i) => (
                    <span key={r.id ?? i} className="badge inline-flex items-center gap-1">
                      {r.playerId ? <Link href={`/players/${r.playerId}`}>{r.player}</Link> : (r.team ?? r.player ?? "-")}
                      {r.note ? <span className="muted">({r.note})</span> : null}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      {run && (
        <div className="card">
          <div className="bracket-title flex items-center gap-2"><Trophy className="size-4" /> Championship Run — <Link href={`/teams/${run.championTeamSeasonId}`}>{run.champion}</Link></div>
          <div className="bracket">
            {run.rounds.map((r) => (
              <div className="bracket-round" key={r.round}>
                <div className="bracket-label">{r.label}</div>
                <div className="bracket-matches">
                  <div className="bracket-match">
                    <div className="bm-card">
                      <div className="bracket-team win">
                        <span className="nm"><Link href={`/teams/${run.championTeamSeasonId}`}>{run.champion}</Link></span>
                        <span className="score">{r.champScore}</span>
                      </div>
                      <div className="bracket-team">
                        <span className="nm">{r.opponentTeamSeasonId ? <Link href={`/teams/${r.opponentTeamSeasonId}`}>{r.opponent}</Link> : (r.opponent ?? "—")}</span>
                        <span className="score">{r.oppScore}</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            ))}
            <div className="bracket-round">
              <div className="bracket-label">Champion</div>
              <div className="bracket-matches">
                <div className="bracket-match">
                  <div className="bracket-champion flex items-center gap-1.5"><Trophy className="size-4" /> <Link href={`/teams/${run.championTeamSeasonId}`}>{run.champion}</Link></div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
      {data.groups.map((g) => (
        <div className="card" key={g.conferenceId}>
          {data.groups.length > 1 && (
            <div className="bracket-title">
              <Link href={`/seasons/${encodeURIComponent(seasonName)}/conf/${g.conferenceId}`} className="hover:underline">
                {/conference$/i.test(g.conferenceName.trim()) ? g.conferenceName : `${g.conferenceName} Conference`}
              </Link>
            </div>
          )}
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
                      <DiscordIdTag discordId={p.discordId} show={showIds} />
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
