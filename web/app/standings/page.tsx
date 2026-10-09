import Link from "next/link";
import { auth } from "@/auth";
import { loadStandingsPageData, type ViewerDivisionSummary } from "@/lib/loaders/standings";
import { loadOpenSignupRoundId } from "@/lib/loaders/join";
import { getShowBmpMmr } from "@/lib/preferences";
import { SiteNav } from "@/components/SiteNav";
import {
  CardAvatar,
  DivisionStandingsTable,
  type StandingsRowExtras,
} from "@/components/DivisionStandingsTable";
import { SeasonWindow } from "@/components/SeasonWindow";
import { type StandingRow } from "@/lib/standings";
import { divisionSummaryLine, recordPips } from "@/lib/standings-cards-core";
import { rarityIndex, tierColors, tierSlug } from "@/lib/tier-colors";

// Clinch predictor: who is mathematically guaranteed to promote ("up") /
// relegate ("down") regardless of how the remaining matches play out.
// Conservative — flags a player only when it holds even in their WORST
// remaining case while every rival wins out. (That ignores rivals also playing
// each other, which can only help the flagged player, so it never
// false-positives; it just won't flag a borderline case early.) Assumes the
// standard 3/1/0 scoring. Absent from the map = not yet decided.
function computeClinch(
  rows: Array<StandingRow & { dropped?: boolean }>,
  gamesByPlayer: Record<string, number>,
  fallbackTotal: number,
  promoteN: number,
  relegateN: number,
): Map<string, "up" | "down"> {
  const MAX_PER_MATCH = 3;
  const result = new Map<string, "up" | "down">();
  const active = rows.filter((r) => !r.dropped);
  const n = active.length;
  if (n === 0) return result;
  const info = active.map((r) => {
    // Per-player total scheduled games — N-1 in a round-robin, their assigned
    // count in a graph division — so "remaining" (hence the ceiling) is right.
    const total = gamesByPlayer[r.player.id] ?? fallbackTotal;
    const remaining = Math.max(0, total - r.played);
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

// v2 "Card Table" "Your division" card -- /standings' answer to "where am I
// and who's next" for a returning, signed-in player (the audit's Win #1).
// Pinned above every division's table. Brand new markup with no v1
// equivalent: always in the DOM, hidden by default, shown only under
// html[data-ui="v2"] (see globals.css) -- same pattern as every other
// v2-only block on this page.
function YourDivisionCard({
  viewerDivision,
  avatarUrl,
}: {
  viewerDivision: ViewerDivisionSummary;
  avatarUrl: string | null;
}) {
  const pips = recordPips(viewerDivision.wins, viewerDivision.draws, viewerDivision.losses);
  const left = viewerDivision.unplayedOpponentNames;
  return (
    <div className="card your-division-v2">
      <div className="card-header your-division-head">
        <CardAvatar displayName={viewerDivision.divisionName} avatarUrl={avatarUrl} />
        <div className="your-division-name-block">
          <div className="your-division-label">Your division</div>
          <strong className="pixel division-name" data-rarity={rarityIndex(viewerDivision.tierPosition)}>
            <Link href={`/divisions/${viewerDivision.divisionId}`} style={{ textDecoration: "none" }}>
              {viewerDivision.divisionName}
            </Link>
          </strong>
        </div>
        <span className="your-division-rank" data-rarity={rarityIndex(viewerDivision.tierPosition)}>
          #{viewerDivision.rank}
        </span>
      </div>
      <div className="your-division-stats">
        <span className="your-division-points">{viewerDivision.points} pts</span>
        <span className="your-division-hand">
          {pips.map((kind, i) => (
            <span key={i} className="player-card-pip" data-kind={kind} />
          ))}
        </span>
        <span className="muted">{viewerDivision.wins}W {viewerDivision.draws}D {viewerDivision.losses}L</span>
      </div>
      <div className="your-division-left muted">
        {left.length > 0 ? `${left.length} left: ${left.join(", ")}` : "All matches played"}
      </div>
      <Link href={`/divisions/${viewerDivision.divisionId}`} className="your-division-report">
        Report a result
      </Link>
    </div>
  );
}

export const dynamic = "force-dynamic"; // Always fresh — DB writes happen out-of-band via the bot

export default async function StandingsPage() {
  const showBmpMmr = await getShowBmpMmr();
  // Viewer's Discord id (for the v2 "you" badge) -- undefined when signed
  // out, same session shape SiteNav/the /me page already read.
  const session = await auth();
  const viewerDiscordId = (session?.user as { discordId?: string } | undefined)?.discordId;
  const [data, openRound] = await Promise.all([
    loadStandingsPageData({ showBmpMmr, viewerDiscordId }),
    loadOpenSignupRoundId(),
  ]);

  // Season-wide match progress (sum of every division's round-robin).
  let totalPlayed = 0;
  let totalExpected = 0;
  for (const t of data.tiers) {
    for (const d of t.divisions) {
      totalExpected += d.expectedMatches;
      totalPlayed += d.playedMatches;
    }
  }
  const totalRemaining = Math.max(0, totalExpected - totalPlayed);
  const pctPlayed = totalExpected > 0 ? Math.round((totalPlayed / totalExpected) * 100) : 0;

  // Flattened ladder order (tiers already ordered by position, divisions by
  // groupNumber -- see loadStandingsPageData) so each division can look up
  // the name of the division immediately above/below it for the v2 zone
  // key's "Promotes to <X>" / "Drops to <X>" wording. Undefined at either
  // end of the whole ladder.
  const tiersWithDivisions = data.tiers.filter((t) => t.divisions.length > 0);
  const flatDivisions = tiersWithDivisions.flatMap((t) => t.divisions);
  const neighborNamesByDivisionId = new Map<string, { above?: string; below?: string }>(
    flatDivisions.map((d, i) => [
      d.id,
      {
        above: i > 0 ? flatDivisions[i - 1]!.name : undefined,
        below: i < flatDivisions.length - 1 ? flatDivisions[i + 1]!.name : undefined,
      },
    ]),
  );

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
            {/* v2 "Card Table" tier tabs -- jump links to each tier's
                section below, chunky and rarity-colored per MASTER.md. Brand
                new element, hidden under v1 by a base `.tier-tabs { display:
                none; }` rule (see globals.css) rather than trying to make it
                look native to the current design -- least invasive way to
                guarantee v1 stays byte-for-byte unchanged. */}
            <nav className="tier-tabs" aria-label="Jump to tier">
              {tiersWithDivisions.map((tier) => (
                <a
                  key={tier.id}
                  href={`#tier-${tierSlug(tier.name)}`}
                  className="tier-tab"
                  data-rarity={rarityIndex(tier.position)}
                >
                  {tier.name} <span className="tier-tab-count">{tier.divisions.length}</span>
                </a>
              ))}
            </nav>
            <SeasonWindow start={data.season.startedAt} end={data.season.scheduledEndAt} className="mb-2" />
            <div className="card" style={{ marginBottom: 16 }}>
              <div className="progress-v1">
                <span style={{ fontSize: 15, whiteSpace: "nowrap" }}>
                  <strong>{totalPlayed}</strong> <span className="muted">/ {totalExpected}</span> matches played · <strong>{totalRemaining}</strong> remaining
                </span>
                <div style={{ flex: "1 1 120px", minWidth: 100, background: "var(--surface-2)", borderRadius: 99, height: 6, overflow: "hidden" }}>
                  <div style={{ background: "var(--accent-2)", height: "100%", width: `${pctPlayed}%` }} />
                </div>
                <span className="muted" style={{ fontSize: 13, whiteSpace: "nowrap" }}>{pctPlayed}% complete</span>
              </div>
              {/* v2: "12 of 174 played" plus the bar only -- drops the
                  "remaining" and "% complete" repeats of the same number
                  (see progress-v1 above, which v1 keeps unchanged). New
                  block, hidden by default, shown only under
                  html[data-ui="v2"] (see globals.css). */}
              <div className="progress-v2">
                <span style={{ whiteSpace: "nowrap" }}>
                  <strong>{totalPlayed}</strong> of {totalExpected} played
                </span>
                <div style={{ flex: "1 1 120px", minWidth: 100, background: "var(--surface-2)", borderRadius: 99, height: 6, overflow: "hidden" }}>
                  <div style={{ background: "var(--accent-2)", height: "100%", width: `${pctPlayed}%` }} />
                </div>
              </div>
              <details style={{ marginTop: 8 }}>
                <summary className="muted" style={{ cursor: "pointer", textTransform: "uppercase", letterSpacing: 0.5, fontSize: 11 }}>Key</summary>
                <div style={{ marginTop: 8, fontSize: 12, display: "flex", flexWrap: "wrap", gap: "4px 16px", alignItems: "center" }}>
                  <span><span style={{ color: "var(--info)" }}>↑</span> promotion spot</span>
                  <span><span style={{ color: "var(--admin)" }}>↓</span> relegation spot</span>
                  <span><span style={{ color: "var(--info)" }}>🔒↑</span> clinched — guaranteed up</span>
                  <span><span style={{ color: "var(--admin)" }}>🔒↓</span> locked — guaranteed down</span>
                  <span><span style={{ color: "var(--accent)" }}>⚔</span> tied — needs a shootout (a 1-game tiebreaker)</span>
                  <span><s>name</s> dropped out</span>
                </div>
              </details>
            </div>
            {data.viewerDivision && (
              <YourDivisionCard
                viewerDivision={data.viewerDivision}
                avatarUrl={data.avatarUrlByPlayerId.get(data.viewerPlayerId ?? "") ?? null}
              />
            )}
            {tiersWithDivisions.map((tier) => {
              const isTopTier = tier.position === data.minTierPosition;
              const isBottomTier = tier.position === data.maxTierPosition;
              return (
                <section key={tier.id} id={`tier-${tierSlug(tier.name)}`} className="tier-section" style={{ marginTop: 24 }}>
                  {/* `pixel` + `data-rarity` give v2 the colored display-face
                      heading per MASTER.md ("section headings for tiers in
                      the pixel face coloured by rarity"); both are no-ops
                      under v1 (see globals.css). */}
                  {/* v2 only: when a tier has just one division, the h3 +
                      card title + rarity chip said the tier name three
                      times. data-multi (set only for 2+ divisions) lets the
                      v2 stylesheet drop this heading for a single-division
                      tier and keep just the coloured card title; v1 always
                      shows it (see globals.css). */}
                  <h3
                    className="pixel tier-heading"
                    data-rarity={rarityIndex(tier.position)}
                    data-multi={tier.divisions.length >= 2 ? "1" : undefined}
                  >
                    {tier.name}
                  </h3>
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
                      const expectedMatches = div.expectedMatches;
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
                      // Promote/relegate counts for THIS division come from the
                      // real placement rule (div.promote / div.relegate, already 0
                      // at the top/bottom of the ladder). Clamped so we always
                      // leave ≥1 row that's neither promoting nor relegating.
                      const promoteN = isFirstDivisionOverall ? 0 : div.promote;
                      const relegateN = isLastDivisionOverall ? 0 : div.relegate;
                      const _room = Math.max(0, rows.length - 1);
                      const promoteEff = Math.min(promoteN, _room);
                      const relegateEff = Math.min(relegateN, _room - promoteEff);

                      // Clinch predictor — who's already locked up/down even
                      // before the round-robin finishes. Top tier never
                      // promotes; bottom tier never relegates.
                      const clinch = computeClinch(
                        rows,
                        div.gamesByPlayer,
                        Math.max(0, activeCount - 1),
                        promoteEff,
                        relegateEff,
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
                        // A tie straddling the promotion cut (top `promoteEff`) or
                        // the relegation cut (bottom `relegateEff`) needs a showdown.
                        if (promoteEff > 0) {
                          const crossesPromoEdge =
                            chain.some((i) => i < promoteEff) && chain.some((i) => i >= promoteEff);
                          if (crossesPromoEdge) {
                            for (const idx of chain) promoTieRowSet.add(idx);
                          }
                        }
                        if (relegateEff > 0) {
                          const reliEdge = rows.length - relegateEff;
                          const crossesReliEdge =
                            chain.some((i) => i < reliEdge) && chain.some((i) => i >= reliEdge);
                          if (crossesReliEdge) {
                            for (const idx of chain) relegationTieRowSet.add(idx);
                          }
                        }
                      }
                      // Per-row badges/MMR for the shared standings table.
                      const extras = new Map<string, StandingsRowExtras>(
                        rows.map((r, i) => [r.player.id, {
                          promoting: complete && i < promoteEff && !promoTieRowSet.has(i),
                          relegating: complete && i >= rows.length - relegateEff && !relegationTieRowSet.has(i),
                          clinchStatus: complete ? undefined : clinch.get(r.player.id),
                          showdown: complete && (promoTieRowSet.has(i) || relegationTieRowSet.has(i)),
                          mmr: data.mmrByPlayerId.get(r.player.id),
                          isViewer: data.viewerPlayerId !== null && r.player.id === data.viewerPlayerId,
                          avatarUrl: data.avatarUrlByPlayerId.get(r.player.id),
                        }]),
                      );
                      const neighbors = neighborNamesByDivisionId.get(div.id);
                      // v2 phone collapse: the viewer's own division, and
                      // (signed out) the first division of each tier, start
                      // expanded; every other division starts collapsed to
                      // the one-line summary below. Desktop and v1 force
                      // everything open regardless of this attribute (see
                      // globals.css) -- it only matters at v2 phone widths.
                      const isViewerDivision =
                        data.viewerPlayerId !== null && div.activeMemberIds.includes(data.viewerPlayerId);
                      const isOpenByDefault =
                        isViewerDivision || (data.viewerPlayerId === null && divIndex === 0);
                      const leader = rows[0];
                      const summaryText = divisionSummaryLine({
                        divisionName: div.name,
                        leaderName: leader?.player.displayName,
                        leaderPoints: leader?.points,
                        playedMatches,
                        expectedMatches,
                      });
                      return (
                        <div key={div.id} className="card">
                        <details className="division-details-v2" open={isOpenByDefault}>
                          {/* Phone-collapsed one-line summary -- hidden
                              entirely under v1 and under v2 desktop, and
                              hidden under v2 phone too once expanded (see
                              globals.css) so it never duplicates the full
                              header below. */}
                          <summary className="division-summary-v2">{summaryText}</summary>
                          <div className="division-body-v2">
                          {/* `card-header` is a no-op under v1 (no bare
                              `.card-header` rule outside a responsive-table
                              cell -- see globals.css); under v2 it becomes
                              the panel header strip (panel-2 bg, bottom
                              border) per MASTER.md. */}
                          <div className="card-header">
                            <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                              <strong className="pixel division-name" data-rarity={rarityIndex(tier.position)}>
                                <Link href={`/divisions/${div.id}`} style={{ textDecoration: "none" }}>{div.name}</Link>
                              </strong>
                              {/* Rarity chip -- same render as the TierPill helper
                                  used on /players and the winners page, reusing
                                  tierColors/rarityIndex so it carries data-rarity.
                                  New element: hidden under v1 (see globals.css).
                                  v2 only: dropped for a single-division tier (see
                                  the tier-heading's data-multi above) so the tier
                                  name isn't repeated a third time. */}
                              <span
                                className="pill division-chip"
                                data-rarity={rarityIndex(tier.position)}
                                data-multi={tier.divisions.length >= 2 ? "1" : undefined}
                                style={{ background: tierColors(tier.position).bg, color: tierColors(tier.position).fg }}
                              >
                                {tier.name}
                              </span>
                              {div.scoringBadge && (
                                <span className="pill" style={{ fontSize: 11 }} title="This season's active scoring rule">
                                  counts best {div.scoringBadge.n} of {div.scoringBadge.scheduled} matches
                                </span>
                              )}
                              <span
                                className="pill matches-chip"
                                style={{
                                  background: complete ? "rgba(46,204,113,0.15)" : "rgba(149,165,166,0.15)",
                                  color: complete ? "var(--success)" : "var(--muted)",
                                  fontSize: 11,
                                  marginLeft: "auto",
                                }}
                                title={complete ? "All matches played" : "In progress"}
                              >
                                {complete ? "✅" : ""} {playedMatches}/{expectedMatches} matches
                              </span>
                            </div>
                            <div className="muted meta-v1" style={{ fontSize: 11, marginTop: 2, marginBottom: 8, display: "flex", flexWrap: "wrap", gap: "2px 10px" }}>
                              <span>👤 {activeCount} player{activeCount === 1 ? "" : "s"}</span>
                              {promoteN > 0 && <span><span style={{ color: "var(--info)" }}>↑ {promoteN}</span> promote</span>}
                              {relegateN > 0 && <span><span style={{ color: "var(--admin)" }}>↓ {relegateN}</span> relegate</span>}
                              <span>{div.format === "round-robin" ? "🔁 Round robin (play everyone)" : "🎯 4 assigned opponents"}</span>
                            </div>
                            {/* v2-only wording ("N players" / "N up" / "N down")
                                per the brief -- both variants always render,
                                CSS shows exactly one depending on
                                html[data-ui="v2"] (same pattern as the zone
                                key), so v1's text never moves. */}
                            <div className="muted meta-v2">
                              <span>{activeCount} player{activeCount === 1 ? "" : "s"}</span>
                              {promoteN > 0 && <span>{promoteN} up</span>}
                              {relegateN > 0 && <span>{relegateN} down</span>}
                              <span>{div.format === "round-robin" ? "round robin, play everyone" : "4 assigned opponents"}</span>
                            </div>
                          </div>
                          <DivisionStandingsTable
                            rows={rows}
                            extras={extras}
                            showBmpMmr={showBmpMmr}
                            bmpCurrentSeason={data.bmpCurrentSeason}
                            showCountedBadge={!!div.scoringBadge}
                            livesBreaksTies={data.season?.tiebreak === "lives"}
                            tierRarity={rarityIndex(tier.position)}
                            aboveDivisionName={neighbors?.above}
                            belowDivisionName={neighbors?.below}
                            noMatchesYet={playedMatches === 0}
                          />
                          {div.shootouts.length > 0 && (
                            <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
                              <strong style={{ color: "var(--accent)" }}>⚔ Shootout{div.shootouts.length === 1 ? "" : "s"}:</strong>{" "}
                              {div.shootouts.map((s, i) => (
                                <span key={s.id}>
                                  {i > 0 && " · "}
                                  <strong>{s.winnerName}</strong> beat {s.loserName}
                                </span>
                              ))}
                            </div>
                          )}
                          </div>
                        </details>
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
