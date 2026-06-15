import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { loadStandingsPageData, type StandingsMmrEntry } from "@/lib/loaders/standings";
import { getShowBmpMmr } from "@/lib/preferences";
import { tierColors } from "@/lib/tier-colors";
import { SiteNav } from "@/components/SiteNav";
import { DiscordId } from "@/components/DiscordId";
import { rankLabel, type StandingRow } from "@/lib/standings";

// Pretty-print a BMP season tag like "season6" → "S6". Falls back to
// raw tag for anything that doesn't match (defensive: shouldn't happen
// but the field is technically free-form).
function formatBmpSeason(tag: string | null): string {
  if (!tag) return "—";
  const m = /^season(\d+)$/.exec(tag);
  return m ? `S${m[1]}` : tag;
}

// Render the MMR cell. When the snapshot is from the current BMP
// season, just show the number. When it's from an older season (e.g.
// player hasn't played the current BMP season but we have prior data),
// annotate inline + add a hover so the reader knows it's stale.
function renderMmrCell(entry: StandingsMmrEntry | undefined, currentBmpSeason: string | null) {
  if (!entry) return <span className="muted">—</span>;
  const isStale = currentBmpSeason != null && entry.bmpSeason !== currentBmpSeason;
  if (!isStale) {
    return <span title={`From BMP ${formatBmpSeason(entry.bmpSeason)}`}>{entry.mmr}</span>;
  }
  return (
    <span
      title={`From BMP ${formatBmpSeason(entry.bmpSeason)}, not the current season. May be stale.`}
      style={{ color: "#f1c40f" }}
    >
      {entry.mmr}
      <span className="muted" style={{ fontSize: 10, marginLeft: 4 }}>
        {formatBmpSeason(entry.bmpSeason)}
      </span>
    </span>
  );
}

// Clinch predictor: who is mathematically guaranteed to promote ("up") /
// relegate ("down") regardless of how the remaining matches play out.
// Conservative — flags a player only when it holds even in their WORST
// remaining case while every rival wins out. (That ignores rivals also playing
// each other, which can only help the flagged player, so it never
// false-positives; it just won't flag a borderline case early.) Assumes the
// standard 3/1/0 scoring. Absent from the map = not yet decided.
function computeClinch(
  rows: Array<StandingRow & { dropped?: boolean }>,
  activeCount: number,
  promoteN: number,
  relegateN: number,
): Map<string, "up" | "down"> {
  const MAX_PER_MATCH = 3;
  const result = new Map<string, "up" | "down">();
  const active = rows.filter((r) => !r.dropped);
  const n = active.length;
  if (n === 0) return result;
  const totalGames = Math.max(0, activeCount - 1);
  const info = active.map((r) => {
    const remaining = Math.max(0, totalGames - r.played);
    return { id: r.player.id, floor: r.points, ceil: r.points + MAX_PER_MATCH * remaining };
  });
  for (const me of info) {
    if (promoteN > 0) {
      // Guaranteed top-promoteN if fewer than promoteN rivals can even reach
      // this player's floor.
      const canCatch = info.filter((o) => o.id !== me.id && o.ceil >= me.floor).length;
      if (canCatch < promoteN) {
        result.set(me.id, "up");
        continue;
      }
    }
    if (relegateN > 0) {
      // Locked into the bottom relegateN if enough rivals are guaranteed
      // strictly above even when this player wins out.
      const guaranteedAbove = info.filter((o) => o.id !== me.id && o.floor > me.ceil).length;
      if (guaranteedAbove >= n - relegateN) {
        result.set(me.id, "down");
      }
    }
  }
  return result;
}

export const dynamic = "force-dynamic"; // Always fresh — DB writes happen out-of-band via the bot

