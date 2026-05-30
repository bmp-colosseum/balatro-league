import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { computeStandings } from "@/lib/standings";
import { tierColors } from "@/lib/tier-colors";
import { SiteNav } from "@/components/SiteNav";

export const dynamic = "force-dynamic"; // Always fresh — DB writes happen out-of-band via the bot

export default async function StandingsPage() {
  const season = await prisma.season.findFirst({
    where: { isActive: true, visibility: "PUBLIC" },
    include: {
      tiers: {
        orderBy: { position: "asc" },
        include: {
          divisions: {
            orderBy: { groupNumber: "asc" },
            include: {
              members: { include: { player: true } },
              pairings: {
                where: { status: "CONFIRMED" },
                select: { playerAId: true, playerBId: true, gamesWonA: true, gamesWonB: true },
              },
            },
          },
        },
      },
    },
  });

  return (
    <>
      <SiteNav activePath="/standings" />
      <main>
        {!season ? (
          <>
            <h2>Standings</h2>
            <div className="card muted">No active season right now.</div>
          </>
        ) : (
          <>
            <h2>{season.name} — Standings</h2>
            {season.tiers.filter((t) => t.divisions.length > 0).map((tier) => (
              <section key={tier.id} style={{ marginTop: 24 }}>
                <h3>{tier.name}</h3>
                <div className="grid grid-2">
                  {tier.divisions.map((div) => {
                    const droppedIds = new Set(
                      div.members.filter((m) => m.status === "DROPPED").map((m) => m.playerId),
                    );
                    const rows = computeStandings(
                      div.members.map((m) => m.player),
                      div.pairings,
                    ).map((r) => ({ ...r, dropped: droppedIds.has(r.player.id) }));
                    void tierColors;
                    return (
                      <div key={div.id} className="card">
                        <strong>
                          <Link href={`/divisions/${div.id}`} style={{ textDecoration: "none" }}>{div.name}</Link>
                        </strong>
                        <table style={{ marginTop: 8 }}>
                          <thead>
                            <tr>
                              <th></th>
                              <th>Player</th>
                              <th>Pts</th>
                              <th>W-D-L</th>
                              <th>Games</th>
                            </tr>
                          </thead>
                          <tbody>
                            {rows.length === 0 ? (
                              <tr>
                                <td colSpan={5} className="muted">No sets played yet.</td>
                              </tr>
                            ) : (
                              rows.map((r, i) => {
                                const medal = i < 3 ? ["🥇", "🥈", "🥉"][i] : `${i + 1}.`;
                                const link = (
                                  <Link href={`/profile/${r.player.id}`} style={{ color: "var(--text)" }}>
                                    {r.player.displayName}
                                  </Link>
                                );
                                return (
                                  <tr key={r.player.id}>
                                    <td>{medal}</td>
                                    <td>{r.dropped ? <s>{link}</s> : link}</td>
                                    <td><strong>{r.points}</strong></td>
                                    <td>{r.wins}-{r.draws}-{r.losses}</td>
                                    <td>{r.gamesWon}-{r.gamesLost}</td>
                                  </tr>
                                );
                              })
                            )}
                          </tbody>
                        </table>
                      </div>
                    );
                  })}
                </div>
              </section>
            ))}
          </>
        )}
      </main>
    </>
  );
}
