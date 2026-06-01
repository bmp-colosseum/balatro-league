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
              // Count CONFIRMED pairings so the division card can render
              // a 'X/Y sets played' pill and a ✅ when the round-robin
              // is complete. Cheap — Prisma _count is a single query.
              _count: { select: { pairings: { where: { status: "CONFIRMED" } } } },
            },
          },
        },
      },
    },
  });

  // Min/max tier position so up/down arrows only render where they
  // actually mean something: no ↑ on Legendary (already top), no ↓
  // on Common (already bottom).
  const tierPositions = season?.tiers.map((t) => t.position) ?? [];
  const minTierPos = tierPositions.length > 0 ? Math.min(...tierPositions) : 0;
  const maxTierPos = tierPositions.length > 0 ? Math.max(...tierPositions) : 0;

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
            {season.tiers.filter((t) => t.divisions.length > 0).map((tier) => {
              const isTopTier = tier.position === minTierPos;
              const isBottomTier = tier.position === maxTierPos;
              return (
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
                    // Expected sets = N*(N-1)/2 across active members; the
                    // division is "done" when confirmed = expected. Shows
                    // as a pill + ✅ on the card header.
                    const activeCount = div.members.filter((m) => m.status === "ACTIVE").length;
                    const expectedSets = activeCount < 2 ? 0 : (activeCount * (activeCount - 1)) / 2;
                    const playedSets = div._count.pairings;
                    const complete = expectedSets > 0 && playedSets >= expectedSets;
                    // Highlight promo/relegation positions in the rendered
                    // standings. Top non-bottom: position 1 promotes. Bottom
                    // non-top: last position relegates. Edge tiers don't
                    // render the arrow since there's nowhere to go.
                    void tierColors;
                    return (
                      <div key={div.id} className="card">
                        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                          <strong>
                            <Link href={`/divisions/${div.id}`} style={{ textDecoration: "none" }}>{div.name}</Link>
                          </strong>
                          <span
                            className="pill"
                            style={{
                              background: complete ? "rgba(46,204,113,0.15)" : "rgba(149,165,166,0.15)",
                              color: complete ? "#2ecc71" : "#95a5a6",
                              fontSize: 11,
                              marginLeft: "auto",
                            }}
                            title={complete ? "All sets played" : "Round-robin in progress"}
                          >
                            {complete ? "✅" : ""} {playedSets}/{expectedSets} sets
                          </span>
                        </div>
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
                                // ↑ for promotion position (#1, unless top tier).
                                // ↓ for relegation position (last, unless bottom tier).
                                const isPromoting = i === 0 && !isTopTier;
                                const isRelegating = i === rows.length - 1 && !isBottomTier && rows.length > 1;
                                const movementMarker = isPromoting ? (
                                  <span title="Promotion position" style={{ color: "#2ecc71" }}>↑</span>
                                ) : isRelegating ? (
                                  <span title="Relegation position" style={{ color: "#e74c3c" }}>↓</span>
                                ) : null;
                                // tiedWithPrev means this row and the one above are
                                // structurally tied AND no shootout has been recorded
                                // between them. Visible nudge to play+report a shootout.
                                const shootoutMarker = r.tiedWithPrev ? (
                                  <span
                                    title="Tied with the row above — play a shootout and /report-shootout"
                                    style={{ color: "#f1c40f", marginLeft: 4 }}
                                  >
                                    ⚔
                                  </span>
                                ) : null;
                                return (
                                  <tr key={r.player.id}>
                                    <td>{medal}{movementMarker && <> {movementMarker}</>}{shootoutMarker}</td>
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
              );
            })}
          </>
        )}
      </main>
    </>
  );
}