// Tooltips so the raw W-D-L / Games cells double as rate views on hover
// without bloating the visible column count.
function standingRateTooltip(r: StandingRow): string {
  if (r.played === 0) return "No matches yet.";
  const win = Math.round((r.wins / r.played) * 100);
  const draw = Math.round((r.draws / r.played) * 100);
  const loss = Math.round((r.losses / r.played) * 100);
  return `${win}% W · ${draw}% D · ${loss}% L`;
}
// Rank + movement/clinch/showdown badges, shared by the desktop table and the
// mobile cards so the two never drift.
function RowBadges({
  medal,
  promoting,
  relegating,
  clinchStatus,
  showdown,
}: {
  medal: string;
  promoting: boolean;
  relegating: boolean;
  clinchStatus?: "up" | "down";
  showdown: boolean;
}) {
  return (
    <>
      {medal}
      {promoting && <> <span title="Promotion spot" style={{ color: "#2ecc71" }}>↑</span></>}
      {relegating && <> <span title="Relegation spot" style={{ color: "#e74c3c" }}>↓</span></>}
      {clinchStatus === "up" && (
        <> <span title="Clinched — guaranteed up" style={{ color: "#2ecc71" }}>🔒↑</span></>
      )}
      {clinchStatus === "down" && (
        <> <span title="Locked — guaranteed down" style={{ color: "#e74c3c" }}>🔒↓</span></>
      )}
      {showdown && (
        <span title="Tied — play a showdown" style={{ color: "#f1c40f", marginLeft: 4 }}>⚔</span>
      )}
    </>
  );
}

function gameRateTooltip(r: StandingRow): string {
  const total = r.gamesWon + r.gamesLost;
  if (total === 0) return "No games yet.";
  const winRate = Math.round((r.gamesWon / total) * 100);
  return `${winRate}% game win (${r.gamesWon}/${total})`;
}

