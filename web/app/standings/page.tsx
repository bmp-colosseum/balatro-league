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
              // a 'X/Y matches played' pill and a ✅ when the round-robin
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
                    // Expected matches = N*(N-1)/2 across active members; the
                    // division is "done" when confirmed = expected. Shows
                    // as a pill + ✅ on the card header.
                    const activeCount = div.members.filter((m) => m.status === "ACTIVE").length;
                    const expectedMatches = activeCount < 2 ? 0 : (activeCount * (activeCount - 1)) / 2;
                    const playedMatches = div._count.pairings;
                    const complete = expectedMatches > 0 && playedMatches >= expectedMatches;
                    // Group rows into tie chains. A new chain starts at any
                    // row NOT flagged tiedWithPrev (the natural break point).
                    // Then mark every row whose chain straddles the promo
                    // boundary (index 0) or relegation boundary (last index)
                    // — both/all players in the chain need to play shootouts.
                    const chains: number[][] = [];
                    {
                      let current: number[] = [];
                      for (let i = 0; i < rows.length; i++) {
                        if (i === 0 || !rows[i]!.tiedWithPrev) {
                          if (current.length > 0) chains.push(current);
                          current = [i];
                        } else {
                          current.push(i);
                        }
                      }
                      if (current.length > 0) chains.push(current);
                    }
                    // Shootout marker is TIER-INDEPENDENT — even a top-tier #1
                    // tie needs resolving (someone has to be champion), and
                    // even a bottom-tier last-place tie matters for "who
                    // finished dead last". Arrows still respect tier below.
                    const promoTieRowSet = new Set<number>();
                    const relegationTieRowSet = new Set<number>();
                    for (const chain of chains) {
                      if (chain.length < 2) continue; // not a tie chain
                      if (chain.includes(0)) {
                        for (const idx of chain) promoTieRowSet.add(idx);
                      }
                      if (chain.includes(rows.length - 1)) {
                        for (const idx of chain) relegationTieRowSet.add(idx);
                      }
                    }
                    // Highlight promo/relegation positions. Top non-bottom:
                    // position 1 promotes. Bottom non-top: last position
                    // relegates. Edge tiers and tied boundaries don't get
                    // arrows because the outcome isn't decided yet.
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
                            title={complete ? "All matches played" : "Round-robin in progress"}
                          >
                            {complete ? "✅" : ""} {playedMatches}/{expectedMatches} matches
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
                              <th title="Each player's current Ranked MMR from balatromp.com — separate from your league ranking. Click a player to see their full BMP history.">BMP Rating</th>
                            </tr>
                          </thead>
                          <tbody>
                            {rows.length === 0 ? (
                              <tr>
                                <td colSpan={6} className="muted">No matches played yet.</td>
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
                                // Arrows hide on tied boundaries — the chain's outcome
                                // isn't decided until a shootout resolves it.
                                const isPromoting = complete && i === 0 && !isTopTier && !promoTieRowSet.has(0);
                                const isRelegating =
                                  complete && i === rows.length - 1 && !isBottomTier && rows.length > 1 &&
                                  !relegationTieRowSet.has(rows.length - 1);
                                const movementMarker = isPromoting ? (
                                  <span title="Promotion position" style={{ color: "#2ecc71" }}>↑</span>
                                ) : isRelegating ? (
                                  <span title="Relegation position" style={{ color: "#e74c3c" }}>↓</span>
                                ) : null;
                                // ⚔ on EVERY row in a boundary tie chain — both (or all
                                // 3+) tied players need to play shootouts to resolve the
                                // promo/relegation slot.
                                const shootoutNeeded =
                                  complete && (promoTieRowSet.has(i) || relegationTieRowSet.has(i));
                                const shootoutMarker = shootoutNeeded ? (
                                  <span
                                    title="Tied for promotion/relegation — play a shootout and /report-shootout"
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
