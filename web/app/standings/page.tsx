import Link from "next/link";
import { loadStandingsPageData } from "@/lib/loaders/standings";
import { getShowBmpMmr } from "@/lib/preferences";
import { tierColors } from "@/lib/tier-colors";
import { SiteNav } from "@/components/SiteNav";

export const dynamic = "force-dynamic"; // Always fresh — DB writes happen out-of-band via the bot

export default async function StandingsPage() {
  const showBmpMmr = await getShowBmpMmr();
  const data = await loadStandingsPageData({ showBmpMmr });

  return (
    <>
      <SiteNav activePath="/standings" />
      <main>
        {!data.season ? (
          <>
            <h2>Standings</h2>
            <div className="card muted">No active season right now.</div>
          </>
        ) : (
          <>
            <h2>{data.season.name} — Standings</h2>
            {data.tiers.filter((t) => t.divisions.length > 0).map((tier) => {
              const isTopTier = tier.position === data.minTierPosition;
              const isBottomTier = tier.position === data.maxTierPosition;
              return (
                <section key={tier.id} style={{ marginTop: 24 }}>
                  <h3>{tier.name}</h3>
                  <div className="grid grid-2">
                    {tier.divisions.map((div) => {
                      const droppedIds = new Set(div.droppedMemberIds);
                      const rows = div.rows.map((r) => ({
                        ...r,
                        dropped: droppedIds.has(r.player.id),
                      }));
                      const activeCount = div.activeMemberIds.length;
                      const expectedMatches = activeCount < 2 ? 0 : (activeCount * (activeCount - 1)) / 2;
                      const playedMatches = div.playedMatches;
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
                                <th title="League-wide rank (1 = best player in the league). Updated at end of season.">Overall</th>
                                <th>Pts</th>
                                <th>W-D-L</th>
                                <th>Games</th>
                                {showBmpMmr && (
                                  <th title="Each player's current Ranked MMR from balatromp.com — separate from your league ranking. Click a player to see their full BMP history.">BMP MMR</th>
                                )}
                              </tr>
                            </thead>
                            <tbody>
                              {rows.length === 0 ? (
                                <tr>
                                  <td colSpan={showBmpMmr ? 7 : 6} className="muted">No matches played yet.</td>
                                </tr>
                              ) : (
                                rows.map((r, i) => {
                                  const medal = i < 3 ? ["🥇", "🥈", "🥉"][i] : `${i + 1}.`;
                                  const link = (
                                    <Link href={`/profile/${r.player.id}`} style={{ color: "var(--text)" }}>
                                      {r.player.displayName}
                                    </Link>
                                  );
                                  const mmr = data.mmrByPlayerId.get(r.player.id);
                                  const isPromoting = complete && i === 0 && !isTopTier && !promoTieRowSet.has(0);
                                  const isRelegating =
                                    complete && i === rows.length - 1 && !isBottomTier && rows.length > 1 &&
                                    !relegationTieRowSet.has(rows.length - 1);
                                  const movementMarker = isPromoting ? (
                                    <span title="Promotion position" style={{ color: "#2ecc71" }}>↑</span>
                                  ) : isRelegating ? (
                                    <span title="Relegation position" style={{ color: "#e74c3c" }}>↓</span>
                                  ) : null;
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
                                      <td className="muted">{r.player.rating != null ? `#${r.player.rating}` : "—"}</td>
                                      <td><strong>{r.points}</strong></td>
                                      <td>{r.wins}-{r.draws}-{r.losses}</td>
                                      <td>{r.gamesWon}-{r.gamesLost}</td>
                                      {showBmpMmr && (
                                        <td>{mmr != null ? mmr : <span className="muted">—</span>}</td>
                                      )}
                                    </tr>
                                  );
                                })
                              )}
                            </tbody>
                          </table>
                          {div.shootouts.length > 0 && (
                            <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
                              <strong style={{ color: "#f1c40f" }}>⚔ Shootout{div.shootouts.length === 1 ? "" : "s"}:</strong>{" "}
                              {div.shootouts.map((s, i) => (
                                <span key={s.id}>
                                  {i > 0 && " · "}
                                  <strong>{s.winnerName}</strong> beat {s.loserName}
                                </span>
                              ))}
                            </div>
                          )}
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
