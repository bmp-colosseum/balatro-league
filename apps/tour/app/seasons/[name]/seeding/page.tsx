import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ListOrdered } from "lucide-react";
import { getOverallSeeding } from "@/lib/standings";

export const dynamic = "force-dynamic";

const pct = (w: number, l: number) => (w + l ? `${((100 * w) / (w + l)).toFixed(1)}%` : "—");

export default async function SeasonSeeding({ params }: { params: Promise<{ name: string }> }) {
  const name = decodeURIComponent((await params).name);
  const enc = encodeURIComponent(name);
  const seeding = await getOverallSeeding(name);
  if (!seeding) notFound();

  return (
    <main>
      <p>
        <Link href={`/seasons/${enc}`} className="inline-flex items-center gap-1"><ArrowLeft className="size-3.5" /> {name}</Link>
      </p>
      <h1 className="flex items-center gap-2"><ListOrdered className="size-5 text-[var(--accent)]" /> Overall seeding</h1>
      <p className="sub">
        Every team ranked across all conferences by the playoff tiebreakers — matchup %, then set %, then game %.
        This is the order that drives the playoff seeding and the seeded week (#1 vs #last).
      </p>

      {seeding.rows.length === 0 ? (
        <div className="card"><p className="sub">No standings yet this season.</p></div>
      ) : (
        <div className="card" style={{ overflowX: "auto" }}>
          <table>
            <thead>
              <tr>
                <th className="rank">#</th>
                <th>Team</th>
                <th>Conference</th>
                <th className="num">Matchups</th>
                <th className="num">M %</th>
                <th className="num">Sets</th>
                <th className="num">Set %</th>
                <th className="num">Games</th>
                <th className="num">Game %</th>
              </tr>
            </thead>
            <tbody>
              {seeding.rows.map((r) => (
                <tr key={r.teamSeasonId}>
                  <td className="rank">{r.seed}</td>
                  <td><Link href={`/teams/${r.teamSeasonId}`}>{r.name}</Link></td>
                  <td className="sub">{r.conferenceName}</td>
                  <td className="num">{r.matchupsW}–{r.matchupsL}</td>
                  <td className="num">{pct(r.matchupsW, r.matchupsL)}</td>
                  <td className="num">{r.setsW}–{r.setsL}</td>
                  <td className="num">{pct(r.setsW, r.setsL)}</td>
                  <td className="num">{r.gamesW}–{r.gamesL}</td>
                  <td className="num">{pct(r.gamesW, r.gamesL)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
