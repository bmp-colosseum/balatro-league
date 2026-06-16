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
import type { ReactNode } from "react";
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
      style={{ color: "#f1c40f" }}
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

export function DivisionStandingsTable({
  rows,
  extras,
  showBmpMmr = false,
  bmpCurrentSeason = null,
  finalRankHeader,
  finalRankCell,
}: {
  rows: Row[];
  extras?: Map<string, StandingsRowExtras>;
  showBmpMmr?: boolean;
  bmpCurrentSeason?: string | null;
  // When both are set, a "Final rank" column is inserted after Player. The cell
  // render-prop lets the caller drop in an admin inline-edit form or plain text.
  finalRankHeader?: ReactNode;
  finalRankCell?: (r: Row) => ReactNode;
}) {
  const hasFinalRank = !!finalRankHeader && !!finalRankCell;
  const colCount = 7 + (showBmpMmr ? 1 : 0) + (hasFinalRank ? 1 : 0);

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
                  <tr key={r.player.id}>
                    <td><RowBadges medal={medal} promoting={ex?.promoting} relegating={ex?.relegating} clinchStatus={ex?.clinchStatus} showdown={ex?.showdown} /></td>
                    <td>{r.dropped ? <s>{link}</s> : link}<DiscordId value={r.player.discordId} username={r.player.username} /></td>
                    {hasFinalRank && <td>{finalRankCell!(r)}</td>}
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
              <div key={r.player.id} className="standings-card">
                <div className="standings-card-head">
                  <span><RowBadges medal={medal} promoting={ex?.promoting} relegating={ex?.relegating} clinchStatus={ex?.clinchStatus} showdown={ex?.showdown} /></span>
                  <Link href={`/profile/${r.player.id}`} className="standings-card-name" style={{ color: "var(--text)" }}>
                    {r.dropped ? <s>{r.player.displayName}</s> : r.player.displayName}
                    <DiscordId value={r.player.discordId} username={r.player.username} />
                  </Link>
                  <strong style={{ whiteSpace: "nowrap" }}>{r.points} pts</strong>
                </div>
                <div className="standings-card-sub muted">
                  {r.wins}-{r.draws}-{r.losses} W-D-L · {r.gamesWon}-{r.gamesLost} games · {r.played} played
                  {showBmpMmr && ex?.mmr ? <> · MMR {renderMmrCell(ex.mmr, bmpCurrentSeason)}</> : null}
                </div>
              </div>
            );
          })
        )}
      </div>
    </>
  );
}
