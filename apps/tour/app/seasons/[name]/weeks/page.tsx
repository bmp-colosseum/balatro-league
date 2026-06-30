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
                  <strong><Link href={`/players/${m.playerId}`}>{m.player}</Link></strong> → <Link href={`/teams/${m.teamSeasonId}`}>{m.team}</Link>
                  {!m.drafted && <span style={{ color: "var(--accent-2)" }}> · sub</span>}
                </span>
              ))}
            </p>
          )}

          <div className="grid gap-x-6 gap-y-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}>
            {wk.matchups.map((mu, i) => (
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
      ))}
    </main>
  );
}
