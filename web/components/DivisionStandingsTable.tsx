// The one standings table, shared by /standings, /seasons/[id], and
// /divisions/[id] so every division's standings look identical (same columns,
// badges, mobile cards). Renders just the table body + mobile cards — each page
// keeps its own card wrapper / division header / completion pill / shootouts,
// which legitimately differ by context.
//
// Per-row extras (promotion/relegation + clinch + showdown badges, BMP MMR) are
// passed in via `extras`, since only /standings runs the active-season chain
// math; the other pages omit them. The optional Final-rank column (ended
// seasons) is supplied as a render-prop so the admin inline-edit stays put.

import Link from "next/link";
import type { ReactNode, CSSProperties } from "react";
import { rankLabel } from "@/lib/standings";
import { DiscordId } from "@/components/DiscordId";
import type { StandingsMmrEntry } from "@/lib/loaders/standings";

// Minimal row shape the table needs. Every standings source — the /standings
// cache, computeStandings, the division loader — is structurally compatible
// (their `player` objects all carry at least these four fields).
export interface StandingsTableRow {
  player: { id: string; displayName: string; discordId: string; username: string | null };
  points: number;
  wins: number;
  draws: number;
  losses: number;
  gamesWon: number;
  gamesLost: number;
  played: number;
  dropped?: boolean;
  // For rankLabel's tie-aware medal (optional; absent → plain positional rank).
  rank?: number;
  tiedWithPrev?: boolean;
  tiedWithNext?: boolean;
  // Set only under a best-N scoring mode -- how many of this player's
  // results counted toward their standing, and the cap selection was made
  // against. Rendered as "counts N of M" next to the record when the
  // caller passes showCountedBadge.
  counted?: number;
  of?: number;
  // Set only when the season's tiebreak is "lives" -- net life differential
  // and how many of this row's counted games have no recorded winnerLives.
  // See computeNetLives in @/lib/standings. Renders a "Lives" column when
  // ANY row in the table carries netLives.
  netLives?: number;
  livesGamesMissing?: number;
  // Set alongside netLives when this row was part of a points-tied group of
  // 2+ under the "lives" tiebreak -- a plain-English audit of exactly which
  // step decided (or failed to decide) this row's place. See
  // StandingRow.tiebreakNote in @/lib/standings. Shown as the Lives cell's
  // tooltip and as a small muted line under the player's name.
  tiebreakNote?: string;
}

type Row = StandingsTableRow;

export interface StandingsRowExtras {
  promoting?: boolean;
  relegating?: boolean;
  clinchStatus?: "up" | "down";
  showdown?: boolean;
  mmr?: StandingsMmrEntry;
}

function formatBmpSeason(tag: string | null): string {
  if (!tag) return "?";
  const m = /^season(\d+)$/.exec(tag);
  return m ? `S${m[1]}` : tag;
}

// Bare number for the current BMP season; annotated + hover-flagged when it's
// from an older season (possibly stale).
function renderMmrCell(entry: StandingsMmrEntry | undefined, currentBmpSeason: string | null): ReactNode {
  if (!entry) return <span className="muted">—</span>;
  const isStale = currentBmpSeason != null && entry.bmpSeason !== currentBmpSeason;
  if (!isStale) {
    return <span title={`From BMP ${formatBmpSeason(entry.bmpSeason)}`}>{entry.mmr}</span>;
  }
  return (
    <span
      title={`From BMP ${formatBmpSeason(entry.bmpSeason)}, not the current season. May be stale.`}
      style={{ color: "var(--accent)" }}
    >
      {entry.mmr}
      <span className="muted" style={{ fontSize: 10, marginLeft: 4 }}>
        {formatBmpSeason(entry.bmpSeason)}
      </span>
    </span>
  );
}

function standingRateTooltip(r: StandingsTableRow): string {
  if (r.played === 0) return "No matches yet.";
  const win = Math.round((r.wins / r.played) * 100);
  const draw = Math.round((r.draws / r.played) * 100);
  const loss = Math.round((r.losses / r.played) * 100);
  return `${win}% W · ${draw}% D · ${loss}% L`;
}

function gameRateTooltip(r: StandingsTableRow): string {
  const total = r.gamesWon + r.gamesLost;
  if (total === 0) return "No games yet.";
  const winRate = Math.round((r.gamesWon / total) * 100);
  return `${winRate}% game win (${r.gamesWon}/${total})`;
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
  promoting?: boolean;
  relegating?: boolean;
  clinchStatus?: "up" | "down";
  showdown?: boolean;
}) {
  return (
    <>
      {medal}
      {promoting && <> <span title="Promotion spot" style={{ color: "var(--info)" }}>↑</span></>}
      {relegating && <> <span title="Relegation spot" style={{ color: "var(--admin)" }}>↓</span></>}
      {clinchStatus === "up" && (
        <> <span title="Clinched — guaranteed up" style={{ color: "var(--info)" }}>🔒↑</span></>
      )}
      {clinchStatus === "down" && (
        <> <span title="Locked — guaranteed down" style={{ color: "var(--admin)" }}>🔒↓</span></>
      )}
      {showdown && (
        <span title="Tied — play a shootout (a 1-game tiebreaker)" style={{ color: "var(--accent)", marginLeft: 4 }}>⚔</span>
      )}
    </>
  );
}

