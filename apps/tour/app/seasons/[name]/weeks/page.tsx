import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ArrowRightLeft } from "lucide-react";
import { prisma } from "@/lib/db";
import { getSeasonWeeks, type WeekMatchup } from "@/lib/season-weeks";

export const dynamic = "force-dynamic";

// A player's seed in a set, with an arrow when they played off-seed (the +-2 rule):
// up = faced a better (lower-numbered) seed, down = faced a worse one.
function SeedTag({ self, opp }: { self: number | null; opp: number | null }) {
  if (self == null) return null;
  const diff = opp == null ? 0 : self - opp;
  const arrow = diff > 0 ? `↑${diff}` : diff < 0 ? `↓${-diff}` : "";
  return (
    <span className="num" style={{ fontSize: "0.85em" }}>
      <span className="muted">{self}</span>
      {arrow && <span style={{ color: diff > 0 ? "var(--accent-2)" : "var(--muted)", marginLeft: 2 }}>{arrow}</span>}
    </span>
  );
}

function MatchCard({ mu, showConf }: { mu: WeekMatchup; showConf: boolean }) {
  const aWon = mu.setsA > mu.setsB;
  const bWon = mu.setsB > mu.setsA;
  return (
    <details className="wk-match">
      <summary className="bm-card">
        <div className={`bracket-team${aWon ? " win" : ""}`}>
          <span className="nm">{mu.teamA}</span>
          {showConf && mu.confA && <span className="sub" style={{ fontSize: "0.75em", flex: "none" }}>{mu.confA}</span>}
          <span className="score">{mu.setsA}</span>
        </div>
        <div className={`bracket-team${bWon ? " win" : ""}`}>
          <span className="nm">{mu.teamB}</span>
          {showConf && mu.confB && <span className="sub" style={{ fontSize: "0.75em", flex: "none" }}>{mu.confB}</span>}
          <span className="score">{mu.setsB}</span>
        </div>
      </summary>
      <div className="wk-sets">
        <div className="flex items-baseline justify-between px-1 pb-1 text-[0.8em]">
          <Link href={`/teams/${mu.teamAId}`}>{mu.teamA}</Link>
          <span className="muted">vs</span>
          <Link href={`/teams/${mu.teamBId}`}>{mu.teamB}</Link>
        </div>
        <table>
          <tbody>
            {mu.sets.map((s, j) => (
              <tr key={j}>
                <td className="num" style={{ width: 34 }}><SeedTag self={s.seedA} opp={s.seedB} /></td>
                <td><Link href={`/players/${s.playerAId}`}>{s.playerA}</Link></td>
                <td className="num" style={{ width: 48, textAlign: "center", color: s.scoreA > s.scoreB ? "var(--success)" : undefined }}>{s.scoreA}–{s.scoreB}</td>
                <td style={{ textAlign: "right" }}><Link href={`/players/${s.playerBId}`}>{s.playerB}</Link></td>
                <td className="num" style={{ width: 34, textAlign: "right" }}><SeedTag self={s.seedB} opp={s.seedA} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

export default async function SeasonWeeks({ params, searchParams }: { params: Promise<{ name: string }>; searchParams: Promise<{ week?: string }> }) {
  const name = decodeURIComponent((await params).name);
  const enc = encodeURIComponent(name);
  const season = await prisma.tourSeason.findUnique({ where: { name }, select: { id: true } });
  if (!season) notFound();
  const weeks = await getSeasonWeeks(name);

  const wanted = Number((await searchParams).week);
  const selected = weeks.some((w) => w.week === wanted) ? wanted : weeks[weeks.length - 1]?.week ?? null;
  const current = weeks.find((w) => w.week === selected);

  // Group a week's matchups by conference (both teams share one), else "Cross-conference".
  const groups = new Map<string, WeekMatchup[]>();
  for (const mu of current?.matchups ?? []) {
    const key = mu.confA && mu.confA === mu.confB ? mu.confA : "Cross-conference";
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(mu);
  }
  const CROSS = "Cross-conference";
  const groupOrder = [...groups.keys()].sort((a, b) => (a === CROSS ? 1 : b === CROSS ? -1 : a.localeCompare(b)));

  return (
    <main>
      <p>
        <Link href={`/seasons/${enc}`} className="inline-flex items-center gap-1"><ArrowLeft className="size-3.5" /> {name}</Link>
      </p>
      <h1>{name} — regular season</h1>
      <p className="sub">Pick a week to see its matchups by conference. Tap a matchup for the player-by-player sets.</p>

      {weeks.length === 0 ? (
        <p className="sub mt-3">No week-by-week results for this season.</p>
      ) : (
        <>
          <div className="wk-tabs">
            {weeks.map((wk) => (
              <Link key={wk.week} href={`/seasons/${enc}/weeks?week=${wk.week}`} className={`wk-tab${wk.week === selected ? " active" : ""}`}>
                Week {wk.week}
              </Link>
            ))}
          </div>

          {current && (
            <>
              {current.moves.length > 0 && (
                <p className="sub mb-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="inline-flex items-center gap-1"><ArrowRightLeft className="size-3.5" /> Roster moves:</span>
                  {current.moves.map((m, i) => (
                    <span key={i}>
                      <strong><Link href={`/players/${m.playerId}`}>{m.player}</Link></strong> → <Link href={`/teams/${m.teamSeasonId}`}>{m.team}</Link>
                      {!m.drafted && <span style={{ color: "var(--accent-2)" }}> · sub</span>}
                    </span>
                  ))}
                </p>
              )}

              {groupOrder.map((g) => (
                <section key={g}>
                  {(groups.size > 1 || g === CROSS) && <div className="wk-conf-head">{g}</div>}
                  <div className="wk-grid">
                    {groups.get(g)!.map((mu, i) => (
                      <MatchCard key={i} mu={mu} showConf={g === CROSS} />
                    ))}
                  </div>
                </section>
              ))}
            </>
          )}
        </>
      )}
    </main>
  );
}
