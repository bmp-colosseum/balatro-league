import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ArrowRightLeft } from "lucide-react";
import { prisma } from "@/lib/db";
import { getSeasonWeeks } from "@/lib/season-weeks";

export const dynamic = "force-dynamic";

export default async function SeasonWeeks({ params }: { params: Promise<{ name: string }> }) {
  const name = decodeURIComponent((await params).name);
  const season = await prisma.tourSeason.findUnique({ where: { name }, select: { id: true } });
  if (!season) notFound();
  const weeks = await getSeasonWeeks(name);

  return (
    <main>
      <p>
        <Link href={`/seasons/${encodeURIComponent(name)}`} className="inline-flex items-center gap-1"><ArrowLeft className="size-3.5" /> {name}</Link>
      </p>
      <h1>{name} — week by week</h1>
      <p className="sub">Each week&apos;s team matchups + the player sets within them, plus mid-season roster moves (a player&apos;s first appearance after the opening week).</p>

      {weeks.length === 0 && <p className="sub mt-3">No week-by-week results for this season.</p>}

      {weeks.map((wk) => (
        <div key={wk.week} className="card mt-3">
          <div className="bracket-title">Week {wk.week}</div>

          {wk.moves.length > 0 && (
            <p className="sub px-0.5 mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="inline-flex items-center gap-1"><ArrowRightLeft className="size-3.5" /> Roster moves:</span>
              {wk.moves.map((m, i) => (
                <span key={i}>
                  <strong>{m.player}</strong> → {m.team}
                  {!m.drafted && <span style={{ color: "var(--accent-2)" }}> · sub</span>}
                </span>
              ))}
            </p>
          )}

          <div className="grid gap-x-6 gap-y-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}>
            {wk.matchups.map((mu, i) => (
              <div key={i}>
                <div className="flex items-baseline justify-between font-semibold">
                  <span>{mu.teamA}</span>
                  <span className="num">{mu.setsA}–{mu.setsB}</span>
                  <span>{mu.teamB}</span>
                </div>
                <table style={{ marginTop: 4 }}>
                  <tbody>
                    {mu.sets.map((s, j) => (
                      <tr key={j}>
                        <td>{s.playerA}</td>
                        <td className="num" style={{ width: 48, textAlign: "center", color: s.scoreA > s.scoreB ? "var(--success)" : undefined }}>{s.scoreA}–{s.scoreB}</td>
                        <td style={{ textAlign: "right" }}>{s.playerB}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        </div>
      ))}
    </main>
  );
}