// Spelled-out, color-coded W/D/L so the record reads itself — no need to know
// the column order. Win green, loss red, draws muted.
function RecordCells({ r }: { r: StandingsTableRow }) {
  return (
    <span style={{ whiteSpace: "nowrap" }}>
      <span style={{ color: "var(--success)" }}>{r.wins}W</span>
      <span className="muted"> · </span>
      <span className="muted">{r.draws}D</span>
      <span className="muted"> · </span>
      <span style={{ color: "var(--danger)" }}>{r.losses}L</span>
    </span>
  );
}

// "counts 3 of 4" next to the record under an active best-N scoring badge --
// the record above stays the player's FULL record; this is the counted-points
// cap it was scored against. Renders nothing when the caller isn't showing
// the badge, or this row has no counted/of (standard-mode division).
function CountedNote({ r, show }: { r: StandingsTableRow; show?: boolean }) {
  if (!show || r.counted === undefined || r.of === undefined) return null;
  return (
    <span className="muted" style={{ fontSize: 11, marginLeft: 6, whiteSpace: "nowrap" }}>
      counts {r.counted} of {r.of}
    </span>
  );
}

// Net life differential cell -- a row carries netLives either because the
// season's tiebreak is "lives" (every row) or it's "chain" and this row is
// part of a tie group (attachLivesToTiedRows; informational only). Signed
// so the direction reads at a glance; "(n missing)" flags counted games
// with no recorded winnerLives, same wording the admin standings-preview
// page uses.
function LivesCell({ r }: { r: StandingsTableRow }) {
  if (r.netLives === undefined) return <span className="muted">-</span>;
  const sign = r.netLives > 0 ? "+" : "";
  return (
    <span className="muted" title={r.tiebreakNote}>
      {sign}{r.netLives}
      {r.livesGamesMissing ? ` (${r.livesGamesMissing} missing)` : ""}
    </span>
  );
}

// Small muted line under a player's name explaining exactly which step
// decided their tie -- the same text as the Lives cell's tooltip, but
// visible on phones where hover tooltips don't exist. Renders nothing when
// the row carries no tiebreakNote.
function TiebreakNoteLine({ r }: { r: StandingsTableRow }) {
  if (!r.tiebreakNote) return null;
  return (
    <div className="muted" style={{ fontSize: 11 }}>
      {r.tiebreakNote}
    </div>
  );
}

// Faint background band marking the promotion (blue) / relegation (amber) zone so
// the stakes read at a glance — kept DISTINCT from the green-win / red-loss record
// colours. Covers the decided state (promoting/relegating) and the mid-season clinch.
function rowTint(ex?: StandingsRowExtras): CSSProperties | undefined {
  if (ex?.promoting || ex?.clinchStatus === "up") return { background: "rgba(118,199,255,0.10)" };
  if (ex?.relegating || ex?.clinchStatus === "down") return { background: "rgba(230,126,34,0.10)" };
  return undefined;
}

