import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ArrowRightLeft } from "lucide-react";
import { prisma } from "@/lib/db";
import { getSeasonWeeks } from "@/lib/season-weeks";

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

export default async function SeasonWeeks({ params, searchParams }: { params: Promise<{ name: string }>; searchParams: Promise<{ week?: string }> }) {
  const name = decodeURIComponent((await params).name);
  const enc = encodeURIComponent(name);
  const season = await prisma.tourSeason.findUnique({ where: { name }, select: { id: true } });
  if (!season) notFound();
  const weeks = await getSeasonWeeks(name);

  // Show ONE week at a time (a pill selector), not every week stacked -- default to the latest.
  const wanted = Number((await searchParams).week);
  const selected = weeks.some((w) => w.week === wanted) ? wanted : weeks[weeks.length - 1]?.week ?? null;
  const current = weeks.find((w) => w.week === selected);

  return (
    <main>
      <p>
        <Link href={`/seasons/${enc}`} className="inline-flex items-center gap-1"><ArrowLeft className="size-3.5" /> {name}</Link>
      </p>
      <h1>{name} — week by week</h1>
      <p className="sub">Pick a week to see its team matchups, the player sets within them, and any mid-season roster moves.</p>

      {weeks.length === 0 ? (
        <p className="sub mt-3">No week-by-week results for this season.</p>
      ) : (
        <>
          <div className="flex flex-wrap gap-1.5 my-3">
            {weeks.map((wk) => {
              const active = wk.week === selected;
              return (
                <Link
                  key={wk.week}
                  href={`/seasons/${enc}/weeks?week=${wk.week}`}
                  className={`rounded-full border px-3 py-1 text-sm tabular-nums transition-colors ${active ? "border-[var(--accent)] bg-[var(--accent)] font-semibold text-black" : "border-[var(--border)] text-[var(--muted)] hover:border-[var(--accent-2)] hover:text-[var(--text)]"}`}
                >
                  Week {wk.week}
                </Link>
              );
            })}
          </div>

          {current && (
            <div key={current.week} className="card">
              <div className="bracket-title">Week {current.week}</div>

              {current.moves.length > 0 && (
                <p className="sub px-0.5 mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="inline-flex items-center gap-1"><ArrowRightLeft className="size-3.5" /> Roster moves:</span>
                  {current.moves.map((m, i) => (
                    <span key={i}>
                      <strong><Link href={`/players/${m.playerId}`}>{m.player}</Link></strong> → <Link href={`/teams/${m.teamSeasonId}`}>{m.team}</Link>
                      {!m.drafted && <span style={{ color: "var(--accent-2)" }}> · sub</span>}
                    </span>
                  ))}
                </p>
              )}

              <div className="grid gap-x-6 gap-y-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}>
                {current.matchups.map((mu, i) => (
                  <div key={i}>
                    <div className="flex items-baseline justify-between font-semibold">
                      <span><Link href={`/teams/${mu.teamAId}`}>{mu.teamA}</Link></span>
                      <span className="num">{mu.setsA}–{mu.setsB}</span>
                      <span><Link href={`/teams/${mu.teamBId}`}>{mu.teamB}</Link></span>
                    </div>
                    <table style={{ marginTop: 4 }}>
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
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </main>
  );
}