export default async function StandingsPage() {
  const showBmpMmr = await getShowBmpMmr();
  const [data, openRound] = await Promise.all([
    loadStandingsPageData({ showBmpMmr }),
    prisma.signupRound.findFirst({
      where: { status: "OPEN" },
      orderBy: { openedAt: "desc" },
      select: { id: true },
    }),
  ]);

  // Season-wide match progress (sum of every division's round-robin).
  let totalPlayed = 0;
  let totalExpected = 0;
  for (const t of data.tiers) {
    for (const d of t.divisions) {
      const ac = d.activeMemberIds.length;
      totalExpected += ac < 2 ? 0 : (ac * (ac - 1)) / 2;
      totalPlayed += d.playedMatches;
    }
  }
  const totalRemaining = Math.max(0, totalExpected - totalPlayed);
  const pctPlayed = totalExpected > 0 ? Math.round((totalPlayed / totalExpected) * 100) : 0;

  return (
    <>
      <SiteNav activePath="/standings" />
      <main>
        {/* Open-signups CTA — pinned to the very top so anyone landing here
            during a signup window sees it first, not buried below standings
            or a "no active season" notice. */}
        {openRound && (
          <Link
            href="/join"
            className="card"
            style={{
              display: "block",
              textDecoration: "none",
              marginBottom: 16,
              background: "rgba(46,204,113,0.12)",
              border: "1px solid rgba(46,204,113,0.45)",
            }}
          >
            🎴 <strong>Sign-ups are open!</strong> Join the next season →
          </Link>
        )}
        {!data.season ? (
          <>
            <h2>Standings</h2>
            <div className="card muted">No active season right now.</div>
          </>
        ) : (
          <>
            <h2>{data.season.name} — Standings</h2>
            <div
              className="card"
              style={{ marginBottom: 16, display: "flex", gap: 16, flexWrap: "wrap", alignItems: "baseline" }}
            >
              <span style={{ fontSize: 15 }}>
                <strong>{totalPlayed}</strong> <span className="muted">/ {totalExpected}</span> matches played
              </span>
              <span className="muted">·</span>
              <span><strong>{totalRemaining}</strong> remaining</span>
              <span className="muted" style={{ marginLeft: "auto" }}>{pctPlayed}% complete</span>
            </div>
            <div
              className="card"
              style={{ marginBottom: 16, fontSize: 12, display: "flex", flexWrap: "wrap", gap: "4px 16px", alignItems: "center" }}
            >
              <span className="muted" style={{ textTransform: "uppercase", letterSpacing: 0.5, fontSize: 11 }}>Key</span>
              <span><span style={{ color: "#2ecc71" }}>↑</span> promotion spot</span>
              <span><span style={{ color: "#e74c3c" }}>↓</span> relegation spot</span>
              <span><span style={{ color: "#2ecc71" }}>🔒↑</span> clinched — guaranteed up</span>
              <span><span style={{ color: "#e74c3c" }}>🔒↓</span> locked — guaranteed down</span>
              <span><span style={{ color: "#f1c40f" }}>⚔</span> tied — needs a showdown</span>
              <span><s>name</s> dropped out</span>
            </div>
            {data.tiers.filter((t) => t.divisions.length > 0).map((tier) => {
              const isTopTier = tier.position === data.minTierPosition;
              const isBottomTier = tier.position === data.maxTierPosition;
              return (
                <section key={tier.id} style={{ marginTop: 24 }}>
                  <h3>{tier.name}</h3>
                  <div className="grid grid-2">
                    {tier.divisions.map((div, divIndex) => {
                      // Relegation/promotion is a CHAIN across every division
                      // (incl. between divisions of the same tier): each div's
                      // bottom drops into the next div, each div's top rises into
                      // the previous one. The only true ends are the FIRST division
                      // overall (top tier, first group — nothing above to promote
                      // to) and the LAST division overall (bottom tier, last group
                      // — nothing below to relegate to). Gating on the whole
                      // top/bottom TIER was wrong for multi-division tiers (it hid
                      // relegation between Common A (1) → Common 2, etc.).
                      const isFirstDivisionOverall = isTopTier && divIndex === 0;
                      const isLastDivisionOverall = isBottomTier && divIndex === tier.divisions.length - 1;
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
                      // Effective promote/relegate count for THIS division —
                      // clamped so we don't mark everyone in tiny divisions.
                      // Leave at least 1 row that's neither promoting nor
                      // relegating.
                      const _prc = tier.promoteRelegateCount;
                      const _maxMovers = Math.max(0, Math.floor((rows.length - 1) / 2));
                      const effective = Math.min(_prc, _maxMovers);

                      // Clinch predictor — who's already locked up/down even
                      // before the round-robin finishes. Top tier never
                      // promotes; bottom tier never relegates.
                      const clinch = computeClinch(
                        rows,
                        activeCount,
                        isFirstDivisionOverall ? 0 : effective,
                        isLastDivisionOverall ? 0 : effective,
                      );

                      // Shootout marker is TIER-INDEPENDENT — chains crossing
                      // either boundary (promo or relegation) need resolving.
                      // For N=1 this collapses to the old "ties at rank 1" /
                      // "ties at last rank" behavior; for N>1 it catches the
                      // promo/reli edge wherever it sits.
                      const promoTieRowSet = new Set<number>();
                      const relegationTieRowSet = new Set<number>();
                      for (const chain of chains) {
                        if (chain.length < 2) continue; // not a tie chain
                        if (effective > 0) {
                          // No promotion out of the first division overall, no
                          // relegation out of the last — so a tie at that dead
                          // edge isn't a showdown (nowhere to move).
                          if (!isFirstDivisionOverall) {
                            const crossesPromoEdge =
                              chain.some((i) => i < effective) && chain.some((i) => i >= effective);
                            if (crossesPromoEdge) {
                              for (const idx of chain) promoTieRowSet.add(idx);
                            }
                          }
                          if (!isLastDivisionOverall) {
                            const reliEdge = rows.length - effective;
                            const crossesReliEdge =
                              chain.some((i) => i < reliEdge) && chain.some((i) => i >= reliEdge);
                            if (crossesReliEdge) {
                              for (const idx of chain) relegationTieRowSet.add(idx);
                            }
                          }
                        }
                      }
                      void tierColors;
                      // Compute the per-row display bits once, then render them
                      // as a table (desktop) and as stacked cards (mobile).
                      const displayRows = rows.map((r, i) => ({
                        r,
                        medal: rankLabel(r, i),
                        promoting: complete && i < effective && !isFirstDivisionOverall && !promoTieRowSet.has(i),
                        relegating:
                          complete && i >= rows.length - effective && !isLastDivisionOverall && !relegationTieRowSet.has(i),
                        clinchStatus: complete ? undefined : clinch.get(r.player.id),
                        showdown: complete && (promoTieRowSet.has(i) || relegationTieRowSet.has(i)),
                        mmr: data.mmrByPlayerId.get(r.player.id),
                      }));
                      return (
                        <div key={div.id} className="card">
                          <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                            <strong className="pixel" style={{ fontSize: 18 }}>
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
                              title={complete ? "All matches played" : "In progress"}
                            >
                              {complete ? "✅" : ""} {playedMatches}/{expectedMatches} matches
                            </span>
                          </div>
                          <div className="table-scroll standings-table-wrap" style={{ marginTop: 8 }}>
                          <table className="table-dense">
                            <thead>
                              <tr>
                                <th></th>
                                <th>Player</th>
                                <th>Pts</th>
                                <th>W-D-L</th>
                                <th title="% of matches won 2-0">Match W%</th>
                                <th title="% of matches drawn 1-1">Match D%</th>
                                <th>Games</th>
                                {showBmpMmr && (
                                  <th title="Ranked MMR from balatromp.com. Separate from league rank.">BMP MMR</th>
                                )}
                              </tr>
                            </thead>
                            <tbody>
                              {rows.length === 0 ? (
                                <tr>
                                  <td colSpan={showBmpMmr ? 8 : 7} className="muted">No matches played yet.</td>
                                </tr>
                              ) : (
                                displayRows.map(({ r, medal, promoting, relegating, clinchStatus, showdown, mmr }) => {
                                  const link = (
                                    <Link href={`/profile/${r.player.id}`} style={{ color: "var(--text)" }}>
                                      {r.player.displayName}
                                    </Link>
                                  );
                                  return (
                                    <tr key={r.player.id}>
                                      <td><RowBadges medal={medal} promoting={promoting} relegating={relegating} clinchStatus={clinchStatus} showdown={showdown} /></td>
                                      <td>{r.dropped ? <s>{link}</s> : link}<DiscordId value={r.player.discordId} username={r.player.username} /></td>
                                      <td><strong>{r.points}</strong></td>
                                      <td title={standingRateTooltip(r)}>{r.wins}-{r.draws}-{r.losses}</td>
                                      <td>
                                        {r.played > 0
                                          ? `${Math.round((r.wins / r.played) * 100)}%`
                                          : <span className="muted">—</span>}
                                      </td>
                                      <td>
                                        {r.played > 0
                                          ? `${Math.round((r.draws / r.played) * 100)}%`
                                          : <span className="muted">—</span>}
                                      </td>
                                      <td title={gameRateTooltip(r)}>{r.gamesWon}-{r.gamesLost}</td>
                                      {showBmpMmr && (
                                        <td>{renderMmrCell(mmr, data.bmpCurrentSeason)}</td>
                                      )}
                                    </tr>
                                  );
                                })
                              )}
                            </tbody>
                          </table>
                          </div>
                          {/* Mobile: stacked cards — CSS toggles table vs cards at 640px. */}
                          <div className="standings-cards">
                            {rows.length === 0 ? (
                              <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>No matches played yet.</p>
                            ) : (
                              displayRows.map(({ r, medal, promoting, relegating, clinchStatus, showdown, mmr }) => (
                                <div key={r.player.id} className="standings-card">
                                  <div className="standings-card-head">
                                    <span><RowBadges medal={medal} promoting={promoting} relegating={relegating} clinchStatus={clinchStatus} showdown={showdown} /></span>
                                    <Link href={`/profile/${r.player.id}`} className="standings-card-name" style={{ color: "var(--text)" }}>
                                      {r.dropped ? <s>{r.player.displayName}</s> : r.player.displayName}
                                      <DiscordId value={r.player.discordId} username={r.player.username} />
                                    </Link>
                                    <strong style={{ whiteSpace: "nowrap" }}>{r.points} pts</strong>
                                  </div>
                                  <div className="standings-card-sub muted">
                                    {r.wins}-{r.draws}-{r.losses} W-D-L · {r.gamesWon}-{r.gamesLost} games · {r.played} played
                                    {showBmpMmr && mmr ? <> · MMR {renderMmrCell(mmr, data.bmpCurrentSeason)}</> : null}
                                  </div>
                                </div>
                              ))
                            )}
                          </div>
                          {div.shootouts.length > 0 && (
                            <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
                              <strong style={{ color: "#f1c40f" }}>⚔ Showdown{div.shootouts.length === 1 ? "" : "s"}:</strong>{" "}
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
