import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Users } from "lucide-react";
import { prisma } from "@/lib/db";
import { getSeasonLeaders } from "@/lib/stats";

export const dynamic = "force-dynamic";

const pct = (w: number, l: number) => (w + l ? `${((100 * w) / (w + l)).toFixed(1)}%` : "—");

export default async function SeasonPlayers({ params }: { params: Promise<{ name: string }> }) {
  const name = decodeURIComponent((await params).name);
  const enc = encodeURIComponent(name);
  const season = await prisma.tourSeason.findUnique({ where: { name }, select: { id: true } });
  if (!season) notFound();
  // All players with at least one regular-season set, ranked by set win %.
  const players = await getSeasonLeaders(name, 1000, 1);

  return (
    <main>
      <p>
        <Link href={`/seasons/${enc}`} className="inline-flex items-center gap-1"><ArrowLeft className="size-3.5" /> {name}</Link>
      </p>
      <h1 className="flex items-center gap-2"><Users className="size-5 text-[var(--accent)]" /> Player rankings</h1>
      <p className="sub">Every player&apos;s regular-season record, ranked by set win %. Set = a 1v1 within a matchup; games are the individual game wins inside those sets.</p>

      {players.length === 0 ? (
        <div className="card"><p className="sub">No per-player stats for this season.</p></div>
      ) : (
        <div className="card" style={{ overflowX: "auto" }}>
          <table>
            <thead>
              <tr>
                <th className="rank">#</th>
                <th>Player</th>
                <th className="num">Sets</th>
                <th className="num">Set %</th>
                <th className="num">Games</th>
                <th className="num">Game %</th>
              </tr>
            </thead>
            <tbody>
              {players.map((p, i) => (
                <tr key={p.playerId}>
                  <td className="rank">{i + 1}</td>
                  <td><Link href={`/players/${p.playerId}`}>{p.name}</Link></td>
                  <td className="num">{p.setW}–{p.setL}</td>
                  <td className="num">{pct(p.setW, p.setL)}</td>
                  <td className="num">{p.gameW}–{p.gameL}</td>
                  <td className="num">{pct(p.gameW, p.gameL)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
