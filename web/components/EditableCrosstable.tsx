"use client";

// Admin editable scoring matrix. Same shape as the public Crosstable
// but each non-diagonal cell is a number input. Editing a cell fires
// setCrosstableCell which upserts the Pairing and auto-mirrors the
// other side (BO2 convention: row + mirror = 2).
//
// Optimistic UI: the typed cell + its mirror update locally as the
// user tabs out, then the server action persists. On error we revert.

import Link from "next/link";
import { useState, useTransition } from "react";
import { clearCrosstableCell, setCrosstableCell } from "@/app/admin/divisions/[id]/actions";

export interface EditableCrosstableData {
  divisionId: string;
  players: Array<{ id: string; displayName: string }>;
  // 2D matrix: rows[i][j] = games player i won against player j (null = diagonal,
  // -1 = no pairing recorded yet). Mirrors public Crosstable shape but
  // uses sentinel values for the empty/diagonal cases so the editable
  // input can distinguish "empty" from "explicitly zero."
  cells: Array<Array<number | null>>;
}

interface CellState {
  value: string; // raw input — "" means unplayed
  saving: boolean;
  error: boolean;
}

export function EditableCrosstable({ initial }: { initial: EditableCrosstableData }) {
  // Local state mirrors `initial.cells` but as strings so the input
  // can render "" for unplayed. -1 (sentinel from loader) → "".
  const [cells, setCells] = useState<CellState[][]>(() =>
    initial.cells.map((row) =>
      row.map((v) => ({
        value: v === null || v === -1 ? "" : String(v),
        saving: false,
        error: false,
      })),
    ),
  );
  const [, startTransition] = useTransition();

  if (initial.players.length === 0) {
    return <p className="muted">No players yet.</p>;
  }

  // Commit a cell value to the server. rowIdx = row player, colIdx = col player.
  const commitCell = (rowIdx: number, colIdx: number, rawValue: string) => {
    const trimmed = rawValue.trim();
    // Empty input: clear the pairing.
    if (trimmed === "") {
      const fd = new FormData();
      fd.append("divisionId", initial.divisionId);
      fd.append("rowPlayerId", initial.players[rowIdx]!.id);
      fd.append("colPlayerId", initial.players[colIdx]!.id);
      // Optimistic clear (both sides).
      setCells((prev) => updateCell(prev, rowIdx, colIdx, "", true, false, true));
      startTransition(async () => {
        try {
          await clearCrosstableCell(fd);
          setCells((prev) => updateCell(prev, rowIdx, colIdx, "", false, false, true));
        } catch {
          setCells((prev) => updateCell(prev, rowIdx, colIdx, "", false, true, true));
        }
      });
      return;
    }
    const n = parseInt(trimmed, 10);
    if (!Number.isFinite(n) || n < 0 || n > 2) {
      // Invalid input — flag with error, don't submit.
      setCells((prev) => updateCell(prev, rowIdx, colIdx, trimmed, false, true, false));
      return;
    }
    // Optimistic: set both this cell + mirror immediately.
    const mirror = 2 - n;
    setCells((prev) => {
      const next = updateCell(prev, rowIdx, colIdx, String(n), true, false, false);
      return updateCell(next, colIdx, rowIdx, String(mirror), true, false, false);
    });
    const fd = new FormData();
    fd.append("divisionId", initial.divisionId);
    fd.append("rowPlayerId", initial.players[rowIdx]!.id);
    fd.append("colPlayerId", initial.players[colIdx]!.id);
    fd.append("gamesWon", String(n));
    startTransition(async () => {
      try {
        await setCrosstableCell(fd);
        setCells((prev) => {
          const next = updateCell(prev, rowIdx, colIdx, String(n), false, false, false);
          return updateCell(next, colIdx, rowIdx, String(mirror), false, false, false);
        });
      } catch {
        setCells((prev) => {
          const next = updateCell(prev, rowIdx, colIdx, String(n), false, true, false);
          return updateCell(next, colIdx, rowIdx, String(mirror), false, true, false);
        });
      }
    });
  };

  // Compute row totals from current local state.
  const rowTotals = cells.map((row) =>
    row.reduce((sum, c) => {
      if (c.value === "") return sum;
      const n = parseInt(c.value, 10);
      return Number.isFinite(n) ? sum + n : sum;
    }, 0),
  );

  return (
    <div style={{ overflowX: "auto" }}>
      <table
        style={{
          borderCollapse: "collapse",
          fontSize: 12,
          marginTop: 8,
          border: "2px solid var(--border)",
        }}
      >
        <thead>
          <tr>
            <th
              style={{
                background: "rgba(149,165,166,0.15)",
                padding: "6px 8px",
                border: "1px dotted var(--border)",
                textAlign: "left",
                fontWeight: 600,
                minWidth: 140,
              }}
            >
              Players
            </th>
            {initial.players.map((p) => (
              <th
                key={p.id}
                style={{
                  background: "rgba(149,165,166,0.15)",
                  border: "1px dotted var(--border)",
                  height: 110,
                  padding: 0,
                  position: "relative",
                  width: 36,
                  minWidth: 36,
                }}
              >
                <div
                  style={{
                    transform: "translate(-50%, -50%) rotate(-45deg)",
                    transformOrigin: "center center",
                    position: "absolute",
                    bottom: 6,
                    left: "50%",
                    whiteSpace: "nowrap",
                    fontSize: 11,
                    fontWeight: 500,
                  }}
                >
                  <Link href={`/profile/${p.id}`} style={{ color: "var(--text)" }}>
                    {p.displayName}
                  </Link>
                </div>
              </th>
            ))}
            <th
              style={{
                background: "rgba(149,165,166,0.25)",
                padding: "6px 10px",
                border: "1px dotted var(--border)",
                fontWeight: 600,
              }}
            >
              Points
            </th>
          </tr>
        </thead>
        <tbody>
          {initial.players.map((rowPlayer, rowIdx) => (
            <tr key={rowPlayer.id}>
              <td
                style={{
                  background: "rgba(149,165,166,0.08)",
                  padding: "4px 8px",
                  border: "1px dotted var(--border)",
                  fontWeight: 500,
                  whiteSpace: "nowrap",
                }}
              >
                <Link href={`/profile/${rowPlayer.id}`} style={{ color: "var(--text)" }}>
                  {rowPlayer.displayName}
                </Link>
              </td>
              {initial.players.map((_, colIdx) => {
                if (colIdx === rowIdx) {
                  return (
                    <td
                      key={colIdx}
                      style={{
                        background: "rgba(80,80,80,0.18)",
                        border: "1px dotted var(--border)",
                        textAlign: "center",
                        width: 36,
                      }}
                    >
                      ·
                    </td>
                  );
                }
                const cell = cells[rowIdx]![colIdx]!;
                const hasValue = cell.value !== "";
                return (
                  <td
                    key={colIdx}
                    style={{
                      background: cell.error
                        ? "rgba(231,76,60,0.15)"
                        : cell.saving
                          ? "rgba(118,199,255,0.10)"
                          : hasValue
                            ? "rgba(46,204,113,0.12)"
                            : undefined,
                      border: "1px dotted var(--border)",
                      padding: 0,
                      width: 36,
                    }}
                    title={`${rowPlayer.displayName} vs ${initial.players[colIdx]!.displayName} — type 0/1/2 or blank`}
                  >
                    <input
                      type="text"
                      inputMode="numeric"
                      pattern="[0-2]"
                      maxLength={1}
                      value={cell.value}
                      onChange={(e) => {
                        // Local typing — defer commit until blur/Enter so admin
                        // can clear-then-type without an intermediate save.
                        const v = e.target.value;
                        setCells((prev) => updateCell(prev, rowIdx, colIdx, v, false, false, false));
                      }}
                      onBlur={(e) => commitCell(rowIdx, colIdx, e.currentTarget.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.currentTarget.blur();
                        }
                      }}
                      style={{
                        width: "100%",
                        height: 28,
                        border: "none",
                        background: "transparent",
                        textAlign: "center",
                        fontSize: 13,
                        fontVariantNumeric: "tabular-nums",
                        color: "var(--text)",
                        padding: 0,
                      }}
                    />
                  </td>
                );
              })}
              <td
                style={{
                  background: "rgba(149,165,166,0.25)",
                  border: "1px dotted var(--border)",
                  textAlign: "center",
                  padding: "4px 10px",
                  fontWeight: 600,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {rowTotals[rowIdx]}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted" style={{ fontSize: 11, marginTop: 6 }}>
        Type 0, 1, or 2 — Enter or Tab to save. Empty cell = unplayed. Other player's mirror cell auto-fills (BO2 convention: cell + mirror = 2).
      </p>
    </div>
  );
}

// Immutable cell-state updater for the 2D array.
function updateCell(
  prev: CellState[][],
  row: number,
  col: number,
  value: string,
  saving: boolean,
  error: boolean,
  // When true, also overwrite the cell-state's `saving` and `error`
  // even if the value didn't change (used by clear path so we don't
  // skip the in-flight indicator).
  _force: boolean,
): CellState[][] {
  void _force;
  return prev.map((r, ri) =>
    ri === row
      ? r.map((c, ci) => (ci === col ? { value, saving, error } : c))
      : r,
  );
}
