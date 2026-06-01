import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { loadDivisionStandings } from "@/lib/standings-cache";
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
              members: { select: { playerId: true, status: true } },
            },
          },
        },
      },
    },
  });

  // Prefer the materialized standings cache for each division — falls
  // back to live computation transparently for cold-cache divisions,
  // which also warms them up for next time. Loaded in parallel so
  // total wait time = slowest single division, not sum.
  const standingsByDivisionId = new Map<string, Awaited<ReturnType<typeof loadDivisionStandings>>>();
  if (season) {
    const allDivIds = season.tiers.flatMap((t) => t.divisions.map((d) => d.id));
    const results = await Promise.all(
      allDivIds.map(async (id) => [id, await loadDivisionStandings(id)] as const),
    );
    for (const [id, rows] of results) standingsByDivisionId.set(id, rows);
  }

  // Latest BMP MMR snapshot per player in this season (any season really —
  // pick the freshest captured row for each playerId). Empty map if there
  // are no snapshots yet; rows render '—' in that case.
  const allPlayerIds = season?.tiers.flatMap((t) =>
    t.divisions.flatMap((d) => d.members.map((m) => m.playerId)),
  ) ?? [];
  const latestSnapshots = allPlayerIds.length === 0 ? [] : await prisma.playerMmrSnapshot.findMany({
    where: { playerId: { in: allPlayerIds } },
    orderBy: { capturedAt: "desc" },
    distinct: ["playerId"],
  });
  const mmrByPlayerId = new Map(
    latestSnapshots.filter((s) => s.playerId && s.rankedMmr != null).map((s) => [s.playerId!, s.rankedMmr!] as const),
  );

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
                    const rows = (standingsByDivisionId.get(div.id) ?? []).map((r) => ({
                      ...r,
                      dropped: droppedIds.has(r.player.id),
                    }));
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
                              <th title="BMP Ranked MMR from balatromp.com">BMP MMR</th>
                            </tr>
                          </thead>
                          <tbody>
                            {rows.length === 0 ? (
                              <tr>
                                <td colSpan={6} className="muted">No sets played yet.</td>
                              </tr>
                            ) : (
                              rows.map((r, i) => {
                                const medal = i < 3 ? ["🥇", "🥈", "🥉"][i] : `${i + 1}.`;
                                const link = (
                                  <Link href={`/profile/${r.player.id}`} style={{ color: "var(--text)" }}>
                                    {r.player.displayName}
                                  </Link>
                                );
                                const mmr = mmrByPlayerId.get(r.player.id);
                                return (
                                  <tr key={r.player.id}>
                                    <td>{medal}</td>
                                    <td>{r.dropped ? <s>{link}</s> : link}</td>
                                    <td><strong>{r.points}</strong></td>
                                    <td>{r.wins}-{r.draws}-{r.losses}</td>
                                    <td>{r.gamesWon}-{r.gamesLost}</td>
                                    <td>{mmr != null ? mmr : <span className="muted">—</span>}</td>
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
