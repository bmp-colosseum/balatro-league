// Player-vs-player scoring matrix. Each cell = games the row player
// won against the column player. Diagonal is blank (no self-matches).
// Right column = row total. Designed for compact display of a full
// round-robin — column headers rotate diagonally so the table stays
// narrow even with 8+ players.

import Link from "next/link";
import type { Crosstable as CrosstableData } from "@/lib/loaders/division";

export function Crosstable({ data }: { data: CrosstableData }) {
  if (data.players.length === 0) {
    return <p className="muted">No players yet.</p>;
  }
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
            {data.players.map((p) => (
              <th
                key={p.id}
                style={{
                  background: "rgba(149,165,166,0.15)",
                  border: "1px dotted var(--border)",
                  height: 110,
                  padding: 0,
                  position: "relative",
                  width: 32,
                  minWidth: 32,
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
          {data.rows.map((row) => (
            <tr key={row.player.id}>
              <td
                style={{
                  background: "rgba(149,165,166,0.08)",
                  padding: "4px 8px",
                  border: "1px dotted var(--border)",
                  fontWeight: 500,
                  whiteSpace: "nowrap",
                }}
              >
                <Link href={`/profile/${row.player.id}`} style={{ color: "var(--text)" }}>
                  {row.player.displayName}
                </Link>
              </td>
              {row.cells.map((cell, i) => {
                if (cell === null) {
                  return (
                    <td
                      key={i}
                      style={{
                        background: "rgba(80,80,80,0.18)",
                        border: "1px dotted var(--border)",
                        textAlign: "center",
                        width: 32,
                      }}
                    >
                      ·
                    </td>
                  );
                }
                const hasResult = cell.gamesWon !== null;
                return (
                  <td
                    key={i}
                    style={{
                      background: hasResult ? "rgba(46,204,113,0.12)" : undefined,
                      border: "1px dotted var(--border)",
                      textAlign: "center",
                      padding: "4px 6px",
                      width: 32,
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {hasResult ? cell.gamesWon : ""}
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
                {row.totalGamesWon}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
