import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { StandingsTable } from "@/components/StandingsTable";
import { getSeasonStandings } from "@/lib/standings";
import { getSeasonLeaders } from "@/lib/stats";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

const pct = (w: number, l: number) => (w + l ? `${((100 * w) / (w + l)).toFixed(1)}%` : "—");

export default async function ConferencePage({ params }: { params: Promise<{ name: string; conf: string }> }) {
  const { name, conf } = await params;
  const seasonName = decodeURIComponent(name);
  const enc = encodeURIComponent(seasonName);

  const data = await getSeasonStandings(seasonName);
  const group = data?.groups.find((g) => g.conferenceId === conf);

  if (!data || !group) {
    return (
      <main>
        <p><Link href={`/seasons/${enc}`} className="inline-flex items-center gap-1"><ArrowLeft className="size-3.5" /> {seasonName}</Link></p>
        <h1>Conference not found</h1>
      </main>
    );
  }

  const label = /conference$/i.test(group.conferenceName.trim()) ? group.conferenceName : `${group.conferenceName} Conference`;

  // Leaders scoped to this conference (players on its teams).
  const teamSeasonIds = group.rows.map((r) => r.teamSeasonId);
  const [entries, leaders] = await Promise.all([
    prisma.rosterEntry.findMany({ where: { roster: { teamSeasonId: { in: teamSeasonIds } } }, select: { playerId: true } }),
    getSeasonLeaders(seasonName),
  ]);
  const confPlayers = new Set(entries.map((e) => e.playerId));
  const confLeaders = leaders.filter((p) => confPlayers.has(p.playerId)).slice(0, 15);

  return (
    <main>
      <p><Link href={`/seasons/${enc}`} className="inline-flex items-center gap-1"><ArrowLeft className="size-3.5" /> {seasonName}</Link></p>
      <h1>{label}</h1>
      <p className="sub">{seasonName} · {group.rows.length} teams</p>

      <div className="card">
        <StandingsTable rows={group.rows} />
      </div>

      {confLeaders.length > 0 && (
        <>
          <h2 style={{ fontSize: "1.1rem", margin: "1.5rem 0 0.5rem" }}>Conference leaders</h2>
          <div className="card">
            <table>
              <thead>
                <tr><th className="rank">#</th><th>Player</th><th className="num">Sets</th><th className="num">Set %</th><th className="num">Games</th></tr>
              </thead>
              <tbody>
                {confLeaders.map((p, i) => (
                  <tr key={p.playerId}>
                    <td className="rank">{i + 1}</td>
                    <td><Link href={`/players/${p.playerId}`}>{p.name}</Link></td>
                    <td className="num">{p.setW}–{p.setL}</td>
                    <td className="num">{pct(p.setW, p.setL)}</td>
                    <td className="num">{p.gameW}–{p.gameL}</td>
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