export function DivisionStandingsTable({
  rows,
  extras,
  showBmpMmr = false,
  bmpCurrentSeason = null,
  showCountedBadge = false,
  livesBreaksTies = false,
  finalRankHeader,
  finalRankCell,
}: {
  rows: Row[];
  extras?: Map<string, StandingsRowExtras>;
  showBmpMmr?: boolean;
  bmpCurrentSeason?: string | null;
  // True when this division's season-scoring badge is currently active (a
  // best-N mode with at least one unreplaced dropout) -- shows each row's
  // "counts N of M" next to its record. Off by default so callers that
  // don't track the badge (e.g. /seasons/[id]'s ended-season view) render
  // unchanged.
  showCountedBadge?: boolean;
  // True when this season's tiebreak is "lives" (ties ARE broken by net
  // lives) vs the default "chain" (net lives shown for tied players only as
  // informational context -- see attachLivesToTiedRows). Only changes the
  // Lives column's footnote wording below -- which rows carry netLives is
  // already decided by the caller's data, not this flag.
  livesBreaksTies?: boolean;
  // When both are set, a "Final rank" column is inserted after Player. The cell
  // render-prop lets the caller drop in an admin inline-edit form or plain text.
  finalRankHeader?: ReactNode;
  finalRankCell?: (r: Row) => ReactNode;
}) {
  const hasFinalRank = !!finalRankHeader && !!finalRankCell;
  // The Lives column shows whenever ANY row carries netLives -- under the
  // "lives" tiebreak every row has it; under "chain" only rows in a tie
  // group do (see attachLivesToTiedRows), so a division with no ties simply
  // doesn't render this column at all.
  const showLives = rows.some((r) => r.netLives !== undefined);
  const colCount = 5 + (showBmpMmr ? 1 : 0) + (hasFinalRank ? 1 : 0) + (showLives ? 1 : 0);

  return (
    <>
      <div className="table-scroll standings-table-wrap" style={{ marginTop: 8 }}>
        <table className="table-dense">
          <thead>
            <tr>
              <th></th>
              <th>Player</th>
              {hasFinalRank && <th>{finalRankHeader}</th>}
              <th>Pts</th>
              <th>Record</th>
              <th title="Individual games won-lost">Games</th>
              {showLives && (
                <th
                  title={
                    livesBreaksTies
                      ? "Net life differential -- this season's ties are broken by it instead of today's wins/draws/name chain"
                      : "Net life differential for tied players -- informational only, not used to break ties this season"
                  }
                >
                  Lives
                </th>
              )}
              {showBmpMmr && (
                <th title="Ranked MMR from balatromp.com. Separate from league rank.">BMP MMR</th>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={colCount} className="muted">No matches played yet.</td></tr>
            ) : (
              rows.map((r, i) => {
                const ex = extras?.get(r.player.id);
                const medal = rankLabel(r, i);
                const link = (
                  <Link href={`/profile/${r.player.id}`} style={{ color: "var(--text)" }}>
                    {r.player.displayName}
                  </Link>
                );
                return (
                  <tr key={r.player.id} style={rowTint(ex)}>
                    <td><RowBadges medal={medal} promoting={ex?.promoting} relegating={ex?.relegating} clinchStatus={ex?.clinchStatus} showdown={ex?.showdown} /></td>
                    <td>
                      {r.dropped ? <s>{link}</s> : link}<DiscordId value={r.player.discordId} username={r.player.username} />
                      <TiebreakNoteLine r={r} />
                    </td>
                    {hasFinalRank && <td>{finalRankCell!(r)}</td>}
                    <td><strong>{r.points}</strong></td>
                    <td title={standingRateTooltip(r)}><RecordCells r={r} /><CountedNote r={r} show={showCountedBadge} /></td>
                    <td className="muted" title={gameRateTooltip(r)}>{r.gamesWon}-{r.gamesLost}</td>
                    {showLives && <td><LivesCell r={r} /></td>}
                    {showBmpMmr && <td>{renderMmrCell(ex?.mmr, bmpCurrentSeason)}</td>}
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
          rows.map((r, i) => {
            const ex = extras?.get(r.player.id);
            const medal = rankLabel(r, i);
            return (
              <div key={r.player.id} className="standings-card" style={rowTint(ex)}>
                <div className="standings-card-head">
                  <span><RowBadges medal={medal} promoting={ex?.promoting} relegating={ex?.relegating} clinchStatus={ex?.clinchStatus} showdown={ex?.showdown} /></span>
                  <Link href={`/profile/${r.player.id}`} className="standings-card-name" style={{ color: "var(--text)" }}>
                    {r.dropped ? <s>{r.player.displayName}</s> : r.player.displayName}
                    <DiscordId value={r.player.discordId} username={r.player.username} />
                  </Link>
                  <strong style={{ whiteSpace: "nowrap" }}>{r.points} pts</strong>
                </div>
                <TiebreakNoteLine r={r} />
                <div className="standings-card-sub muted">
                  <RecordCells r={r} /><CountedNote r={r} show={showCountedBadge} /> · {r.gamesWon}-{r.gamesLost} games · {r.played} played
                  {showLives && <> - <LivesCell r={r} /> lives</>}
                  {showBmpMmr && ex?.mmr ? <> · MMR {renderMmrCell(ex.mmr, bmpCurrentSeason)}</> : null}
                </div>
              </div>
            );
          })
        )}
      </div>
      <p className="muted" style={{ fontSize: 11, marginTop: 8 }}>
        <strong>3</strong> pts per win · <strong>1</strong> per draw · Record = wins·draws·losses ·{" "}
        <span style={{ color: "var(--info)" }}>↑ blue = promoting</span> ·{" "}
        <span style={{ color: "var(--admin)" }}>↓ amber = relegating</span>
        {showLives && (
          <> -- {livesBreaksTies ? "Ties broken by net lives" : "Lives shown for tied players (informational -- ties are not broken by lives this season)"}</>
        )}
      </p>
    </>
  );
}
