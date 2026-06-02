"use client";

// Drag-to-reorder rating table for the build flow.
// The displayed order IS the saved ratings — on submit we serialize the
// current row order into a hidden `order` field, and saveRatings on the
// server walks the list assigning rating = (N - index) * 10 so #1 has
// the highest numeric rating and the gap-of-10 leaves room for future
// manual nudges without renumbering everyone.
//
// Drag uses pointer events (not HTML5 DnD) so it works equally well on
// touch + desktop. Each row registers a ref; on pointermove the wrapper
// figures out which row the cursor is over by walking the ref array's
// bounding rects. CSS `touch-action: none` on rows prevents the browser
// from scrolling/zooming when admin drags on mobile.

import Link from "next/link";
import { useMemo, useRef, useState } from "react";

export interface RatingRow {
  discordId: string;
  displayName: string;
  playerId?: string;
  status: "NEW" | "RETURNING" | "GAP";
  skippedSeasons: number;
  prior?: {
    divisionName: string;
    tierName: string;
    rank: number;
    totalMembers: number;
    seasonName: string;
  };
  // Player.rating — comes from end-of-season recompute for returners,
  // null for brand-new signups. Used by the "Sort by league rating"
  // button and visible in the rating column.
  leagueRating: number | null;
  bmpMmr: number | null;
  bmpTier: string | null;
  bmpTotalGames: number | null;
  bmpWinRatePct: number | null;
  bmpFetchError: string | null;
}

const STATUS_PILL = {
  NEW: { bg: "rgba(241,196,15,0.2)", fg: "#f1c40f", label: "New" },
  RETURNING: { bg: "rgba(52,152,219,0.2)", fg: "#76c7ff", label: "Returning" },
  GAP: { bg: "rgba(241,196,15,0.2)", fg: "#f1c40f", label: "Gap" },
};

export function DraggableRatingTable({
  initial,
  formAction,
  roundId,
}: {
  initial: RatingRow[];
  formAction: (formData: FormData) => void | Promise<void>;
  roundId: string;
}) {
  const [rows, setRows] = useState<RatingRow[]>(initial);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const rowRefs = useRef<Array<HTMLTableRowElement | null>>([]);
  // Pixel offset between cursor and dragged row's top edge when the
  // drag started — used to keep the "lifted" row aligned with the
  // pointer instead of jumping to wherever the rect's top is.
  const dragOffsetY = useRef(0);
  // Touch-friendly: we set this on the row's pointerdown handler to
  // distinguish "drag started" from "scrolling page". Without it, on
  // mobile a vertical scroll gesture starting in a row would trigger
  // a drag. We only enter drag mode after a small downward movement
  // distinct from a horizontal swipe.
  const pendingDragIdx = useRef<number | null>(null);
  const pendingStart = useRef<{ x: number; y: number } | null>(null);

  const onRowPointerDown = (e: React.PointerEvent<HTMLTableRowElement>, idx: number) => {
    // Only react to primary button / touch / pen tip. Right-click etc.
    // shouldn't kick off a drag.
    if (e.pointerType === "mouse" && e.button !== 0) return;
    pendingDragIdx.current = idx;
    pendingStart.current = { x: e.clientX, y: e.clientY };
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    dragOffsetY.current = e.clientY - rect.top;
  };

  const computeHoverIdx = (clientY: number): number | null => {
    for (let i = 0; i < rowRefs.current.length; i++) {
      const el = rowRefs.current[i];
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (clientY >= r.top && clientY <= r.bottom) return i;
      // Cursor past the last row → snap to last position.
      if (i === rowRefs.current.length - 1 && clientY > r.bottom) return i;
      // Cursor before the first row → snap to first.
      if (i === 0 && clientY < r.top) return 0;
    }
    return null;
  };

  const onTablePointerMove = (e: React.PointerEvent<HTMLTableElement>) => {
    if (dragIdx === null) {
      // Maybe still in "pending" state — promote to drag once movement
      // exceeds a small threshold so a tap doesn't accidentally drag.
      if (pendingDragIdx.current !== null && pendingStart.current) {
        const dx = e.clientX - pendingStart.current.x;
        const dy = e.clientY - pendingStart.current.y;
        if (Math.abs(dy) > 6 || Math.abs(dx) > 6) {
          setDragIdx(pendingDragIdx.current);
          setHoverIdx(pendingDragIdx.current);
        }
      }
      return;
    }
    const idx = computeHoverIdx(e.clientY);
    if (idx !== null && idx !== hoverIdx) setHoverIdx(idx);
    // Prevent scrolling while actively dragging on touch.
    if (e.pointerType === "touch") e.preventDefault();
  };

  const finishDrag = () => {
    if (dragIdx !== null && hoverIdx !== null && hoverIdx !== dragIdx) {
      const next = [...rows];
      const [moved] = next.splice(dragIdx, 1);
      next.splice(hoverIdx, 0, moved!);
      setRows(next);
    }
    setDragIdx(null);
    setHoverIdx(null);
    pendingDragIdx.current = null;
    pendingStart.current = null;
  };

  const onTablePointerUp = () => { finishDrag(); };
  const onTablePointerCancel = () => { finishDrag(); };

  const order = useMemo(() => JSON.stringify(rows.map((r) => r.discordId)), [rows]);

  // Sort presets. Each one replaces the local order — the user's manual
  // drag is discarded (drag state isn't persisted until Save, so there's
  // nothing to warn about beyond "the visible order changes").
  // Rating = rank (1 = best), so league rating sorts ASC. BMP MMR
  // still sorts DESC (higher MMR = stronger).
  const sortSmart = () => {
    setRows([...rows].sort((a, b) => {
      // Ranked players first (asc by rank), unranked at bottom by MMR desc.
      if (a.leagueRating != null && b.leagueRating == null) return -1;
      if (a.leagueRating == null && b.leagueRating != null) return 1;
      if (a.leagueRating != null && b.leagueRating != null) {
        if (a.leagueRating !== b.leagueRating) return a.leagueRating - b.leagueRating;
      }
      return (b.bmpMmr ?? -1) - (a.bmpMmr ?? -1);
    }));
  };
  const sortByLeagueRating = () => {
    setRows([...rows].sort((a, b) => {
      // Rank ASC. Unranked sort to the bottom.
      if (a.leagueRating != null && b.leagueRating == null) return -1;
      if (a.leagueRating == null && b.leagueRating != null) return 1;
      if (a.leagueRating != null && b.leagueRating != null) {
        if (a.leagueRating !== b.leagueRating) return a.leagueRating - b.leagueRating;
      }
      return (b.bmpMmr ?? -1) - (a.bmpMmr ?? -1);
    }));
  };

  if (rows.length === 0) {
    return <p className="muted">No signups in this round.</p>;
  }

  return (
    <form action={formAction}>
      <input type="hidden" name="roundId" value={roundId} />
      <input type="hidden" name="order" value={order} />
      <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
        Drag rows to reorder. Save locks in the rank — position #1 becomes rank 1 (best player),
        position #N becomes rank N (weakest). Returners show their saved rank from end-of-last-season;
        new players show BMP Ranked MMR. A ⚠ next to a rank means the player has both a rank and an MMR
        — sometimes worth manually verifying before locking in.
      </p>
      <div style={{ display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
        <span className="muted" style={{ fontSize: 11, alignSelf: "center" }}>Sort:</span>
        <button type="button" className="secondary" style={{ fontSize: 11, padding: "2px 8px" }} onClick={sortSmart}>
          Smart (returners by league rating, then BMP MMR)
        </button>
        <button type="button" className="secondary" style={{ fontSize: 11, padding: "2px 8px" }} onClick={sortByLeagueRating}>
          League rating only
        </button>
        <span className="muted" style={{ fontSize: 11, alignSelf: "center" }}>
          (sort overrides manual drag — Save preserves it)
        </span>
      </div>
      <table
        style={{ width: "100%" }}
        onPointerMove={onTablePointerMove}
        onPointerUp={onTablePointerUp}
        onPointerCancel={onTablePointerCancel}
        onPointerLeave={onTablePointerUp}
      >
        <thead>
          <tr>
            <th style={{ width: 36 }}></th>
            <th style={{ width: 30 }}>#</th>
            <th>Player</th>
            <th>Status</th>
            <th>Last season</th>
            <th title="Saved rank from end-of-season (1 = best)">League rank</th>
            <th>BMP Ranked MMR</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const pill = STATUS_PILL[r.status];
            const isDragged = dragIdx === i;
            const isHovered = hoverIdx === i && dragIdx !== null && dragIdx !== i;
            return (
              <tr
                key={r.discordId}
                ref={(el) => { rowRefs.current[i] = el; }}
                onPointerDown={(e) => onRowPointerDown(e, i)}
                style={{
                  cursor: isDragged ? "grabbing" : "grab",
                  opacity: isDragged ? 0.4 : 1,
                  // Solid colored top border on the drop target so admin
                  // sees exactly where the row will land. The transparent
                  // sibling keeps the row height stable across renders.
                  borderTop: isHovered ? "2px solid #76c7ff" : "2px solid transparent",
                  background: isDragged ? "rgba(118, 199, 255, 0.05)" : undefined,
                  // touch-action:none prevents the browser from scrolling
                  // when admin starts a drag on mobile/touch — without it
                  // a vertical swipe would scroll the page instead.
                  touchAction: "none",
                  userSelect: "none",
                }}
              >
                <td style={{ color: "#888", textAlign: "center" }} title="Drag to reorder">⋮⋮</td>
                <td style={{ fontVariantNumeric: "tabular-nums", color: "#888" }}>{i + 1}</td>
                <td>
                  {r.playerId ? (
                    <Link href={`/profile/${r.playerId}`} style={{ color: "var(--text)" }}>
                      <strong>{r.displayName}</strong>
                    </Link>
                  ) : (
                    <strong>{r.displayName}</strong>
                  )}{" "}
                  <span className="muted" style={{ fontSize: 11 }}>{r.discordId}</span>
                </td>
                <td>
                  <span
                    className="pill"
                    style={{ background: pill.bg, color: pill.fg }}
                    title={r.status === "GAP" ? `Skipped ${r.skippedSeasons} season(s)` : undefined}
                  >
                    {pill.label}
                    {r.status === "GAP" && ` · ${r.skippedSeasons}`}
                  </span>
                </td>
                <td style={{ fontSize: 12 }}>
                  {r.prior ? (
                    <span>
                      <strong>{r.prior.divisionName}</strong>{" "}
                      <span className="muted">#{r.prior.rank}/{r.prior.totalMembers}</span>
                      <br />
                      <span className="muted" style={{ fontSize: 11 }}>{r.prior.seasonName}</span>
                    </span>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td style={{ fontSize: 12 }}>
                  {r.leagueRating != null ? (
                    <span>
                      <strong>#{r.leagueRating}</strong>
                      {r.bmpMmr != null && (
                        <span
                          className="muted"
                          style={{ marginLeft: 6, fontSize: 11, color: "#f1c40f" }}
                          title="Has both a league rank AND BMP MMR — verify whether the rank still reflects current skill."
                        >
                          ⚠
                        </span>
                      )}
                    </span>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td style={{ fontSize: 12 }}>
                  {r.bmpMmr != null ? (
                    <span>
                      <strong>{r.bmpMmr}</strong>
                      {r.bmpTier && (
                        <span className="muted" style={{ marginLeft: 6 }}>
                          ({r.bmpTier}{r.bmpTotalGames ? ` · ${r.bmpTotalGames}g` : ""}{r.bmpWinRatePct != null ? ` · ${r.bmpWinRatePct}%` : ""})
                        </span>
                      )}
                    </span>
                  ) : r.bmpFetchError ? (
                    <span className="muted" title={r.bmpFetchError}>
                      {r.bmpFetchError.length > 30 ? `${r.bmpFetchError.slice(0, 27)}…` : r.bmpFetchError}
                    </span>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <button type="submit" style={{ marginTop: 12 }}>Save &amp; lock order</button>
    </form>
  );
}
